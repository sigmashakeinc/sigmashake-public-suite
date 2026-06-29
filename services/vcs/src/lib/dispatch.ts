import type { Context } from "hono";
import type { HonoEnv } from "../index";

/**
 * Send one RPC to the streamer bridge via the per-broadcaster VcsRoom DO and
 * return its reply verbatim — status + JSON body pass straight through, since
 * chat-elixir owns the response schema.
 *
 * `path` and the `body` keys must be allowlisted in vcs-room.ts's
 * RPC_ROUTE_ALLOWLIST or the DO replies 400 rpc_rejected before the request
 * ever reaches the bridge. Both routes/viewer.ts (cookie-authed) and
 * routes/public.ts (API-key-authed) dispatch through here.
 */
export async function dispatchToBridge(
  c: Context<HonoEnv>,
  method: "GET" | "POST",
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const broadcasterId = c.env.TWITCH_BROADCASTER_ID ?? "default";
  const room = c.env.VCS_ROOM.get(c.env.VCS_ROOM.idFromName(broadcasterId));
  const dispatchRes = await room.fetch(
    new Request("http://do/dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, path, body }),
    }),
  );
  return new Response(await dispatchRes.text(), {
    status: dispatchRes.status,
    headers: { "Content-Type": "application/json" },
  });
}
