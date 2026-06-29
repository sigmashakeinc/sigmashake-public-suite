// test/routes.test.ts — Hono route integration tests for /healthz,
// /api/v1/vcs/whoami, /ws/streamer (HMAC handshake), and the cookie-authed
// viewer endpoints. The Durable Object is stubbed so we can assert what
// gets sent to /dispatch without standing up the real DO runtime.

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { VcsSession } from "../src/lib/session";

// vcs-room.ts imports `DurableObject` from the Workers-only virtual module
// `cloudflare:workers`. Stub it BEFORE the static imports of `app` so the
// routes.test.ts module chain resolves under Bun's test runtime. The routes
// themselves never instantiate the DO — they only call `room.fetch(...)`,
// which we replace via a FakeDORoom further down.
mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

// Dynamic import — runs AFTER the mock.module call above (static imports are
// statically hoisted, so a normal `import` of '../src/index' would resolve
// `cloudflare:workers` before the mock registers).
const { default: app } = await import("../src/index");
const bridgeModulePath = "../integrations/bridge/vcs-bridge.js";
const { getBridgeConfig, routeRpc } = (await import(bridgeModulePath)) as {
  getBridgeConfig: (env?: Record<string, string | undefined>) => Record<string, unknown>;
  routeRpc: (
    rpc: { method: "GET" | "POST"; path: string; body?: Record<string, unknown> },
    options?: Record<string, unknown>,
  ) => Promise<{ status: number; body: string }>;
};

// ── Test helpers ──────────────────────────────────────────────────────────────

interface DispatchPayload {
  method: "GET" | "POST";
  path: string;
  body: Record<string, unknown>;
}

class FakeDORoom {
  /** Last /dispatch payload — populated whenever the worker calls into the DO. */
  lastDispatch: DispatchPayload | null = null;
  /** Set this to override the bridge's response body for the next /dispatch call. */
  nextResponse: { status: number; body: unknown } = {
    status: 200,
    body: { ok: true, loadout: { body: "normal" } },
  };

  reset(): void {
    this.lastDispatch = null;
    this.nextResponse = { status: 200, body: { ok: true, loadout: { body: "normal" } } };
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/dispatch") {
      this.lastDispatch = (await req.json()) as DispatchPayload;
      return new Response(JSON.stringify(this.nextResponse.body), {
        status: this.nextResponse.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/status") {
      return new Response(JSON.stringify({ bridge_connected: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/ws/bridge") {
      // Pretend we accepted the WS — real DO would return a 101.
      return new Response(null, { status: 101 });
    }
    return new Response("not found", { status: 404 });
  }
}

const fakeRoom = new FakeDORoom();
const fakeRoomNamespace = {
  get: () => fakeRoom,
  idFromName: (name: string) => name,
  idFromString: (id: string) => id,
  newUniqueId: () => "unique-id",
} as unknown as DurableObjectNamespace;

class FakeKv {
  store = new Map<string, VcsSession>();
  reset() {
    this.store.clear();
  }
  seed(sessionId: string, session: VcsSession) {
    this.store.set(`session:${sessionId}`, session);
  }
  async get<T = unknown>(key: string, _typeOrOpts?: unknown): Promise<T | null> {
    return (this.store.get(key) ?? null) as T | null;
  }
}

interface VcsBindings {
  VCS_ROOM: DurableObjectNamespace;
  SESSIONS: KVNamespace;
  VCS_HMAC_KEY?: { get(): Promise<string> };
  TWITCH_BROADCASTER_ID: string;
  ENCRYPTION_KEY?: { get(): Promise<string> };
}

const fakeKv = new FakeKv();
const HMAC_KEY = "streamer-bridge-key-v1";

function bindings(opts: Partial<VcsBindings> = {}): VcsBindings {
  return {
    VCS_ROOM: fakeRoomNamespace,
    SESSIONS: fakeKv as unknown as KVNamespace,
    VCS_HMAC_KEY: {
      async get() {
        return HMAC_KEY;
      },
    },
    TWITCH_BROADCASTER_ID: "test-broadcaster",
    ...opts,
  };
}

function bridgeConfig(overrides: Record<string, unknown> = {}) {
  return {
    ...getBridgeConfig({}),
    chatElixirBase: "http://chat.local",
    mmoBaseUrl: "http://mmo.local",
    vcsBaseUrl: "http://vcs.local",
    vcsHmacKey: "bridge-key",
    fetchTimeoutMs: 50,
    reconnectDelayMs: 10,
    brainsEnabled: false,
    brainsRateLimitMs: 5_000,
    brainsTimeoutMs: 50,
    cerebrasApiKey: "",
    cerebrasBaseUrl: "https://api.cerebras.ai",
    cerebrasModel: "gemma-4-31b",
    ...overrides,
  };
}

const TWITCH_SESSION: VcsSession = {
  userId: "twitch:99887766",
  login: "alice",
  avatar: "",
  authType: "twitch",
  twitchLogin: "alice",
};

const KICK_SESSION: VcsSession = {
  userId: "kick:5551212",
  login: "bobstream",
  avatar: "",
  authType: "kick",
};

async function hmacHex(body: string, key: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

beforeEach(() => {
  fakeRoom.reset();
  fakeKv.reset();
});

// ── /healthz ──────────────────────────────────────────────────────────────────

describe("GET /healthz", () => {
  test("returns 200 with ok=true", async () => {
    const res = await app.request("/healthz", {}, bindings());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; service: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe("sigmashake-vcs");
  });
});

// ── CORS ──────────────────────────────────────────────────────────────────────

describe("CORS", () => {
  test("OPTIONS request returns 204 with no body", async () => {
    const res = await app.request("/anything", { method: "OPTIONS" }, bindings());
    expect(res.status).toBe(204);
  });

  test("Allow-Origin echoed for the production vcs subdomain", async () => {
    const res = await app.request(
      "/healthz",
      { headers: { Origin: "https://vcs.sigmashake.com" } },
      bindings(),
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("https://vcs.sigmashake.com");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  test("Allow-Origin echoed for wrangler dev localhost", async () => {
    const res = await app.request(
      "/healthz",
      { headers: { Origin: "http://localhost:8787" } },
      bindings(),
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:8787");
  });

  test("Allow-Origin NOT echoed for an arbitrary origin", async () => {
    const res = await app.request(
      "/healthz",
      { headers: { Origin: "https://evil.example.com" } },
      bindings(),
    );
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

// ── /api/v1/vcs/whoami (auth probe — never touches the bridge) ────────────────

describe("GET /api/v1/vcs/whoami", () => {
  test('returns 401 with "unauthenticated" when no session cookie is sent', async () => {
    const res = await app.request("/api/v1/vcs/whoami", {}, bindings());
    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.error).toBe("unauthenticated");
  });

  test("returns 401 when the cookie is set but no session exists in KV", async () => {
    const res = await app.request(
      "/api/v1/vcs/whoami",
      { headers: { Cookie: "session_id=unknown" } },
      bindings(),
    );
    expect(res.status).toBe(401);
  });

  test("returns 200 with viewer identity when the session is valid", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);
    const res = await app.request(
      "/api/v1/vcs/whoami",
      { headers: { Cookie: "session_id=sess-1" } },
      bindings(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      source: string;
      login: string;
      user_id: string;
      display: string;
      twitch_login: string;
      twitch_user_id: string;
    };
    expect(body.ok).toBe(true);
    // Generic envelope.
    expect(body.source).toBe("twitch");
    expect(body.login).toBe("alice");
    expect(body.user_id).toBe("99887766");
    expect(body.display).toBe("alice");
    // Back-compat mirror still present for un-updated panel reads.
    expect(body.twitch_login).toBe("alice");
    expect(body.twitch_user_id).toBe("99887766");
  });

  test("whoami does NOT call into the DO (bridge offline must not affect identity check)", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);
    await app.request(
      "/api/v1/vcs/whoami",
      { headers: { Cookie: "session_id=sess-1" } },
      bindings(),
    );
    expect(fakeRoom.lastDispatch).toBeNull();
  });

  test("returns 200 with a kick identity envelope for a kick session", async () => {
    fakeKv.seed("sess-kick", KICK_SESSION);
    const res = await app.request(
      "/api/v1/vcs/whoami",
      { headers: { Cookie: "session_id=sess-kick" } },
      bindings(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string; login: string; user_id: string };
    expect(body.source).toBe("kick");
    expect(body.login).toBe("bobstream");
    expect(body.user_id).toBe("5551212");
  });
});

// ── /api/v1/vcs/me + mutations (cookie-authed, dispatch to bridge) ────────────

describe("GET /api/v1/vcs/me", () => {
  test("returns 401 without a session cookie", async () => {
    const res = await app.request("/api/v1/vcs/me", {}, bindings());
    expect(res.status).toBe(401);
    expect(fakeRoom.lastDispatch).toBeNull();
  });

  test("dispatches GET /me to the bridge with viewer fields when authenticated", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);
    fakeRoom.nextResponse = { status: 200, body: { ok: true, loadout: { body: "normal" } } };

    const res = await app.request(
      "/api/v1/vcs/me",
      { headers: { Cookie: "session_id=sess-1" } },
      bindings(),
    );

    expect(res.status).toBe(200);
    expect(fakeRoom.lastDispatch).toEqual({
      method: "GET",
      path: "/api/v1/vcs/me",
      body: {
        source: "twitch",
        login: "alice",
        user_id: "99887766",
        display: "alice",
        twitch_user_id: "99887766",
        twitch_login: "alice",
        twitch_display: "alice",
      },
    });
  });

  test("passes the bridge response status through unchanged", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);
    fakeRoom.nextResponse = { status: 503, body: { ok: false, error: "bridge_offline" } };

    const res = await app.request(
      "/api/v1/vcs/me",
      { headers: { Cookie: "session_id=sess-1" } },
      bindings(),
    );

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bridge_offline");
  });

  test("dispatches a kick session with source:kick and the back-compat mirror", async () => {
    fakeKv.seed("sess-kick", KICK_SESSION);

    await app.request(
      "/api/v1/vcs/me",
      { headers: { Cookie: "session_id=sess-kick" } },
      bindings(),
    );

    expect(fakeRoom.lastDispatch).toEqual({
      method: "GET",
      path: "/api/v1/vcs/me",
      body: {
        source: "kick",
        login: "bobstream",
        user_id: "5551212",
        display: "bobstream",
        // Back-compat mirror set to the same values so an un-updated controller
        // keeps working for kick users mid-rollout.
        twitch_user_id: "5551212",
        twitch_login: "bobstream",
        twitch_display: "bobstream",
      },
    });
  });
});

describe("POST /api/v1/vcs/brains/tick", () => {
  test("returns 401 without a session cookie", async () => {
    const res = await app.request(
      "/api/v1/vcs/brains/tick",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scene: "studio" }),
      },
      bindings(),
    );
    expect(res.status).toBe(401);
    expect(fakeRoom.lastDispatch).toBeNull();
  });

  test("dispatches canonical identity only and clamps optional body fields", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);

    const oversizedScene = `  ${"s".repeat(140)}  `;
    const oversizedStimulus = ` ${"t".repeat(600)} `;
    const oversizedMood = `${"m".repeat(80)} `;
    const oversizedNearby = `${"n".repeat(90)} `;
    const oversizedImage = ` data:image/png;base64,${"a".repeat(17_000)} `;

    const res = await app.request(
      "/api/v1/vcs/brains/tick",
      {
        method: "POST",
        headers: {
          Cookie: "session_id=sess-1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          source: "kick",
          login: "mallory",
          user_id: "bad",
          display: "mallory",
          twitch_user_id: "bad",
          twitch_login: "mallory",
          twitch_display: "mallory",
          scene: oversizedScene,
          stimulus: oversizedStimulus,
          mood: oversizedMood,
          nearby: ["  ally  ", "", oversizedNearby, 42, "friend", "mob", "loot", "door", "extra"],
          image_data_url: oversizedImage,
          unknown_field: "blocked",
        }),
      },
      bindings(),
    );

    expect(res.status).toBe(200);
    expect(fakeRoom.lastDispatch).toEqual({
      method: "POST",
      path: "/api/v1/vcs/brains/tick",
      body: {
        source: "twitch",
        login: "alice",
        user_id: "99887766",
        display: "alice",
        twitch_user_id: "99887766",
        twitch_login: "alice",
        twitch_display: "alice",
        scene: "s".repeat(96),
        stimulus: "t".repeat(512),
        mood: "m".repeat(64),
        nearby: ["ally", "n".repeat(64), "friend", "mob", "loot", "door"],
        image_data_url: `data:image/png;base64,${"a".repeat(16_362)}`,
      },
    });
  });
});

describe("bridge brains harness", () => {
  const brainsRpc = {
    method: "POST" as const,
    path: "/api/v1/vcs/brains/tick",
    body: {
      source: "twitch",
      login: "alice",
      user_id: "123",
      display: "alice",
      scene: "studio",
      stimulus: "chat asked about the latest build",
    },
  };

  test("returns unavailable without falling through to chat when brains are disabled", async () => {
    let fetchCalls = 0;
    const reply = await routeRpc(brainsRpc, {
      config: bridgeConfig(),
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("brains-disabled path should not fetch");
      },
      rateLimitStore: new Map<string, number>(),
    });

    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({
      ok: true,
      unavailable: true,
      reason: "brains_disabled",
    });
    expect(fetchCalls).toBe(0);
  });

  test("returns unavailable without falling through to chat when the Cerebras key is missing", async () => {
    let fetchCalls = 0;
    const reply = await routeRpc(brainsRpc, {
      config: bridgeConfig({ brainsEnabled: true }),
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("missing-key path should not fetch");
      },
      rateLimitStore: new Map<string, number>(),
    });

    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({
      ok: true,
      unavailable: true,
      reason: "brains_unconfigured",
    });
    expect(fetchCalls).toBe(0);
  });

  test("uses the Cerebras branch and rate-limits repeated viewer ticks", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"ok":true,"thought":"watching chat"}' } }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };
    const rateLimitStore = new Map<string, number>();
    const config = bridgeConfig({ brainsEnabled: true, cerebrasApiKey: "secret-key" });

    const first = await routeRpc(brainsRpc, {
      config,
      fetchImpl,
      rateLimitStore,
      now: () => 10_000,
    });
    const second = await routeRpc(brainsRpc, {
      config,
      fetchImpl,
      rateLimitStore,
      now: () => 10_100,
    });

    expect(first.status).toBe(200);
    expect(JSON.parse(first.body)).toEqual({ ok: true, thought: "watching chat" });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe("https://api.cerebras.ai/v1/chat/completions");
    expect((fetchCalls[0]?.init?.headers as Record<string, string>).authorization).toBe(
      "Bearer secret-key",
    );
    expect(second.status).toBe(429);
    expect(JSON.parse(second.body)).toEqual({ ok: false, error: "brain_rate_limited" });
  });
});

describe("GET /api/v1/vcs/catalog (public, no auth)", () => {
  test("dispatches without requiring a session cookie", async () => {
    const res = await app.request("/api/v1/vcs/catalog", {}, bindings());
    expect(res.status).toBe(200);
    expect(fakeRoom.lastDispatch).toEqual({
      method: "GET",
      path: "/api/v1/vcs/catalog",
      body: {},
    });
  });
});

describe("POST /api/v1/vcs/equip", () => {
  test("returns 401 without a cookie", async () => {
    const res = await app.request(
      "/api/v1/vcs/equip",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slot: "head", item_key: "crown" }),
      },
      bindings(),
    );
    expect(res.status).toBe(401);
    expect(fakeRoom.lastDispatch).toBeNull();
  });

  test("dispatches POST /equip with slot + item_key + viewer fields", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);

    await app.request(
      "/api/v1/vcs/equip",
      {
        method: "POST",
        headers: { Cookie: "session_id=sess-1", "Content-Type": "application/json" },
        body: JSON.stringify({ slot: "head", item_key: "crown" }),
      },
      bindings(),
    );

    expect(fakeRoom.lastDispatch).toEqual({
      method: "POST",
      path: "/api/v1/vcs/equip",
      body: {
        source: "twitch",
        login: "alice",
        user_id: "99887766",
        display: "alice",
        twitch_user_id: "99887766",
        twitch_login: "alice",
        twitch_display: "alice",
        slot: "head",
        item_key: "crown",
      },
    });
  });

  test("coerces non-string slot/item_key to empty string (no NaN/undefined leak)", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);

    await app.request(
      "/api/v1/vcs/equip",
      {
        method: "POST",
        headers: { Cookie: "session_id=sess-1", "Content-Type": "application/json" },
        body: JSON.stringify({ slot: 42, item_key: null }),
      },
      bindings(),
    );

    expect(fakeRoom.lastDispatch?.body).toMatchObject({ slot: "", item_key: "" });
  });

  test("handles malformed JSON body gracefully (treats as empty object)", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);

    await app.request(
      "/api/v1/vcs/equip",
      {
        method: "POST",
        headers: { Cookie: "session_id=sess-1", "Content-Type": "application/json" },
        body: "not-json-{{",
      },
      bindings(),
    );

    expect(fakeRoom.lastDispatch?.body).toMatchObject({ slot: "", item_key: "" });
  });
});

describe("POST /api/v1/vcs/clear_body", () => {
  test("dispatches with only viewer fields (no body params)", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);

    await app.request(
      "/api/v1/vcs/clear_body",
      {
        method: "POST",
        headers: { Cookie: "session_id=sess-1" },
      },
      bindings(),
    );

    expect(fakeRoom.lastDispatch).toEqual({
      method: "POST",
      path: "/api/v1/vcs/clear_body",
      body: {
        source: "twitch",
        login: "alice",
        user_id: "99887766",
        display: "alice",
        twitch_user_id: "99887766",
        twitch_login: "alice",
        twitch_display: "alice",
      },
    });
  });
});

describe("POST /api/v1/vcs/hue", () => {
  test("passes hue through verbatim (string or other) without re-coercing to empty", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);

    await app.request(
      "/api/v1/vcs/hue",
      {
        method: "POST",
        headers: { Cookie: "session_id=sess-1", "Content-Type": "application/json" },
        body: JSON.stringify({ hue: 200 }),
      },
      bindings(),
    );

    expect(fakeRoom.lastDispatch?.body.hue).toBe(200);
  });

  test("replaces missing hue with empty string", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);

    await app.request(
      "/api/v1/vcs/hue",
      {
        method: "POST",
        headers: { Cookie: "session_id=sess-1", "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      bindings(),
    );

    expect(fakeRoom.lastDispatch?.body.hue).toBe("");
  });
});

// ── /ws/streamer (HMAC handshake) ─────────────────────────────────────────────

describe("GET /ws/streamer", () => {
  test("returns 426 without the Upgrade: websocket header", async () => {
    const res = await app.request("/ws/streamer", {}, bindings());
    expect(res.status).toBe(426);
    expect(await res.text()).toBe("Expected websocket");
  });

  test("returns 503 not_configured when VCS_HMAC_KEY binding is missing", async () => {
    const res = await app.request(
      "/ws/streamer",
      {
        headers: { Upgrade: "websocket" },
      },
      bindings({ VCS_HMAC_KEY: undefined }),
    );
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("not_configured");
  });

  test("returns 401 when the timestamp header is missing", async () => {
    const res = await app.request(
      "/ws/streamer",
      {
        headers: { Upgrade: "websocket" },
      },
      bindings(),
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("timestamp_invalid");
  });

  test("returns 401 when the timestamp is more than 30s out of sync", async () => {
    const staleTs = Math.floor(Date.now() / 1000) - 120;
    const sig = await hmacHex(`timestamp:${staleTs}`, HMAC_KEY);
    const res = await app.request(
      "/ws/streamer",
      {
        headers: {
          Upgrade: "websocket",
          "X-Vcs-Timestamp": String(staleTs),
          "X-Vcs-Signature": sig,
        },
      },
      bindings(),
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("timestamp_invalid");
  });

  test('returns 401 with "invalid_signature" when HMAC is wrong', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const wrongSig = await hmacHex(`timestamp:${ts}`, "wrong-key");
    const res = await app.request(
      "/ws/streamer",
      {
        headers: {
          Upgrade: "websocket",
          "X-Vcs-Timestamp": String(ts),
          "X-Vcs-Signature": wrongSig,
        },
      },
      bindings(),
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("invalid_signature");
  });

  test("hands off to the DO on a valid handshake", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = await hmacHex(`timestamp:${ts}`, HMAC_KEY);
    const res = await app.request(
      "/ws/streamer",
      {
        headers: {
          Upgrade: "websocket",
          "X-Vcs-Timestamp": String(ts),
          "X-Vcs-Signature": sig,
        },
      },
      bindings(),
    );
    // FakeDORoom returns 101 for /ws/bridge; the worker passes it through.
    expect(res.status).toBe(101);
  });

  test('swallows DO upgrade errors with the literal "script has been upgraded" text', async () => {
    const upgradeError = {
      get: () => upgradeError,
      idFromName: () => "x",
      idFromString: () => "x",
      newUniqueId: () => "x",
      fetch: () =>
        Promise.reject(new Error("This script has been upgraded since the WebSocket was opened")),
    } as unknown as DurableObjectNamespace;

    const ts = Math.floor(Date.now() / 1000);
    const sig = await hmacHex(`timestamp:${ts}`, HMAC_KEY);
    const res = await app.request(
      "/ws/streamer",
      {
        headers: {
          Upgrade: "websocket",
          "X-Vcs-Timestamp": String(ts),
          "X-Vcs-Signature": sig,
        },
      },
      bindings({ VCS_ROOM: upgradeError }),
    );
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("bridge_unavailable");
  });

  test("swallows any DO error during WS upgrade — bridge reconnect loop handles retry", async () => {
    // Cloudflare's runtime sometimes throws a message-less Error variant on
    // post-deploy DO upgrade attempts; treat every error here as recoverable
    // so the tail consumer doesn't page on transient deploy-boundary noise.
    const otherError = {
      get: () => otherError,
      idFromName: () => "x",
      idFromString: () => "x",
      newUniqueId: () => "x",
      fetch: () => Promise.reject(new Error("something else broke")),
    } as unknown as DurableObjectNamespace;

    const ts = Math.floor(Date.now() / 1000);
    const sig = await hmacHex(`timestamp:${ts}`, HMAC_KEY);
    const res = await app.request(
      "/ws/streamer",
      {
        headers: {
          Upgrade: "websocket",
          "X-Vcs-Timestamp": String(ts),
          "X-Vcs-Signature": sig,
        },
      },
      bindings({ VCS_ROOM: otherError }),
    );
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("bridge_unavailable");
  });

  test("swallows DO errors with empty message (the 4:58 PM tail event variant)", async () => {
    const emptyMessageError = {
      get: () => emptyMessageError,
      idFromName: () => "x",
      idFromString: () => "x",
      newUniqueId: () => "x",
      fetch: () => Promise.reject(new Error()),
    } as unknown as DurableObjectNamespace;

    const ts = Math.floor(Date.now() / 1000);
    const sig = await hmacHex(`timestamp:${ts}`, HMAC_KEY);
    const res = await app.request(
      "/ws/streamer",
      {
        headers: {
          Upgrade: "websocket",
          "X-Vcs-Timestamp": String(ts),
          "X-Vcs-Signature": sig,
        },
      },
      bindings({ VCS_ROOM: emptyMessageError }),
    );
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("bridge_unavailable");
  });
});

// ── /api/v1/vcs/bridge/status ─────────────────────────────────────────────────

describe("GET /api/v1/vcs/bridge/status", () => {
  test("proxies the DO /status response with JSON content-type", async () => {
    const res = await app.request("/api/v1/vcs/bridge/status", {}, bindings());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { bridge_connected: boolean };
    expect(body.bridge_connected).toBe(true);
  });
});

// ── /api/v1/vcs/combat-gear (spirit + weapon family passthrough) ──────────────

describe("GET /api/v1/vcs/combat-gear", () => {
  test("returns 401 without a session cookie", async () => {
    const res = await app.request("/api/v1/vcs/combat-gear", {}, bindings());
    expect(res.status).toBe(401);
    expect(fakeRoom.lastDispatch).toBeNull();
  });

  test("dispatches GET /combat-gear with viewer identity fields", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);
    fakeRoom.nextResponse = {
      status: 200,
      body: {
        ok: true,
        sigma: { level: 5, hp: 100, depth: 2, zone: "Abyss", spirit: 57, spiritUsed: 0 },
      },
    };

    const res = await app.request(
      "/api/v1/vcs/combat-gear",
      { headers: { Cookie: "session_id=sess-1" } },
      bindings(),
    );

    expect(res.status).toBe(200);
    expect(fakeRoom.lastDispatch?.path).toBe("/api/v1/vcs/combat-gear");
    expect(fakeRoom.lastDispatch?.method).toBe("GET");
    // Viewer identity must be present in the dispatch body
    expect(fakeRoom.lastDispatch?.body).toMatchObject({
      twitch_login: "alice",
      source: "twitch",
    });
  });

  test("passes spirit and spiritUsed through from the bridge response verbatim", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);
    fakeRoom.nextResponse = {
      status: 200,
      body: {
        ok: true,
        sigma: {
          level: 12,
          hp: 180,
          depth: 4,
          zone: "Void",
          spirit: 68,
          spiritUsed: 30,
          weapon: { name: "Ravager's Cleave", family: "axe", rarity: "rare", power: 42 },
        },
      },
    };

    const res = await app.request(
      "/api/v1/vcs/combat-gear",
      { headers: { Cookie: "session_id=sess-1" } },
      bindings(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      sigma: { spirit: number; spiritUsed: number; weapon: { family: string } };
    };
    expect(body.ok).toBe(true);
    expect(body.sigma.spirit).toBe(68);
    expect(body.sigma.spiritUsed).toBe(30);
    // Weapon family for new weapon types passes through untouched
    expect(body.sigma.weapon.family).toBe("axe");
  });

  test("passes new weapon families (spear, wand) through unchanged", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);
    for (const family of ["spear", "wand"] as const) {
      fakeRoom.nextResponse = {
        status: 200,
        body: {
          ok: true,
          sigma: {
            level: 8,
            hp: 120,
            weapon: { name: `Test ${family}`, family, rarity: "common", power: 20 },
          },
        },
      };
      const res = await app.request(
        "/api/v1/vcs/combat-gear",
        { headers: { Cookie: "session_id=sess-1" } },
        bindings(),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sigma: { weapon: { family: string } } };
      expect(body.sigma.weapon.family).toBe(family);
    }
  });
});

// ── Project Ascendant: combat-sigma (GET) ────────────────────────────────────

describe("GET /api/v1/vcs/combat-sigma", () => {
  beforeEach(() => {
    fakeRoom.reset();
    fakeKv.reset();
  });

  test("401 without session", async () => {
    const res = await app.request("/api/v1/vcs/combat-sigma", {}, bindings());
    expect(res.status).toBe(401);
  });

  test("401 for unauthenticated kick session without cookie", async () => {
    const res = await app.request(
      "/api/v1/vcs/combat-sigma",
      { headers: { Cookie: "session_id=no-such-session" } },
      bindings(),
    );
    expect(res.status).toBe(401);
  });

  test("dispatches to DO with viewer identity", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);
    fakeRoom.nextResponse = {
      status: 200,
      body: {
        ok: true,
        activeSet: "A",
        passivePoints: 15,
        passives: ["warrior_start", "warrior_a"],
        passiveStart: "warrior_start",
        reserved: [],
        spirit: 68,
        spiritUsed: 0,
        auraBuffs: {},
        position: "mid",
        setB: null,
      },
    };
    const res = await app.request(
      "/api/v1/vcs/combat-sigma",
      { headers: { Cookie: "session_id=sess-1" } },
      bindings(),
    );
    expect(res.status).toBe(200);
    expect(fakeRoom.lastDispatch?.path).toBe("/api/v1/vcs/combat-sigma");
    expect(fakeRoom.lastDispatch?.method).toBe("GET");
    expect(fakeRoom.lastDispatch?.body).toMatchObject({
      twitch_login: "alice",
      source: "twitch",
    });
  });

  test("passes sigma Ascendant fields through verbatim", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);
    const expected = {
      ok: true,
      activeSet: "A",
      passivePoints: 20,
      passives: ["warrior_start", "warrior_a", "warrior_b"],
      passiveStart: "warrior_start",
      reserved: ["fire_aura"],
      spirit: 80,
      spiritUsed: 25,
      auraBuffs: { fire_aura: { name: "Fire Aura", kind: "aura", spiritCost: 25 } },
      position: "front",
      setB: null,
    };
    fakeRoom.nextResponse = { status: 200, body: expected };
    const res = await app.request(
      "/api/v1/vcs/combat-sigma",
      { headers: { Cookie: "session_id=sess-1" } },
      bindings(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof expected;
    expect(body.activeSet).toBe("A");
    expect(body.passivePoints).toBe(20);
    expect(body.passives).toEqual(["warrior_start", "warrior_a", "warrior_b"]);
    expect(body.reserved).toEqual(["fire_aura"]);
    expect(body.spirit).toBe(80);
    expect(body.spiritUsed).toBe(25);
    expect(body.position).toBe("front");
  });

  test("kick session dispatches with kick source", async () => {
    fakeKv.seed("sess-kick", KICK_SESSION);
    fakeRoom.nextResponse = {
      status: 200,
      body: { ok: true, unavailable: true, reason: "combat_twitch_only" },
    };
    const res = await app.request(
      "/api/v1/vcs/combat-sigma",
      { headers: { Cookie: "session_id=sess-kick" } },
      bindings(),
    );
    expect(res.status).toBe(200);
    expect(fakeRoom.lastDispatch?.body).toMatchObject({ source: "kick" });
  });
});

// ── Project Ascendant: combat-passive-tree (GET, no auth) ────────────────────

describe("GET /api/v1/vcs/combat-passive-tree", () => {
  beforeEach(() => {
    fakeRoom.reset();
    fakeKv.reset();
  });

  test("succeeds without a session cookie (public endpoint)", async () => {
    fakeRoom.nextResponse = {
      status: 200,
      body: { ok: true, nodeCount: 101, zones: [], keystones: [], nodes: [] },
    };
    const res = await app.request("/api/v1/vcs/combat-passive-tree", {}, bindings());
    expect(res.status).toBe(200);
    expect(fakeRoom.lastDispatch?.path).toBe("/api/v1/vcs/combat-passive-tree");
    expect(fakeRoom.lastDispatch?.method).toBe("GET");
  });

  test("dispatches with empty body (no viewer identity required)", async () => {
    fakeRoom.nextResponse = { status: 200, body: { ok: true, nodeCount: 101 } };
    await app.request("/api/v1/vcs/combat-passive-tree", {}, bindings());
    // body should not contain any viewer fields (they would be rejected by the allowlist
    // if present, but more importantly the endpoint doesn't need them)
    const body = fakeRoom.lastDispatch?.body ?? {};
    expect(Object.keys(body)).toHaveLength(0);
  });

  test("passes nodeCount + nodes through verbatim", async () => {
    const mockTree = {
      ok: true,
      nodeCount: 101,
      zones: [{ id: "warrior", startNodeId: "warrior_start" }],
      keystones: ["ks_glass_cannon"],
      nodes: [{ id: "warrior_start", kind: "attribute", name: "Warrior Start", adj: [], mods: [] }],
    };
    fakeRoom.nextResponse = { status: 200, body: mockTree };
    const res = await app.request("/api/v1/vcs/combat-passive-tree", {}, bindings());
    const body = (await res.json()) as typeof mockTree;
    expect(body.nodeCount).toBe(101);
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0].id).toBe("warrior_start");
  });
});

// ── Project Ascendant: combat-passives (POST) ────────────────────────────────

describe("POST /api/v1/vcs/combat-passives", () => {
  beforeEach(() => {
    fakeRoom.reset();
    fakeKv.reset();
  });

  test("401 without session", async () => {
    const res = await app.request(
      "/api/v1/vcs/combat-passives",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passives: ["warrior_start"] }),
      },
      bindings(),
    );
    expect(res.status).toBe(401);
  });

  test("dispatches passives array + viewer identity", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);
    fakeRoom.nextResponse = {
      status: 200,
      body: { ok: true, activeSet: "A", passives: ["warrior_start"] },
    };
    const res = await app.request(
      "/api/v1/vcs/combat-passives",
      {
        method: "POST",
        headers: { Cookie: "session_id=sess-1", "Content-Type": "application/json" },
        body: JSON.stringify({ passives: ["warrior_start", "warrior_a"], set: "A" }),
      },
      bindings(),
    );
    expect(res.status).toBe(200);
    expect(fakeRoom.lastDispatch?.path).toBe("/api/v1/vcs/combat-passives");
    expect(fakeRoom.lastDispatch?.method).toBe("POST");
    expect(fakeRoom.lastDispatch?.body).toMatchObject({
      twitch_login: "alice",
      source: "twitch",
      passives: ["warrior_start", "warrior_a"],
      set: "A",
    });
  });

  test("defaults passives to [] when body is missing passives key", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);
    fakeRoom.nextResponse = { status: 200, body: { ok: true } };
    await app.request(
      "/api/v1/vcs/combat-passives",
      {
        method: "POST",
        headers: { Cookie: "session_id=sess-1", "Content-Type": "application/json" },
        body: JSON.stringify({ set: "B" }),
      },
      bindings(),
    );
    expect(fakeRoom.lastDispatch?.body).toMatchObject({ passives: [], set: "B" });
  });

  test("defaults set to empty string when omitted", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);
    fakeRoom.nextResponse = { status: 200, body: { ok: true } };
    await app.request(
      "/api/v1/vcs/combat-passives",
      {
        method: "POST",
        headers: { Cookie: "session_id=sess-1", "Content-Type": "application/json" },
        body: JSON.stringify({ passives: ["warrior_start"] }),
      },
      bindings(),
    );
    expect(fakeRoom.lastDispatch?.body).toMatchObject({ passives: ["warrior_start"], set: "" });
  });

  test("set B targets the inactive spec", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);
    fakeRoom.nextResponse = { status: 200, body: { ok: true, activeSet: "A" } };
    await app.request(
      "/api/v1/vcs/combat-passives",
      {
        method: "POST",
        headers: { Cookie: "session_id=sess-1", "Content-Type": "application/json" },
        body: JSON.stringify({ passives: ["ranger_start", "ranger_a"], set: "B" }),
      },
      bindings(),
    );
    expect(fakeRoom.lastDispatch?.body).toMatchObject({
      passives: ["ranger_start", "ranger_a"],
      set: "B",
    });
  });
});

// ── Project Ascendant: combat-reserve (POST) ─────────────────────────────────

describe("POST /api/v1/vcs/combat-reserve", () => {
  beforeEach(() => {
    fakeRoom.reset();
    fakeKv.reset();
  });

  test("401 without session", async () => {
    const res = await app.request(
      "/api/v1/vcs/combat-reserve",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reserved: ["fire_aura"] }),
      },
      bindings(),
    );
    expect(res.status).toBe(401);
  });

  test("dispatches reserved array + viewer identity", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);
    fakeRoom.nextResponse = {
      status: 200,
      body: { ok: true, reserved: ["fire_aura"], spiritUsed: 25 },
    };
    const res = await app.request(
      "/api/v1/vcs/combat-reserve",
      {
        method: "POST",
        headers: { Cookie: "session_id=sess-1", "Content-Type": "application/json" },
        body: JSON.stringify({ reserved: ["fire_aura", "ice_aura"], set: "A" }),
      },
      bindings(),
    );
    expect(res.status).toBe(200);
    expect(fakeRoom.lastDispatch?.path).toBe("/api/v1/vcs/combat-reserve");
    expect(fakeRoom.lastDispatch?.body).toMatchObject({
      twitch_login: "alice",
      reserved: ["fire_aura", "ice_aura"],
      set: "A",
    });
  });

  test("defaults reserved to [] on missing key", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);
    fakeRoom.nextResponse = { status: 200, body: { ok: true } };
    await app.request(
      "/api/v1/vcs/combat-reserve",
      {
        method: "POST",
        headers: { Cookie: "session_id=sess-1", "Content-Type": "application/json" },
        body: JSON.stringify({ set: "A" }),
      },
      bindings(),
    );
    expect(fakeRoom.lastDispatch?.body).toMatchObject({ reserved: [], set: "A" });
  });

  test("non-array reserved value is coerced to []", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);
    fakeRoom.nextResponse = { status: 200, body: { ok: true } };
    await app.request(
      "/api/v1/vcs/combat-reserve",
      {
        method: "POST",
        headers: { Cookie: "session_id=sess-1", "Content-Type": "application/json" },
        body: JSON.stringify({ reserved: "fire_aura", set: "A" }),
      },
      bindings(),
    );
    expect(fakeRoom.lastDispatch?.body).toMatchObject({ reserved: [] });
  });
});

// ── Project Ascendant: combat-position (POST) ────────────────────────────────

describe("POST /api/v1/vcs/combat-position", () => {
  beforeEach(() => {
    fakeRoom.reset();
    fakeKv.reset();
  });

  test("401 without session", async () => {
    const res = await app.request(
      "/api/v1/vcs/combat-position",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ position: "front" }),
      },
      bindings(),
    );
    expect(res.status).toBe(401);
  });

  test("dispatches position + viewer identity", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);
    fakeRoom.nextResponse = { status: 200, body: { ok: true, position: "front" } };
    const res = await app.request(
      "/api/v1/vcs/combat-position",
      {
        method: "POST",
        headers: { Cookie: "session_id=sess-1", "Content-Type": "application/json" },
        body: JSON.stringify({ position: "front", set: "A" }),
      },
      bindings(),
    );
    expect(res.status).toBe(200);
    expect(fakeRoom.lastDispatch?.path).toBe("/api/v1/vcs/combat-position");
    expect(fakeRoom.lastDispatch?.body).toMatchObject({
      twitch_login: "alice",
      position: "front",
      set: "A",
    });
  });

  test("all three position values route correctly", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);
    for (const pos of ["front", "mid", "back"] as const) {
      fakeRoom.reset();
      fakeKv.seed("sess-1", TWITCH_SESSION);
      fakeRoom.nextResponse = { status: 200, body: { ok: true, position: pos } };
      await app.request(
        "/api/v1/vcs/combat-position",
        {
          method: "POST",
          headers: { Cookie: "session_id=sess-1", "Content-Type": "application/json" },
          body: JSON.stringify({ position: pos }),
        },
        bindings(),
      );
      expect(fakeRoom.lastDispatch?.body).toMatchObject({ position: pos });
    }
  });

  test("non-string position is coerced to empty string", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);
    fakeRoom.nextResponse = { status: 200, body: { ok: true } };
    await app.request(
      "/api/v1/vcs/combat-position",
      {
        method: "POST",
        headers: { Cookie: "session_id=sess-1", "Content-Type": "application/json" },
        body: JSON.stringify({ position: 42 }),
      },
      bindings(),
    );
    expect(fakeRoom.lastDispatch?.body).toMatchObject({ position: "" });
  });

  test("set B routes position to inactive spec", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);
    fakeRoom.nextResponse = { status: 200, body: { ok: true } };
    await app.request(
      "/api/v1/vcs/combat-position",
      {
        method: "POST",
        headers: { Cookie: "session_id=sess-1", "Content-Type": "application/json" },
        body: JSON.stringify({ position: "back", set: "B" }),
      },
      bindings(),
    );
    expect(fakeRoom.lastDispatch?.body).toMatchObject({ position: "back", set: "B" });
  });
});

// ── Project Ascendant: combat-swap-set (POST) ────────────────────────────────

describe("POST /api/v1/vcs/combat-swap-set", () => {
  beforeEach(() => {
    fakeRoom.reset();
    fakeKv.reset();
  });

  test("401 without session", async () => {
    const res = await app.request(
      "/api/v1/vcs/combat-swap-set",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      bindings(),
    );
    expect(res.status).toBe(401);
  });

  test("dispatches swap with viewer identity", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);
    fakeRoom.nextResponse = { status: 200, body: { ok: true, activeSet: "B" } };
    const res = await app.request(
      "/api/v1/vcs/combat-swap-set",
      {
        method: "POST",
        headers: { Cookie: "session_id=sess-1", "Content-Type": "application/json" },
        body: JSON.stringify({ set: "B" }),
      },
      bindings(),
    );
    expect(res.status).toBe(200);
    expect(fakeRoom.lastDispatch?.path).toBe("/api/v1/vcs/combat-swap-set");
    expect(fakeRoom.lastDispatch?.method).toBe("POST");
    expect(fakeRoom.lastDispatch?.body).toMatchObject({
      twitch_login: "alice",
      source: "twitch",
      set: "B",
    });
  });

  test("set defaults to empty string when omitted", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);
    fakeRoom.nextResponse = { status: 200, body: { ok: true, activeSet: "B" } };
    await app.request(
      "/api/v1/vcs/combat-swap-set",
      {
        method: "POST",
        headers: { Cookie: "session_id=sess-1", "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      bindings(),
    );
    expect(fakeRoom.lastDispatch?.body).toMatchObject({ set: "" });
  });

  test("response body passes through from bridge verbatim", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);
    const bridgeResp = { ok: true, activeSet: "B", hasSetB: true, passives: ["ranger_start"] };
    fakeRoom.nextResponse = { status: 200, body: bridgeResp };
    const res = await app.request(
      "/api/v1/vcs/combat-swap-set",
      {
        method: "POST",
        headers: { Cookie: "session_id=sess-1", "Content-Type": "application/json" },
        body: JSON.stringify({ set: "B" }),
      },
      bindings(),
    );
    const body = (await res.json()) as typeof bridgeResp;
    expect(body.activeSet).toBe("B");
    expect(body.hasSetB).toBe(true);
    expect(body.passives).toEqual(["ranger_start"]);
  });

  test("kick viewer dispatches with kick source", async () => {
    fakeKv.seed("sess-kick", KICK_SESSION);
    fakeRoom.nextResponse = {
      status: 200,
      body: { ok: true, unavailable: true, reason: "combat_twitch_only" },
    };
    await app.request(
      "/api/v1/vcs/combat-swap-set",
      {
        method: "POST",
        headers: { Cookie: "session_id=sess-kick", "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      bindings(),
    );
    expect(fakeRoom.lastDispatch?.body).toMatchObject({ source: "kick" });
  });
});

// ── Vampire Survivors: combat-weapon-catalog (GET, no auth) ──────────────────

describe("GET /api/v1/vcs/combat-weapon-catalog", () => {
  beforeEach(() => {
    fakeRoom.reset();
    fakeKv.reset();
  });

  test("succeeds without a session cookie (public endpoint)", async () => {
    fakeRoom.nextResponse = {
      status: 200,
      body: { ok: true, maxSlots: 6, weapons: [], evolutions: [] },
    };
    const res = await app.request("/api/v1/vcs/combat-weapon-catalog", {}, bindings());
    expect(res.status).toBe(200);
    expect(fakeRoom.lastDispatch?.path).toBe("/api/v1/vcs/combat-weapon-catalog");
    expect(fakeRoom.lastDispatch?.method).toBe("GET");
  });

  test("dispatches with empty body (no viewer identity required)", async () => {
    fakeRoom.nextResponse = { status: 200, body: { ok: true, maxSlots: 6 } };
    await app.request("/api/v1/vcs/combat-weapon-catalog", {}, bindings());
    expect(Object.keys(fakeRoom.lastDispatch?.body ?? {})).toHaveLength(0);
  });

  test("passes catalog weapons + evolutions through verbatim", async () => {
    const mockCatalog = {
      ok: true,
      maxSlots: 6,
      weapons: [{ id: "whip", name: "Whip", kind: "arc", fireRate: 1.0, damage: 0.9 }],
      evolutions: [{ id: "bloody_tear", name: "Bloody Tear", base: "whip" }],
    };
    fakeRoom.nextResponse = { status: 200, body: mockCatalog };
    const res = await app.request("/api/v1/vcs/combat-weapon-catalog", {}, bindings());
    const body = (await res.json()) as typeof mockCatalog;
    expect(body.maxSlots).toBe(6);
    expect(body.weapons).toHaveLength(1);
    expect(body.weapons[0].id).toBe("whip");
    expect(body.evolutions[0].id).toBe("bloody_tear");
  });
});

// ── Vampire Survivors: combat-weapons GET ────────────────────────────────────

describe("GET /api/v1/vcs/combat-weapons", () => {
  beforeEach(() => {
    fakeRoom.reset();
    fakeKv.reset();
  });

  test("returns 401 without a session cookie", async () => {
    const res = await app.request("/api/v1/vcs/combat-weapons", {}, bindings());
    expect(res.status).toBe(401);
    expect(fakeRoom.lastDispatch).toBeNull();
  });

  test("dispatches GET with viewer identity fields", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);
    fakeRoom.nextResponse = {
      status: 200,
      body: {
        ok: true,
        weapons: ["whip", "garlic"],
        activeWeapon: "garlic",
        maxSlots: 6,
        fainted: 0,
        lostWeapon: null,
        evolutions: [],
      },
    };
    const res = await app.request(
      "/api/v1/vcs/combat-weapons",
      { headers: { Cookie: "session_id=sess-1" } },
      bindings(),
    );
    expect(res.status).toBe(200);
    expect(fakeRoom.lastDispatch?.path).toBe("/api/v1/vcs/combat-weapons");
    expect(fakeRoom.lastDispatch?.method).toBe("GET");
    expect(fakeRoom.lastDispatch?.body).toMatchObject({
      source: "twitch",
      login: "alice",
      twitch_login: "alice",
    });
  });

  test("passes weapons loadout + faint state + evolutions through verbatim", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);
    fakeRoom.nextResponse = {
      status: 200,
      body: {
        ok: true,
        weapons: ["whip", "garlic"],
        activeWeapon: "garlic",
        maxSlots: 6,
        fainted: 2,
        lostWeapon: "whip",
        evolutions: [{ id: "bloody_tear", name: "Bloody Tear" }],
      },
    };
    const res = await app.request(
      "/api/v1/vcs/combat-weapons",
      { headers: { Cookie: "session_id=sess-1" } },
      bindings(),
    );
    const body = (await res.json()) as {
      weapons: string[];
      activeWeapon: string;
      fainted: number;
      lostWeapon: string;
      evolutions: { id: string }[];
    };
    expect(body.weapons).toEqual(["whip", "garlic"]);
    expect(body.activeWeapon).toBe("garlic");
    expect(body.fainted).toBe(2);
    expect(body.lostWeapon).toBe("whip");
    expect(body.evolutions[0].id).toBe("bloody_tear");
  });

  test("kick session dispatches with kick source", async () => {
    fakeKv.seed("sess-kick", KICK_SESSION);
    fakeRoom.nextResponse = { status: 200, body: { ok: true, weapons: [], maxSlots: 6 } };
    await app.request(
      "/api/v1/vcs/combat-weapons",
      { headers: { Cookie: "session_id=sess-kick" } },
      bindings(),
    );
    expect(fakeRoom.lastDispatch?.body).toMatchObject({ source: "kick", login: "bobstream" });
  });
});

// ── Vampire Survivors: combat-weapons POST ───────────────────────────────────

describe("POST /api/v1/vcs/combat-weapons", () => {
  beforeEach(() => {
    fakeRoom.reset();
    fakeKv.reset();
  });

  test("returns 401 without a session cookie", async () => {
    const res = await app.request(
      "/api/v1/vcs/combat-weapons",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weapons: ["whip"] }),
      },
      bindings(),
    );
    expect(res.status).toBe(401);
    expect(fakeRoom.lastDispatch).toBeNull();
  });

  test("dispatches weapons array + set + viewer identity", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);
    fakeRoom.nextResponse = {
      status: 200,
      body: { ok: true, weapons: ["whip", "garlic"], activeWeapon: "garlic" },
    };
    const res = await app.request(
      "/api/v1/vcs/combat-weapons",
      {
        method: "POST",
        headers: { Cookie: "session_id=sess-1", "Content-Type": "application/json" },
        body: JSON.stringify({ weapons: ["whip", "garlic"], set: "garlic" }),
      },
      bindings(),
    );
    expect(res.status).toBe(200);
    expect(fakeRoom.lastDispatch?.path).toBe("/api/v1/vcs/combat-weapons");
    expect(fakeRoom.lastDispatch?.method).toBe("POST");
    expect(fakeRoom.lastDispatch?.body).toMatchObject({
      source: "twitch",
      login: "alice",
      twitch_login: "alice",
      weapons: ["whip", "garlic"],
      set: "garlic",
    });
  });

  test("defaults weapons to [] when body key is missing", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);
    fakeRoom.nextResponse = { status: 200, body: { ok: true } };
    await app.request(
      "/api/v1/vcs/combat-weapons",
      {
        method: "POST",
        headers: { Cookie: "session_id=sess-1", "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      bindings(),
    );
    expect(fakeRoom.lastDispatch?.body).toMatchObject({ weapons: [], set: "" });
  });

  test("coerces non-array weapons value to []", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);
    fakeRoom.nextResponse = { status: 200, body: { ok: true } };
    await app.request(
      "/api/v1/vcs/combat-weapons",
      {
        method: "POST",
        headers: { Cookie: "session_id=sess-1", "Content-Type": "application/json" },
        body: JSON.stringify({ weapons: "whip" }),
      },
      bindings(),
    );
    expect(fakeRoom.lastDispatch?.body).toMatchObject({ weapons: [] });
  });

  test("defaults set to empty string when omitted", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);
    fakeRoom.nextResponse = { status: 200, body: { ok: true } };
    await app.request(
      "/api/v1/vcs/combat-weapons",
      {
        method: "POST",
        headers: { Cookie: "session_id=sess-1", "Content-Type": "application/json" },
        body: JSON.stringify({ weapons: ["whip"] }),
      },
      bindings(),
    );
    expect(fakeRoom.lastDispatch?.body).toMatchObject({ weapons: ["whip"], set: "" });
  });

  test("bridge response passes through verbatim", async () => {
    fakeKv.seed("sess-1", TWITCH_SESSION);
    const bridgeResp = {
      ok: true,
      weapons: ["whip"],
      activeWeapon: "whip",
      maxSlots: 6,
      fainted: 0,
      lostWeapon: null,
      evolutions: [],
    };
    fakeRoom.nextResponse = { status: 200, body: bridgeResp };
    const res = await app.request(
      "/api/v1/vcs/combat-weapons",
      {
        method: "POST",
        headers: { Cookie: "session_id=sess-1", "Content-Type": "application/json" },
        body: JSON.stringify({ weapons: ["whip"] }),
      },
      bindings(),
    );
    const body = (await res.json()) as typeof bridgeResp;
    expect(body.weapons).toEqual(["whip"]);
    expect(body.activeWeapon).toBe("whip");
    expect(body.maxSlots).toBe(6);
    expect(body.evolutions).toEqual([]);
  });
});

// ── ASSETS fallback / Not found ───────────────────────────────────────────────

describe("static asset fallback", () => {
  test("returns 404 for an unknown path when ASSETS is not bound", async () => {
    const res = await app.request("/totally/unknown", {}, bindings());
    expect(res.status).toBe(404);
  });

  test("falls through to ASSETS when bound and the asset exists", async () => {
    const assets = {
      async fetch(_r: Request): Promise<Response> {
        return new Response("<html>vcs</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      },
    };
    const res = await app.request("/index.html", {}, {
      ...bindings(),
      ASSETS: assets,
    } as unknown as VcsBindings);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("vcs");
  });

  test("falls back to text/Not found when ASSETS returns 404", async () => {
    const assets = {
      async fetch(_r: Request): Promise<Response> {
        return new Response("missing", { status: 404 });
      },
    };
    const res = await app.request("/some/missing", {}, {
      ...bindings(),
      ASSETS: assets,
    } as unknown as VcsBindings);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
  });
});
