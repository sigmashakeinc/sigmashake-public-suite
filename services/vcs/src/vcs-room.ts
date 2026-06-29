import { DurableObject } from "cloudflare:workers";

/**
 * Per-broadcaster Durable Object. Owns:
 *   - one WebSocket to the streamer's `vcs-bridge.ts` (multiplexes all
 *     viewer requests through a single hibernatable connection)
 *   - an in-memory map of pending RPCs keyed by `req_id`, each resolving
 *     a promise when the bridge replies on the same WS
 *
 * Wire protocol (JSON over text frames):
 *   Worker→bridge: {type:"rpc", req_id, method:"GET"|"POST",
 *                   path:"/api/v1/vcs/...", body?:{...}}
 *   bridge→Worker: {type:"rpc_reply", req_id, status, body}
 *
 *   bridge→Worker: {type:"ping", ts}            (heartbeat)
 *   Worker→bridge: {type:"pong", ts}            (heartbeat reply)
 *
 * The bridge WS is accepted via `ctx.acceptWebSocket` (hibernatable), so
 * the socket survives DO hibernation between viewer requests. App-level
 * ping/pong gives the bridge fast dead-connection detection (TCP zombies
 * between Cloudflare and the streamer otherwise linger for minutes); the
 * /status poll is a backup. The `pending` map is in-memory and only
 * persists while a `/dispatch` is in flight, but webSocketClose drains
 * the map so viewers fail fast instead of waiting the full RPC timeout
 * when the bridge drops mid-flight.
 */

interface RpcRequest {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
}

// Allowlist of RPC paths the DO will forward to the streamer bridge. Anything
// not listed here is rejected at /dispatch before it can reach chat-elixir —
// defense-in-depth on top of chat-elixir's own validation.
//
// This table MUST mirror exactly the calls `src/routes/viewer.ts` makes through
// `dispatchToBridge`: same paths, same body-field sets. `validateRpcRequest`
// rejects any body key absent from `bodyFields`, so the viewer identity
// envelope sent on every authed route is enumerated here as VIEWER_IDENTITY.
// Change a dispatch call in viewer.ts → update this table in the same commit.
//
// The generic envelope (source / login / user_id / display) plus the
// back-compat mirror (twitch_user_id / twitch_login / twitch_display) ride on
// every authed RPC. ALL of these keys MUST be allowlisted or a kick/google
// (or any) authed RPC is rejected `rpc_body_unknown_field:source`. The public
// API (routes/public.ts) dispatches with only { twitch_login }, a valid subset
// of this widened allowlist, so it is unaffected.
const VIEWER_IDENTITY = [
  "source",
  "login",
  "user_id",
  "display",
  "twitch_user_id",
  "twitch_login",
  "twitch_display",
] as const;

const RPC_ROUTE_ALLOWLIST: Record<
  string,
  { methods: ReadonlyArray<"GET" | "POST">; bodyFields?: ReadonlyArray<string> }
> = {
  "/api/v1/vcs/me": { methods: ["GET"], bodyFields: [...VIEWER_IDENTITY] },
  "/api/v1/vcs/brains/tick": {
    methods: ["POST"],
    bodyFields: [...VIEWER_IDENTITY, "scene", "stimulus", "mood", "nearby", "image_data_url"],
  },
  "/api/v1/vcs/catalog": { methods: ["GET"], bodyFields: [] },
  "/api/v1/vcs/combat-gear": { methods: ["GET"], bodyFields: [...VIEWER_IDENTITY] },
  "/api/v1/vcs/combat-loadout": { methods: ["GET"], bodyFields: [...VIEWER_IDENTITY] },
  "/api/v1/vcs/combat-equip": {
    methods: ["POST"],
    bodyFields: [...VIEWER_IDENTITY, "slot", "index"],
  },
  // Project Ascendant build-configuration endpoints (Inc 4/5/6/7).
  // Bridge proxies these to the loopback MMO server (same as combat-gear/equip).
  "/api/v1/vcs/combat-sigma": { methods: ["GET"], bodyFields: [...VIEWER_IDENTITY] },
  "/api/v1/vcs/combat-passive-tree": { methods: ["GET"], bodyFields: [] },
  "/api/v1/vcs/combat-passives": {
    methods: ["POST"],
    bodyFields: [...VIEWER_IDENTITY, "passives", "set"],
  },
  // Vampire Survivors weapon layer (bridge contract §8).
  // combat-weapon-catalog: static, no login (mirrors combat-passive-tree).
  // combat-weapons: GET is login-scoped (viewer identity only);
  //   POST adds "weapons" (string[]) + "set" (optional active-weapon id).
  "/api/v1/vcs/combat-weapon-catalog": { methods: ["GET"], bodyFields: [] },
  "/api/v1/vcs/combat-weapons": {
    methods: ["GET", "POST"],
    bodyFields: [...VIEWER_IDENTITY, "weapons", "set"],
  },
  "/api/v1/vcs/combat-reserve": {
    methods: ["POST"],
    bodyFields: [...VIEWER_IDENTITY, "reserved", "set"],
  },
  "/api/v1/vcs/combat-position": {
    methods: ["POST"],
    bodyFields: [...VIEWER_IDENTITY, "position", "set"],
  },
  "/api/v1/vcs/combat-swap-set": {
    methods: ["POST"],
    bodyFields: [...VIEWER_IDENTITY, "set"],
  },
  "/api/v1/vcs/equip": { methods: ["POST"], bodyFields: [...VIEWER_IDENTITY, "slot", "item_key"] },
  "/api/v1/vcs/unequip": { methods: ["POST"], bodyFields: [...VIEWER_IDENTITY, "slot"] },
  "/api/v1/vcs/buy": { methods: ["POST"], bodyFields: [...VIEWER_IDENTITY, "item_key"] },
  "/api/v1/vcs/color": { methods: ["POST"], bodyFields: [...VIEWER_IDENTITY, "slot", "hex"] },
  "/api/v1/vcs/hue": { methods: ["POST"], bodyFields: [...VIEWER_IDENTITY, "hue"] },
  "/api/v1/vcs/raw_slot": { methods: ["POST"], bodyFields: [...VIEWER_IDENTITY, "slot", "value"] },
  "/api/v1/vcs/body": { methods: ["POST"], bodyFields: [...VIEWER_IDENTITY, "body"] },
  "/api/v1/vcs/clear_body": { methods: ["POST"], bodyFields: [...VIEWER_IDENTITY] },
  "/api/v1/vcs/clear_raw_slot": { methods: ["POST"], bodyFields: [...VIEWER_IDENTITY, "slot"] },
};

function validateRpcRequest(rpc: unknown): RpcRequest | { error: string } {
  if (!rpc || typeof rpc !== "object") return { error: "rpc_not_object" };
  const r = rpc as Record<string, unknown>;
  const method = r.method;
  const path = r.path;
  if (method !== "GET" && method !== "POST") return { error: "rpc_invalid_method" };
  if (typeof path !== "string") return { error: "rpc_invalid_path" };
  const route = RPC_ROUTE_ALLOWLIST[path];
  if (!route) return { error: "rpc_route_not_allowlisted" };
  if (!route.methods.includes(method)) return { error: "rpc_method_not_allowed" };
  let body: Record<string, unknown> | undefined;
  if (r.body !== undefined) {
    if (typeof r.body !== "object" || r.body === null || Array.isArray(r.body)) {
      return { error: "rpc_body_not_object" };
    }
    body = r.body as Record<string, unknown>;
    if (route.bodyFields) {
      for (const key of Object.keys(body)) {
        if (!route.bodyFields.includes(key)) return { error: `rpc_body_unknown_field:${key}` };
      }
    }
  }
  return { method, path, body };
}

interface RpcReply {
  status: number;
  body: string;
}

interface PendingRpc {
  resolve: (reply: RpcReply) => void;
  timer: number;
}

const BRIDGE_TAG = "bridge";

export class VcsRoom extends DurableObject {
  private pending: Map<string, PendingRpc> = new Map();
  // 8s absorbs chat-elixir tail latency under load. The streamer-side bridge
  // proxies with a 4s fetch timeout, so this only fires when the bridge itself
  // is wedged or the WS round-trip is unhealthy — which is the orphan we want
  // to detect anyway.
  private rpcTimeoutMs = 8_000;

  override async fetch(request: Request): Promise<Response> {
    // VcsRoom is a hibernatable-WebSocket Durable Object. Right after a
    // deploy the runtime swaps the DO onto the new code while the streamer
    // bridge's socket is still held; a fresh /ws/bridge upgrade — or any
    // state call (getWebSockets / acceptWebSocket / new WebSocketPair) —
    // can throw during that window, sometimes as an Error with no message.
    // routes/bridge.ts swallows the throw on the *caller* side (commit
    // 523fcaba), but the DO's own invocation is independently recorded as
    // outcome:"exception" and surfaces in sigmashake-alerts as an "Uncaught
    // Error … (no message)" page. Catching it here completes the DO
    // invocation with a 503 instead: lib/dispatch.ts, routes/bridge.ts, and
    // the streamer bridge already treat any non-101 / 5xx as recoverable and
    // reconnect on the next tick. This also covers a malformed /dispatch
    // body (the unguarded request.json() below).
    try {
      return await this.handleFetch(request);
    } catch (err) {
      console.warn("[vcs-room] fetch aborted (recoverable, bridge will reconnect)", {
        path: new URL(request.url).pathname,
        name: err instanceof Error ? err.name : "non-error",
        message: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ ok: false, error: "do_unavailable" }, { status: 503 });
    }
  }

  private async handleFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws/bridge") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];

      // Single-bridge invariant: when a new bridge connects, evict any prior
      // sockets. Cloudflare can delay firing `close` for a dropped WS by tens
      // of seconds after the streamer-side socket has gone dead; without this
      // eviction the DO would dispatch through the older (stale) socket and
      // every RPC would time out (the bridge_timeout symptom from 2026-05-16).
      for (const stale of this.ctx.getWebSockets(BRIDGE_TAG)) {
        try {
          stale.close(1000, "superseded");
        } catch {
          /* ignore */
        }
      }
      this.drainPending("bridge_superseded");

      this.ctx.acceptWebSocket(server, [BRIDGE_TAG]);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/dispatch" && request.method === "POST") {
      const rawRpc = (await request.json()) as unknown;
      const validated = validateRpcRequest(rawRpc);
      if ("error" in validated) {
        return Response.json(
          { ok: false, error: "rpc_rejected", reason: validated.error },
          { status: 400 },
        );
      }
      const rpc: RpcRequest = validated;
      const sockets = this.ctx.getWebSockets(BRIDGE_TAG);
      if (sockets.length === 0) {
        return Response.json({ ok: false, error: "bridge_offline" }, { status: 503 });
      }

      // Prefer the most recently accepted socket whose readyState is OPEN. The
      // accept-time eviction above already enforces single-bridge, but the
      // readyState check is a belt-and-suspenders guard against a socket that
      // entered CLOSING between accept and dispatch.
      let ws: WebSocket | null = null;
      for (let i = sockets.length - 1; i >= 0; i--) {
        if (sockets[i].readyState === 1 /* OPEN */) {
          ws = sockets[i];
          break;
        }
      }
      if (!ws) {
        return Response.json({ ok: false, error: "bridge_offline" }, { status: 503 });
      }
      const reqId = crypto.randomUUID();
      const replyPromise = new Promise<RpcReply>((resolve) => {
        const timer = setTimeout(() => {
          if (this.pending.has(reqId)) {
            this.pending.delete(reqId);
            resolve({ status: 504, body: JSON.stringify({ ok: false, error: "bridge_timeout" }) });
          }
        }, this.rpcTimeoutMs) as unknown as number;
        this.pending.set(reqId, { resolve, timer });
      });

      try {
        ws.send(JSON.stringify({ type: "rpc", req_id: reqId, ...rpc }));
      } catch {
        this.pending.delete(reqId);
        return Response.json({ ok: false, error: "bridge_send_failed" }, { status: 502 });
      }

      const reply = await replyPromise;
      return new Response(reply.body, {
        status: reply.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/status") {
      const sockets = this.ctx.getWebSockets(BRIDGE_TAG);
      return Response.json({
        bridge_connected: sockets.length > 0,
        bridges: sockets.length,
        pending_rpcs: this.pending.size,
      });
    }

    return new Response("Not found", { status: 404 });
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== "string") return;
    let msg: { type?: string; req_id?: string; status?: number; body?: string; ts?: number };
    try {
      msg = JSON.parse(data) as typeof msg;
    } catch {
      return;
    }

    if (msg.type === "ping") {
      try {
        ws.send(JSON.stringify({ type: "pong", ts: msg.ts ?? 0 }));
      } catch {
        /* socket closing; bridge will reconnect */
      }
      return;
    }

    if (msg.type !== "rpc_reply" || !msg.req_id) return;

    const slot = this.pending.get(msg.req_id);
    if (!slot) return;

    clearTimeout(slot.timer);
    this.pending.delete(msg.req_id);
    slot.resolve({
      status: msg.status ?? 502,
      body: msg.body ?? '{"ok":false,"error":"empty_reply"}',
    });
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    // When the bridge drops, any in-flight RPCs are doomed — resolve them now
    // with a structured 502 instead of letting them stall the viewer fetch
    // until rpcTimeoutMs. Pending requests issued *after* the close land on
    // the bridge_offline path in /dispatch.
    this.drainPending("bridge_disconnected");
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }

  override async webSocketError(_ws: WebSocket, _err: unknown): Promise<void> {
    this.drainPending("bridge_error");
  }

  private drainPending(error: string): void {
    if (this.pending.size === 0) return;
    const body = JSON.stringify({ ok: false, error });
    for (const [reqId, slot] of this.pending) {
      clearTimeout(slot.timer);
      slot.resolve({ status: 502, body });
      this.pending.delete(reqId);
    }
  }
}
