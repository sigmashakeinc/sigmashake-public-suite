// test/vcs-room.test.ts — VcsRoom Durable Object fetch-path resilience.
//
// VcsRoom is a hibernatable-WebSocket DO. A deploy resets the DO mid-flight:
// a /ws/bridge upgrade or a getWebSockets / acceptWebSocket / new
// WebSocketPair call can throw while the runtime swaps in the new code.
// fetch() must catch that and return a 503 rather than let the DO invocation
// abort as an uncaught exception — which paged sigmashake-alerts as "Uncaught
// Error in sigmashake-vcs … (no message)" on the 2026-05-21 deploy.

import { describe, expect, mock, test } from "bun:test";

// Stub the Workers-only `cloudflare:workers` module before importing the DO
// (same pattern as routes.test.ts). The stub base class just stores ctx/env.
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

const { VcsRoom } = await import("../src/vcs-room");

/** Construct a VcsRoom over a fake DurableObjectState `ctx`. */
function makeRoom(ctx: Record<string, unknown>): InstanceType<typeof VcsRoom> {
  return new VcsRoom(ctx as never, {} as never);
}

describe("VcsRoom.fetch resilience", () => {
  test("returns a 503 instead of throwing when a DO state call fails", async () => {
    // Empty-message Error — the exact post-deploy-reset variant that paged
    // sigmashake-alerts. /status calls ctx.getWebSockets() directly.
    const room = makeRoom({
      getWebSockets: () => {
        throw new Error();
      },
    });
    const res = await room.fetch(new Request("http://do/status"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body).toEqual({ ok: false, error: "do_unavailable" });
  });

  test("returns a 503 when a /dispatch body cannot be parsed", async () => {
    // The unguarded `await request.json()` on /dispatch is now covered too.
    const room = makeRoom({ getWebSockets: () => [] });
    const res = await room.fetch(
      new Request("http://do/dispatch", { method: "POST", body: "}{ not json" }),
    );
    expect(res.status).toBe(503);
  });

  test("still serves /status normally when the DO is healthy", async () => {
    const room = makeRoom({ getWebSockets: () => [] });
    const res = await room.fetch(new Request("http://do/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bridge_connected: boolean; bridges: number };
    expect(body).toMatchObject({ bridge_connected: false, bridges: 0 });
  });
});

// ── RPC body-field allowlist (the wire-contract gate) ───────────────────────
//
// validateRpcRequest is module-private; exercise it through /dispatch. A body
// carrying ONLY allowlisted keys passes validation (and then hits bridge_offline
// because no socket is connected); a body with an unknown key is rejected 400
// with `rpc_body_unknown_field:<key>` BEFORE any bridge dispatch. The four new
// identity keys (source/login/user_id/display) MUST be accepted or every
// kick/google authed RPC would be rejected.

async function dispatch(
  room: InstanceType<typeof VcsRoom>,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await room.fetch(
    new Request("http://do/dispatch", {
      method: "POST",
      body: JSON.stringify({ method: "GET", path: "/api/v1/vcs/me", body }),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("VcsRoom /dispatch body-field allowlist", () => {
  test("accepts the full generic + back-compat identity envelope (passes validation → bridge_offline)", async () => {
    const room = makeRoom({ getWebSockets: () => [] });
    const { status, json } = await dispatch(room, {
      source: "kick",
      login: "bobstream",
      user_id: "5551212",
      display: "bobstream",
      twitch_user_id: "5551212",
      twitch_login: "bobstream",
      twitch_display: "bobstream",
    });
    // Validation passed; the only reason for failure is no connected bridge.
    expect(status).toBe(503);
    expect(json.error).toBe("bridge_offline");
  });

  test("accepts a bare twitch_login subset (public-API shape stays valid)", async () => {
    const room = makeRoom({ getWebSockets: () => [] });
    const { status, json } = await dispatch(room, { twitch_login: "alice" });
    expect(status).toBe(503);
    expect(json.error).toBe("bridge_offline");
  });

  test("rejects an unknown body key with rpc_body_unknown_field before dispatch", async () => {
    const room = makeRoom({ getWebSockets: () => [] });
    const { status, json } = await dispatch(room, { source: "kick", evil: "x" });
    expect(status).toBe(400);
    expect(json.error).toBe("rpc_rejected");
    expect(json.reason).toBe("rpc_body_unknown_field:evil");
  });

  test("rejects each of the new identity keys NOT being a free-for-all — only the 4 + mirror + slot params are allowed", async () => {
    const room = makeRoom({ getWebSockets: () => [] });
    // `provider` is not in the allowlist even though it looks identity-ish.
    const { status, json } = await dispatch(room, { provider: "kick" });
    expect(status).toBe(400);
    expect(json.reason).toBe("rpc_body_unknown_field:provider");
  });
});

// ── RPC body-field allowlist — Vampire Survivors weapon paths ───────────────

async function dispatchPath(
  room: InstanceType<typeof VcsRoom>,
  method: "GET" | "POST",
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await room.fetch(
    new Request("http://do/dispatch", {
      method: "POST",
      body: JSON.stringify({ method, path, body }),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const FULL_IDENTITY = {
  source: "twitch",
  login: "alice",
  user_id: "123",
  display: "alice",
  twitch_user_id: "123",
  twitch_login: "alice",
  twitch_display: "alice",
};

describe("VcsRoom /dispatch — combat-weapon-catalog allowlist", () => {
  test("GET with empty body passes validation (→ bridge_offline)", async () => {
    const room = makeRoom({ getWebSockets: () => [] });
    const { status, json } = await dispatchPath(
      room,
      "GET",
      "/api/v1/vcs/combat-weapon-catalog",
      {},
    );
    expect(status).toBe(503);
    expect(json.error).toBe("bridge_offline");
  });

  test("rejects any body key — catalog is auth-free, body must be empty", async () => {
    const room = makeRoom({ getWebSockets: () => [] });
    const { status, json } = await dispatchPath(room, "GET", "/api/v1/vcs/combat-weapon-catalog", {
      twitch_login: "alice",
    });
    expect(status).toBe(400);
    expect(json.reason).toBe("rpc_body_unknown_field:twitch_login");
  });

  test("rejects POST method (catalog is GET-only)", async () => {
    const room = makeRoom({ getWebSockets: () => [] });
    const { status, json } = await dispatchPath(
      room,
      "POST",
      "/api/v1/vcs/combat-weapon-catalog",
      {},
    );
    expect(status).toBe(400);
    expect(json.reason).toBe("rpc_method_not_allowed");
  });
});

describe("VcsRoom /dispatch — combat-weapons allowlist", () => {
  test("GET with full viewer identity passes validation (→ bridge_offline)", async () => {
    const room = makeRoom({ getWebSockets: () => [] });
    const { status, json } = await dispatchPath(
      room,
      "GET",
      "/api/v1/vcs/combat-weapons",
      FULL_IDENTITY,
    );
    expect(status).toBe(503);
    expect(json.error).toBe("bridge_offline");
  });

  test("POST with viewer identity + weapons + set passes validation (→ bridge_offline)", async () => {
    const room = makeRoom({ getWebSockets: () => [] });
    const { status, json } = await dispatchPath(room, "POST", "/api/v1/vcs/combat-weapons", {
      ...FULL_IDENTITY,
      weapons: ["whip", "garlic"],
      set: "garlic",
    });
    expect(status).toBe(503);
    expect(json.error).toBe("bridge_offline");
  });

  test("rejects unknown body key on GET", async () => {
    const room = makeRoom({ getWebSockets: () => [] });
    const { status, json } = await dispatchPath(room, "GET", "/api/v1/vcs/combat-weapons", {
      ...FULL_IDENTITY,
      evil: "x",
    });
    expect(status).toBe(400);
    expect(json.reason).toBe("rpc_body_unknown_field:evil");
  });

  test("rejects unknown body key on POST", async () => {
    const room = makeRoom({ getWebSockets: () => [] });
    const { status, json } = await dispatchPath(room, "POST", "/api/v1/vcs/combat-weapons", {
      ...FULL_IDENTITY,
      weapons: ["whip"],
      unknown_field: "x",
    });
    expect(status).toBe(400);
    expect(json.reason).toBe("rpc_body_unknown_field:unknown_field");
  });
});

describe("VcsRoom /dispatch — brains tick allowlist", () => {
  test("accepts the exact canonical brain fields", async () => {
    const room = makeRoom({ getWebSockets: () => [] });
    const { status, json } = await dispatchPath(room, "POST", "/api/v1/vcs/brains/tick", {
      ...FULL_IDENTITY,
      scene: "studio",
      stimulus: "chat mentioned a new build",
      mood: "curious",
      nearby: ["chat", "boss"],
      image_data_url: "data:image/png;base64,abc",
    });
    expect(status).toBe(503);
    expect(json.error).toBe("bridge_offline");
  });

  test("rejects an unknown brain field before dispatch", async () => {
    const room = makeRoom({ getWebSockets: () => [] });
    const { status, json } = await dispatchPath(room, "POST", "/api/v1/vcs/brains/tick", {
      ...FULL_IDENTITY,
      scene: "studio",
      plan: "escape",
    });
    expect(status).toBe(400);
    expect(json.reason).toBe("rpc_body_unknown_field:plan");
  });
});
