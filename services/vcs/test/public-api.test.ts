// test/public-api.test.ts — Hono route tests for the VCS public API
// (/api/public/*). The Durable Object is stubbed so we can assert what gets
// dispatched to the bridge; a fake VCS_API_KEYS KV exercises bearer auth.

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ApiKeyRecord } from "../src/lib/api-key";

// Stub the Workers-only `cloudflare:workers` module BEFORE importing `app`
// (vcs-room.ts imports `DurableObject` from it). Same pattern as routes.test.ts.
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

const { default: app } = await import("../src/index");
const { sha256Hex } = await import("../src/lib/api-key");

// ── Fakes ─────────────────────────────────────────────────────────────────────

interface DispatchPayload {
  method: "GET" | "POST";
  path: string;
  body: Record<string, unknown>;
}

class FakeDORoom {
  lastDispatch: DispatchPayload | null = null;
  nextResponse: { status: number; body: unknown } = { status: 200, body: { ok: true } };

  reset(): void {
    this.lastDispatch = null;
    this.nextResponse = { status: 200, body: { ok: true } };
  }

  async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname === "/dispatch") {
      this.lastDispatch = (await req.json()) as DispatchPayload;
      return new Response(JSON.stringify(this.nextResponse.body), {
        status: this.nextResponse.status,
        headers: { "Content-Type": "application/json" },
      });
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

class FakeApiKeyKv {
  store = new Map<string, ApiKeyRecord>();

  reset(): void {
    this.store.clear();
  }

  async seed(token: string, record: ApiKeyRecord): Promise<void> {
    this.store.set(await sha256Hex(token), record);
  }

  async get<T = unknown>(key: string, _type?: unknown): Promise<T | null> {
    return (this.store.get(key) ?? null) as T | null;
  }
}

const fakeApiKeys = new FakeApiKeyKv();

interface VcsBindings {
  VCS_ROOM: DurableObjectNamespace;
  SESSIONS: KVNamespace;
  VCS_API_KEYS?: KVNamespace;
  TWITCH_BROADCASTER_ID: string;
}

function bindings(opts: Partial<VcsBindings> = {}): VcsBindings {
  return {
    VCS_ROOM: fakeRoomNamespace,
    SESSIONS: {} as unknown as KVNamespace,
    VCS_API_KEYS: fakeApiKeys as unknown as KVNamespace,
    TWITCH_BROADCASTER_ID: "test-broadcaster",
    ...opts,
  };
}

const VALID_TOKEN = "sk_vcs_testtoken000";
const READ_KEY: ApiKeyRecord = { owner: "test-partner", scopes: ["read"], created: "2026-05-20" };

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

beforeEach(async () => {
  fakeRoom.reset();
  fakeApiKeys.reset();
  await fakeApiKeys.seed(VALID_TOKEN, READ_KEY);
});

// ── Discovery (no auth) ───────────────────────────────────────────────────────

describe("GET /api/public/openapi.json", () => {
  test("returns the OpenAPI 3.1 spec without auth", async () => {
    const res = await app.request("/api/public/openapi.json", {}, bindings());
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.paths["/api/public/v1/character/{twitch_login}"]).toBeDefined();
  });

  test("servers URL reflects the request origin", async () => {
    const res = await app.request(
      "https://vcs.sigmashake.com/api/public/openapi.json",
      {},
      bindings(),
    );
    const spec = (await res.json()) as { servers: Array<{ url: string }> };
    expect(spec.servers[0].url).toBe("https://vcs.sigmashake.com");
  });
});

describe("GET /api/public/docs", () => {
  test("serves the Swagger UI HTML without auth", async () => {
    const res = await app.request("/api/public/docs", {}, bindings());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("swagger-ui");
  });
});

// ── Auth ──────────────────────────────────────────────────────────────────────

describe("public API auth", () => {
  test("503 api_not_configured when VCS_API_KEYS is unbound", async () => {
    const res = await app.request(
      "/api/public/v1/catalog",
      {},
      bindings({ VCS_API_KEYS: undefined }),
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("api_not_configured");
    expect(fakeRoom.lastDispatch).toBeNull();
  });

  test("401 missing_api_key when no Authorization header is sent", async () => {
    const res = await app.request("/api/public/v1/catalog", {}, bindings());
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("missing_api_key");
    expect(fakeRoom.lastDispatch).toBeNull();
  });

  test("401 invalid_api_key for an unknown token", async () => {
    const res = await app.request(
      "/api/public/v1/catalog",
      { headers: authHeaders("sk_vcs_wrong") },
      bindings(),
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_api_key");
    expect(fakeRoom.lastDispatch).toBeNull();
  });

  test("403 insufficient_scope when the key lacks the read scope", async () => {
    await fakeApiKeys.seed("sk_vcs_noscope", { owner: "x", scopes: [], created: "2026-05-20" });
    const res = await app.request(
      "/api/public/v1/catalog",
      { headers: authHeaders("sk_vcs_noscope") },
      bindings(),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("insufficient_scope");
    expect(fakeRoom.lastDispatch).toBeNull();
  });
});

// ── Data routes ───────────────────────────────────────────────────────────────

describe("GET /api/public/v1/catalog", () => {
  test("dispatches GET /api/v1/vcs/catalog with an empty body", async () => {
    const res = await app.request(
      "/api/public/v1/catalog",
      { headers: authHeaders(VALID_TOKEN) },
      bindings(),
    );
    expect(res.status).toBe(200);
    expect(fakeRoom.lastDispatch).toEqual({
      method: "GET",
      path: "/api/v1/vcs/catalog",
      body: {},
    });
  });
});

describe("GET /api/public/v1/character/:login", () => {
  test("dispatches GET /api/v1/vcs/me keyed by twitch_login only", async () => {
    fakeRoom.nextResponse = { status: 200, body: { ok: true, loadout: { body: "normal" } } };
    const res = await app.request(
      "/api/public/v1/character/alice",
      { headers: authHeaders(VALID_TOKEN) },
      bindings(),
    );
    expect(res.status).toBe(200);
    expect(fakeRoom.lastDispatch).toEqual({
      method: "GET",
      path: "/api/v1/vcs/me",
      body: { twitch_login: "alice" },
    });
  });

  test("lowercases the login before dispatch", async () => {
    await app.request(
      "/api/public/v1/character/AliceCaps",
      { headers: authHeaders(VALID_TOKEN) },
      bindings(),
    );
    expect(fakeRoom.lastDispatch?.body).toEqual({ twitch_login: "alicecaps" });
  });

  test("400 invalid_twitch_login for a login with illegal characters", async () => {
    const res = await app.request(
      "/api/public/v1/character/bad-login",
      { headers: authHeaders(VALID_TOKEN) },
      bindings(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_twitch_login");
    expect(fakeRoom.lastDispatch).toBeNull();
  });

  test("passes the bridge response status through unchanged", async () => {
    fakeRoom.nextResponse = { status: 503, body: { ok: false, error: "bridge_offline" } };
    const res = await app.request(
      "/api/public/v1/character/alice",
      { headers: authHeaders(VALID_TOKEN) },
      bindings(),
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("bridge_offline");
  });
});

describe("GET /api/public/v1/character/:login/combat-gear", () => {
  test("dispatches GET /api/v1/vcs/combat-gear keyed by twitch_login", async () => {
    const res = await app.request(
      "/api/public/v1/character/alice/combat-gear",
      { headers: authHeaders(VALID_TOKEN) },
      bindings(),
    );
    expect(res.status).toBe(200);
    expect(fakeRoom.lastDispatch).toEqual({
      method: "GET",
      path: "/api/v1/vcs/combat-gear",
      body: { twitch_login: "alice" },
    });
  });
});
