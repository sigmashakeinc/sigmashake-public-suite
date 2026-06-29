// VCS disaster-recovery test — bridge drop must drain in-flight RPCs.
//
// The DR contract for VcsRoom: when the streamer-side bridge WebSocket
// disconnects mid-flight (process crash, network partition, deploy reset),
// every pending `/dispatch` promise MUST resolve immediately with a 502
// instead of stalling viewer fetches until rpcTimeoutMs. This is the only
// recovery path — the DO's `pending` map is in-memory only, so a hung
// promise would paper over real bridge loss and time out the viewer page.
//
// We test the contract directly against the public `webSocketClose` /
// `webSocketError` hooks the DO runtime invokes on disconnect. Bridge
// re-attach after drain is also exercised — the room must accept a new
// `/ws/bridge` upgrade and dispatch through it cleanly.

import { describe, expect, mock, test } from "bun:test";

// Match the existing vcs-room.test.ts pattern: stub `cloudflare:workers`
// before importing the module so the DurableObject base class is a no-op.
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

const { VcsRoom } = await import("../../src/vcs-room");

interface FakeWs {
  readyState: number;
  closeCalls: number;
  sent: string[];
  close: (code?: number, reason?: string) => void;
  send: (data: string) => void;
}

function makeFakeWs(): FakeWs {
  const ws: FakeWs = {
    readyState: 1, // OPEN
    closeCalls: 0,
    sent: [],
    close(_code?: number, _reason?: string) {
      this.closeCalls += 1;
      this.readyState = 3; // CLOSED
    },
    send(data: string) {
      this.sent.push(data);
    },
  };
  return ws;
}

/** Construct a VcsRoom over an in-memory fake `DurableObjectState`. */
function makeRoom(): {
  room: InstanceType<typeof VcsRoom>;
  ctx: Record<string, unknown>;
  sockets: FakeWs[];
} {
  const sockets: FakeWs[] = [];
  const ctx = {
    getWebSockets: (_tag?: string) => sockets as unknown[],
    acceptWebSocket: (ws: unknown, _tags?: string[]) => {
      sockets.push(ws as FakeWs);
    },
  };
  const room = new VcsRoom(ctx as never, {} as never);
  return { room, ctx, sockets };
}

describe("VcsRoom DR — bridge disconnect drains pending RPCs", () => {
  test("webSocketClose resolves every pending RPC with a 502", async () => {
    const { room, sockets } = makeRoom();

    // Simulate bridge accept: a socket exists in the WSs list.
    const bridge = makeFakeWs();
    sockets.push(bridge);

    // Kick off a /dispatch — it'll register a pending RPC and await reply.
    const dispatchPromise = room.fetch(
      new Request("http://do/dispatch", {
        method: "POST",
        body: JSON.stringify({
          method: "GET",
          path: "/api/v1/vcs/me",
          body: { twitch_login: "alice" },
        }),
      }),
    );

    // Yield once so the dispatch handler can set up its pending entry +
    // call ws.send before we drop the bridge.
    await new Promise((r) => setTimeout(r, 0));
    expect(bridge.sent.length).toBe(1);

    // Status should now show 1 pending RPC.
    const statusBefore = (await (await room.fetch(new Request("http://do/status"))).json()) as {
      pending_rpcs: number;
    };
    expect(statusBefore.pending_rpcs).toBe(1);

    // Bridge drops. Drain MUST resolve the dispatch promise with a 502.
    await room.webSocketClose(bridge as unknown as WebSocket);

    const reply = await dispatchPromise;
    expect(reply.status).toBe(502);
    const body = (await reply.json()) as { ok: boolean; error: string };
    expect(body).toEqual({ ok: false, error: "bridge_disconnected" });

    // Status should now show 0 pending.
    const statusAfter = (await (await room.fetch(new Request("http://do/status"))).json()) as {
      pending_rpcs: number;
    };
    expect(statusAfter.pending_rpcs).toBe(0);
  });

  test("webSocketError drains pending with bridge_error", async () => {
    const { room, sockets } = makeRoom();
    const bridge = makeFakeWs();
    sockets.push(bridge);

    const dispatchPromise = room.fetch(
      new Request("http://do/dispatch", {
        method: "POST",
        body: JSON.stringify({
          method: "GET",
          path: "/api/v1/vcs/catalog",
        }),
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    await room.webSocketError(bridge as unknown as WebSocket, new Error("net drop"));

    const reply = await dispatchPromise;
    expect(reply.status).toBe(502);
    const body = (await reply.json()) as { ok: boolean; error: string };
    expect(body.error).toBe("bridge_error");
  });

  test("drain is a no-op when no RPCs are pending", async () => {
    const { room, sockets } = makeRoom();
    const bridge = makeFakeWs();
    sockets.push(bridge);
    // No dispatch fired — close the bridge. Should not throw.
    await room.webSocketClose(bridge as unknown as WebSocket);
    // /status reports 0 pending.
    const status = (await (await room.fetch(new Request("http://do/status"))).json()) as {
      pending_rpcs: number;
    };
    expect(status.pending_rpcs).toBe(0);
  });
});

describe("VcsRoom DR — drain semantics", () => {
  test("/dispatch rejects with 503 when no bridge is connected", async () => {
    // The post-disconnect steady-state: until a new bridge attaches, viewer
    // requests must fail fast with bridge_offline rather than hang.
    const { room } = makeRoom();
    const res = await room.fetch(
      new Request("http://do/dispatch", {
        method: "POST",
        body: JSON.stringify({
          method: "GET",
          path: "/api/v1/vcs/me",
          body: { twitch_login: "x" },
        }),
      }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.error).toBe("bridge_offline");
  });

  test("/status survives between bridge sessions (DR steady-state)", async () => {
    // /status MUST keep serving 200 even with zero bridges — the operator
    // dashboard polls it to detect outage and trigger reconnect.
    const { room } = makeRoom();
    const res = await room.fetch(new Request("http://do/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bridge_connected: boolean;
      bridges: number;
      pending_rpcs: number;
    };
    expect(body).toEqual({ bridge_connected: false, bridges: 0, pending_rpcs: 0 });
  });
});
