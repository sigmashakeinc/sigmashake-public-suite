import { Hono } from "hono";
import type { HonoEnv } from "../index";
import { verifyHmac } from "../lib/hmac";
import { resolveVaultSecret } from "../lib/vault-secret";

const bridge = new Hono<HonoEnv>();

/**
 * Streamer's `vcs-bridge.ts` connects here.
 *
 * Auth: X-Vcs-Signature header is HMAC-SHA-256 over the literal string
 * `timestamp:<unix_seconds>`, with X-Vcs-Timestamp carrying the same
 * timestamp. Must be within ±30s of server clock to prevent replay.
 *
 * On successful auth we hand off the WS to the per-broadcaster VcsRoom
 * DO, which holds it open and uses it to dispatch viewer RPCs.
 */
bridge.get("/ws/streamer", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("Expected websocket", 426);
  }

  const hmacKey = (await resolveVaultSecret(c.env, "VCS_HMAC_KEY", c.env.VCS_HMAC_KEY)) || null;
  if (!hmacKey) return c.text("not_configured", 503);

  const sig = c.req.header("X-Vcs-Signature") ?? "";
  const tsStr = c.req.header("X-Vcs-Timestamp") ?? "";
  const ts = parseInt(tsStr, 10);

  if (!tsStr || Number.isNaN(ts) || Math.abs(Date.now() / 1000 - ts) > 30) {
    return c.text("timestamp_invalid", 401);
  }
  if (!(await verifyHmac(`timestamp:${ts}`, sig, hmacKey))) {
    return c.text("invalid_signature", 401);
  }

  const broadcasterId = c.env.TWITCH_BROADCASTER_ID ?? "default";
  const room = c.env.VCS_ROOM.get(c.env.VCS_ROOM.idFromName(broadcasterId));
  try {
    return await room.fetch(
      new Request("http://do/ws/bridge", {
        headers: c.req.raw.headers,
      }),
    );
  } catch (err) {
    // Right after a deploy the DO is bound to the new script version but the
    // bridge's *previous* WS is still held by an old-version instance until
    // Cloudflare GC's it. A fresh /ws/streamer upgrade against that instance
    // throws — most commonly with the literal "This script has been upgraded…"
    // message, but the runtime also emits other variants (sometimes an Error
    // with no message at all, which surfaced in sigmashake-alerts as
    // "Uncaught Error: (no message)" against /ws/bridge after the 2026-05-16
    // deploy). The bridge's reconnect loop retries on the next tick and lands
    // on the new instance regardless, so any failure here is recoverable —
    // swallow, console.warn for tail visibility, and 503 without raising an
    // uncaught-exception alert.
    const name = err instanceof Error ? err.name : "non-error";
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[vcs] bridge upgrade failed (recoverable, bridge will reconnect)", {
      name,
      message,
    });
    return c.text("bridge_unavailable", 503);
  }
});

bridge.get("/api/v1/vcs/bridge/status", async (c) => {
  const broadcasterId = c.env.TWITCH_BROADCASTER_ID ?? "default";
  const room = c.env.VCS_ROOM.get(c.env.VCS_ROOM.idFromName(broadcasterId));
  const statusRes = await room.fetch(new Request("http://do/status"));
  return new Response(await statusRes.text(), {
    status: statusRes.status,
    headers: { "Content-Type": "application/json" },
  });
});

export default bridge;
