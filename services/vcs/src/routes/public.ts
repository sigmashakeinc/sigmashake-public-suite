import { Hono } from "hono";
import type { HonoEnv } from "../index";
import { requireApiKey } from "../lib/api-key";
import { dispatchToBridge } from "../lib/dispatch";
import { buildOpenApiSpec } from "../lib/openapi";

/**
 * VCS public API — token-authed, read-only access for third-party
 * integrations. Distinct from the cookie-authed viewer routes in viewer.ts:
 *
 *   - auth is a bearer API key (Authorization: Bearer sk_vcs_…), not a session
 *   - the caller names the chatter explicitly via the {twitch_login} path param
 *   - only GET / read paths are exposed — mutations stay viewer-only for v1
 *
 * openapi.json + the Swagger UI are unauthenticated (discovery); every
 * /api/public/v1/* data route requires a key carrying the "read" scope.
 */

const publicApi = new Hono<HonoEnv>();

const SWAGGER_UI_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SigmaShake VCS Public API</title>
    <link
      rel="stylesheet"
      href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui.css"
    />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script
      src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"
      crossorigin
    ></script>
    <script>
      window.ui = SwaggerUIBundle({ url: "/api/public/openapi.json", dom_id: "#swagger-ui" });
    </script>
  </body>
</html>
`;

/**
 * Twitch logins are 1–25 chars of [a-z0-9_]. Lowercase + validate so a caller
 * can't smuggle stray characters into the RPC body. Returns null when invalid.
 */
function normalizeLogin(raw: string | undefined): string | null {
  if (!raw) return null;
  const login = raw.toLowerCase();
  return /^[a-z0-9_]{1,25}$/.test(login) ? login : null;
}

// ── Discovery (no auth) ───────────────────────────────────────────────────────

publicApi.get("/api/public/openapi.json", (c) =>
  c.json(buildOpenApiSpec(new URL(c.req.url).origin)),
);

publicApi.get("/api/public/docs", (c) => c.html(SWAGGER_UI_HTML));

// ── Data routes — bearer API key required, read-only ──────────────────────────

publicApi.get("/api/public/v1/character/:login", async (c) => {
  const auth = await requireApiKey(c, "read");
  if (!auth.ok) return c.json({ ok: false, error: auth.error }, auth.status);

  const login = normalizeLogin(c.req.param("login"));
  if (!login) return c.json({ ok: false, error: "invalid_twitch_login" }, 400);

  return dispatchToBridge(c, "GET", "/api/v1/vcs/me", { twitch_login: login });
});

publicApi.get("/api/public/v1/character/:login/combat-gear", async (c) => {
  const auth = await requireApiKey(c, "read");
  if (!auth.ok) return c.json({ ok: false, error: auth.error }, auth.status);

  const login = normalizeLogin(c.req.param("login"));
  if (!login) return c.json({ ok: false, error: "invalid_twitch_login" }, 400);

  return dispatchToBridge(c, "GET", "/api/v1/vcs/combat-gear", { twitch_login: login });
});

publicApi.get("/api/public/v1/catalog", async (c) => {
  const auth = await requireApiKey(c, "read");
  if (!auth.ok) return c.json({ ok: false, error: auth.error }, auth.status);

  return dispatchToBridge(c, "GET", "/api/v1/vcs/catalog", {});
});

export default publicApi;
