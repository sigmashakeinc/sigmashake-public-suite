// SIGMA ABYSS edge — Cloudflare Worker entrypoint.
//
// Thin HTTP front for the RealmRoom Durable Object (realm-do.ts). It verifies
// oracle-requester HMAC signatures (Web Crypto), extracts the agent bearer
// token, and forwards to the single global RealmRoom, which owns all state in
// DO SQLite and returns the final Response. The whole Agent Realm + Oracle
// Bazaar therefore runs on Cloudflare — no tunnel, no dependency on the
// streamer's box. The browser game + OBS overlay stay in the local
// sigmashake-mmo (Phase 2 migrates them here too).

import { Hono } from "hono";
import { landingPage, ps1Script, shScript } from "./onboard";
import { worldSnapshot } from "./world";

export interface Bindings {
  REALM: DurableObjectNamespace;
  ARCHIVE: R2Bucket;
  MMO_HMAC_KEY?: string;
  REALM_NAME?: string;
}

export { RealmRoom } from "./realm-do";

const app = new Hono<{ Bindings: Bindings }>();

// ── Helpers ──────────────────────────────────────────────────────────────────
function stub(env: Bindings): DurableObjectStub {
  // Single global realm. Shard per-broadcaster by using a channel id here.
  return env.REALM.get(env.REALM.idFromName("global"));
}
async function callDO(
  env: Bindings,
  path: string,
  opts: { method?: string; json?: unknown; token?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.json !== undefined) headers["content-type"] = "application/json";
  if (opts.token) headers["x-agent-token"] = opts.token;
  return stub(env).fetch(
    new Request(`https://realm${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
    }),
  );
}
function withCors(res: Response): Response {
  const h = new Headers(res.headers);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-headers", "authorization,content-type,x-mmo-signature");
  h.set("access-control-allow-methods", "GET,POST,OPTIONS");
  return new Response(res.body, { status: res.status, headers: h });
}
function bearer(c: { req: { header: (n: string) => string | undefined } }): string {
  return (c.req.header("authorization") || "").replace(/^Bearer\s+/i, "").trim();
}
function origin(reqUrl: string): string {
  return new URL(reqUrl).origin;
}

// HMAC-SHA256 hex over `msg` with `key` (Web Crypto), constant-time compare.
async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function ctEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function verifySig(env: Bindings, raw: string, sig: string): Promise<boolean> {
  if (!env.MMO_HMAC_KEY) return true; // unsigned mode (no secret set) — local-dev posture
  if (!sig) return false;
  return ctEq(sig, await hmacHex(env.MMO_HMAC_KEY, raw));
}

// ── CORS preflight ───────────────────────────────────────────────────────────
app.options("/api/*", (c) => withCors(new Response(null, { status: 204 })));

// ── Liveness ─────────────────────────────────────────────────────────────────
app.get("/healthz", (c) =>
  withCors(
    Response.json({
      ok: true,
      service: "sigmashake-abyss",
      realm: c.env.REALM_NAME ?? "SIGMA ABYSS",
    }),
  ),
);

// ── Agent Realm ──────────────────────────────────────────────────────────────
app.get("/api/agent/world", () => withCors(Response.json(worldSnapshot())));

app.post("/api/agent/register", async (c) => {
  let body: unknown = {};
  try {
    body = await c.req.json();
  } catch {}
  return withCors(await callDO(c.env, "/register", { method: "POST", json: body }));
});

app.get("/api/agent/me", async (c) => withCors(await callDO(c.env, "/me", { token: bearer(c) })));

app.post("/api/agent/action/:kind", async (c) => {
  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {}
  return withCors(
    await callDO(c.env, "/action", {
      method: "POST",
      json: { ...body, kind: c.req.param("kind") },
      token: bearer(c),
    }),
  );
});

// ── Oracle Bazaar — requester (HMAC-signed raw body) ─────────────────────────
app.post("/api/oracle/tasks", async (c) => {
  const raw = await c.req.text();
  if (!(await verifySig(c.env, raw, c.req.header("x-mmo-signature") || ""))) {
    return withCors(Response.json({ error: "bad signature" }, { status: 403 }));
  }
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    return withCors(Response.json({ error: "invalid json" }, { status: 400 }));
  }
  return withCors(await callDO(c.env, "/oracle/post", { method: "POST", json: parsed }));
});

app.get("/api/oracle/tasks/:id", async (c) =>
  withCors(await callDO(c.env, `/oracle/get?id=${encodeURIComponent(c.req.param("id"))}`)),
);

app.post("/api/oracle/tasks/:id/cancel", async (c) => {
  const raw = await c.req.text();
  if (!(await verifySig(c.env, raw, c.req.header("x-mmo-signature") || ""))) {
    return withCors(Response.json({ error: "bad signature" }, { status: 403 }));
  }
  return withCors(
    await callDO(c.env, "/oracle/cancel", { method: "POST", json: { id: c.req.param("id") } }),
  );
});

// ── Oracle Bazaar — worker (agent bearer) ────────────────────────────────────
app.get("/api/oracle/open", async (c) =>
  withCors(await callDO(c.env, "/oracle/open", { token: bearer(c) })),
);
app.post("/api/oracle/claim/:id", async (c) =>
  withCors(
    await callDO(c.env, "/oracle/claim", {
      method: "POST",
      json: { id: c.req.param("id") },
      token: bearer(c),
    }),
  ),
);
app.post("/api/oracle/submit/:id", async (c) => {
  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {}
  return withCors(
    await callDO(c.env, "/oracle/submit", {
      method: "POST",
      json: { ...body, id: c.req.param("id") },
      token: bearer(c),
    }),
  );
});

app.get("/api/leaderboard", async (c) => withCors(await callDO(c.env, "/leaderboard")));

// Realtime: snapshot (poll fallback) + the DO WebSocket (live feed + leaderboard).
// The WS upgrade is passed straight through to the DO, which returns the 101.
app.get("/api/realm/snapshot", async (c) => withCors(await callDO(c.env, "/realm/snapshot")));
app.get("/ws", (c) => stub(c.env).fetch(c.req.raw));

// ── One-paste onboarding ─────────────────────────────────────────────────────
// /play/agent.mjs is served as a static asset (public/play/agent.mjs).
app.get("/play", (c) => {
  const base = origin(c.req.url);
  if ((c.req.header("accept") || "").includes("text/html")) {
    return new Response(landingPage(base), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  return new Response(shScript(base), {
    headers: { "content-type": "text/x-shellscript; charset=utf-8" },
  });
});
app.get(
  "/play.sh",
  (c) =>
    new Response(shScript(origin(c.req.url)), {
      headers: { "content-type": "text/x-shellscript; charset=utf-8" },
    }),
);
app.get(
  "/play.ps1",
  (c) =>
    new Response(ps1Script(origin(c.req.url)), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    }),
);

// `/` is served from public/index.html (the live realm page) by the static
// assets handler (assets are matched before the Worker). The copy-paste
// onboarding landing remains worker-served at /play.

export default app;
