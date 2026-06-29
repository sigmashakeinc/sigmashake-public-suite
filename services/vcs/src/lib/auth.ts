import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { HonoEnv } from "../index";
import { getSession } from "./session";
import { resolveVaultSecret } from "./vault-secret";

export type ViewerSource = "twitch" | "kick" | "google";

export interface ViewerContext {
  source: ViewerSource;
  login: string; // lowercased platform login (twitch login | kick slug | google email)
  user_id: string; // platform id (twitch:/kick: numeric, google: google id)
  display: string;
  // back-compat mirrors (always set to the same values) — an un-updated
  // bridge/controller keeps working for Twitch users mid-rollout.
  twitch_user_id: string;
  twitch_login: string;
  twitch_display: string;
}

/**
 * Resolve a ViewerContext from the sigmashake-accounts session cookie
 * (`session_id`, set on `.sigmashake.com` by accounts.sigmashake.com
 * after the user completes an OAuth flow).
 *
 * VCS accepts twitch / kick / google sessions. The login is ALWAYS derived
 * from the decrypted session — NEVER from a client-supplied body field.
 *
 * Returns null on any failure — missing cookie, unknown session, key
 * rotation, unsupported auth provider (github/saml/oidc/microsoft/apple),
 * malformed session payload. The caller returns 401 in that case; we never
 * let a session-resolution exception bubble out to a 500.
 */
export async function resolveViewer(c: Context<HonoEnv>): Promise<ViewerContext | null> {
  try {
    const cookie = getCookie(c, "session_id");
    if (!cookie || typeof cookie !== "string") return null;

    const encKey =
      (await resolveVaultSecret(c.env, "ENCRYPTION_KEY", c.env.ENCRYPTION_KEY)) || undefined;
    const session = await getSession(c.env.SESSIONS, cookie, encKey);
    if (!session) return null;

    // The login is derived exclusively from the decrypted session. Each
    // supported provider stores its login differently:
    //   twitch → twitchLogin (or login when authType==="twitch"); userId "twitch:<id>"
    //   kick   → login (channel slug);                            userId "kick:<id>"
    //   google → login (email);                                   userId "google:<id>"
    // Everything else (github/saml/oidc/microsoft/apple) is rejected.
    const authType = session.authType;
    const rawUserId = typeof session.userId === "string" ? session.userId : "";

    let source: ViewerSource | null = null;
    let login = "";
    let id = "";

    if (authType === "twitch" || (session.twitchLogin && !authType)) {
      source = "twitch";
      login = (session.twitchLogin ?? session.login ?? "").toLowerCase();
      id = rawUserId.startsWith("twitch:") ? rawUserId.slice(7) : rawUserId;
    } else if (authType === "kick") {
      source = "kick";
      login = (session.login ?? "").toLowerCase();
      id = rawUserId.startsWith("kick:") ? rawUserId.slice(5) : rawUserId;
    } else if (authType === "google") {
      source = "google";
      login = (session.login ?? "").toLowerCase(); // email
      id = rawUserId.startsWith("google:") ? rawUserId.slice(7) : rawUserId;
    } else {
      // github/saml/oidc/microsoft/apple not accepted by VCS.
      return null;
    }

    if (!login || !id) return null;

    return {
      source,
      login,
      user_id: id,
      display: login,
      twitch_user_id: id,
      twitch_login: login,
      twitch_display: login,
    };
  } catch (err) {
    // KV outage, secret-store hiccup, malformed cipher: degrade to 401.
    // Logged so a real bug doesn't hide silently in the tail.
    console.error("[vcs] resolveViewer threw", {
      err: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return null;
  }
}
