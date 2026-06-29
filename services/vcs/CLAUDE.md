# sigmashake-vcs — Agent Guide

Standalone web app at `vcs.sigmashake.com` for the Vibe Coder Sim
character builder. Cloudflare Worker fronting an HMAC-authed
WebSocket bridge to chat-elixir on the streamer box, with a
per-broadcaster `VcsRoom` Durable Object owning live state.

See `README.md` for the architecture diagram. This file is for working
in the project.

> History: This shipped as a Twitch Extension panel first. Twitch's
> Extension service was broken so we pivoted to a website signed in
> via `sigmashake-accounts`. The DO+bridge+chat-elixir surface stayed
> the same; only the auth/UI shell changed.

## Commands

```sh
bun install
bun run dev          # wrangler dev — local Worker + static assets
bun run typecheck    # tsc --noEmit
bun run deploy       # bash ../shared/agent-config/scripts/deploy-guarded.sh
bun run clean        # node-based rm-rf (hook-safe equivalent)
```

## HTTP API

The Worker exposes several route groups. Cookie-authed routes require a `session_id` cookie from `sigmashake-accounts`. Public-API routes require `Authorization: Bearer sk_vcs_…`.

### Public (no auth)

- `GET /healthz` — liveness probe; returns `{"ok":true,"service":"sigmashake-vcs"}`.
- `GET /api/public/openapi.json` — OpenAPI 3.0 spec for the public API.
- `GET /api/public/docs` — Swagger UI.
- `GET /` — Static SPA (index.html).

### Cookie-authed viewer endpoints (session_id cookie; Twitch / Kick / Google login)

- `GET /api/v1/vcs/whoami` — Resolve session cookie → viewer identity without hitting the bridge. Returns the generic identity envelope `{"ok":true,"source":"twitch|kick|google","login":"...","user_id":"...","display":"..."}` plus back-compat mirrors `twitch_login`/`twitch_display`/`twitch_user_id` (set to the resolved login/display/id regardless of provider).
- `GET /api/v1/vcs/me` — Full VCS character loadout for the signed-in viewer (bridged to chat-elixir).
- `GET /api/v1/vcs/catalog` — Item catalog (read-only, bridges to chat-elixir).
- `GET /api/v1/vcs/combat-gear` — MMO sigma loadout for the viewer (bridges to sigmashake-mmo at 127.0.0.1:7777).
- `POST /api/v1/vcs/equip` — Equip an item. Body: `{"slot":"...","item_key":"..."}`.
- `POST /api/v1/vcs/unequip` — Unequip a slot. Body: `{"slot":"..."}`.
- `POST /api/v1/vcs/buy` — Buy an item from the catalog. Body: `{"item_key":"..."}`.
- `POST /api/v1/vcs/color` — Set a slot color. Body: `{"slot":"...","hex":"#rrggbb"}`.
- `POST /api/v1/vcs/hue` — Set hue override. Body: `{"hue":"..."}`.
- `POST /api/v1/vcs/raw_slot` — Raw slot write. Body: `{"slot":"...","value":"..."}`.
- `POST /api/v1/vcs/body` — Set body type. Body: `{"body":"..."}`.
- `POST /api/v1/vcs/clear_body` — Clear body override. No body required.
- `POST /api/v1/vcs/clear_raw_slot` — Clear a raw slot. Body: `{"slot":"..."}`.

### Streamer bridge (HMAC auth)

- `GET /ws/streamer` — WebSocket upgrade (streamer-side bridge). Auth via `X-Vcs-Signature` + `X-Vcs-Timestamp` HMAC headers.
- `GET /api/v1/vcs/bridge/status` — Bridge connection status for the broadcaster's VcsRoom DO.

### Public API (bearer API key, read-only)

- `GET /api/public/v1/character/:login` — Get VCS character for a named Twitch login. Key must carry `read` scope.
- `GET /api/public/v1/character/:login/combat-gear` — Get MMO gear for a named Twitch login. Key must carry `read` scope.
- `GET /api/public/v1/catalog` — Full item catalog. Key must carry `read` scope.

## Agent CLI

`tools/vcs-cli.ts` is a zero-dependency headless control surface over the deployed Worker, exposed as the `sigmashake-vcs` bin.

| Subcommand | Purpose |
|---|---|
| `sigmashake-vcs health` | `GET /healthz` |
| `sigmashake-vcs bridge-status` | `GET /api/v1/vcs/bridge/status` |
| `sigmashake-vcs catalog` | `GET /api/public/v1/catalog` (requires API key) |
| `sigmashake-vcs character <login>` | `GET /api/public/v1/character/:login` |
| `sigmashake-vcs --help` | Usage |

Config via env: `VCS_BASE_URL` (default `https://vcs.sigmashake.com`), `VCS_API_KEY` (bearer key with `read` scope, required for catalog/character commands).

## Agent MCP server

`tools/vcs-mcp.ts` is a stdio MCP server (Model Context Protocol) that exposes the deployed
Vibe Coder Sim Worker as typed tools an AI agent can call directly.

Run it:

```
bun tools/vcs-mcp.ts
```

Register with Claude Code:

```
claude mcp add sigmashake-vcs -- bun tools/vcs-mcp.ts
```

| Tool | Description |
|---|---|
| `vcs_health` | Liveness probe — `GET /healthz`. |
| `vcs_bridge_status` | Streamer bridge connection status — `GET /api/v1/vcs/bridge/status`. |
| `vcs_catalog` | Full item catalog — `GET /api/public/v1/catalog`. |
| `vcs_character` | Character loadout by Twitch login — `GET /api/public/v1/character/:login`. |

Config via env: `VCS_BASE_URL` (default `https://vcs.sigmashake.com`),
`VCS_API_KEY` (required for `vcs_catalog` and `vcs_character`).

Deployment is race-gated via `deploy-guarded.sh` — same rule as the
other workers. Commit + push first, then deploy. See the parent
`CLAUDE.md` `<deploys>` block.

## Layout

```
src/
  index.ts             Hono entry — CORS, route mounting, asset fallback
  vcs-room.ts          Per-broadcaster Durable Object (WS hub + RPC routing)
  lib/
    session.ts         Read-only port of sigmashake-accounts session decrypt
    auth.ts            session_id cookie → ViewerContext (twitch_login etc.)
    hmac.ts            HMAC-SHA-256 sign/verify for the streamer handshake
  routes/
    viewer.ts          Cookie-authed viewer endpoints (/api/v1/vcs/*)
    bridge.ts          Streamer WS endpoint (/ws/streamer + bridge status)
static/
  index.html           Landing + builder UI (single page; sign-in inline)
  panel.js             Vanilla-DOM client; state machine + DOM ops
  panel.css            CSS — Twitch-style dark theme
wrangler.toml          DO + KV + secrets + routes
package.json           Hono only; tsc + wrangler dev-deps
tsconfig.json          ES2022 strict, no emit
```

## Key invariants

* **chat-elixir is loopback-only.** All writes go through the streamer-
  side `vcs-bridge.ts` (in `sigmashake-obs/src/lib/`). The worker
  *never* dials chat-elixir directly — it sends RPCs over a WS the
  bridge initiated.
* **Session cookie only — no JWT.** The viewer signs in via
  `sigmashake-accounts`, gets a `session_id` cookie on `.sigmashake.com`,
  and we decrypt it via the shared `SESSIONS` KV + `ENCRYPTION_KEY`
  secret. Vcs never touches the Twitch OAuth flow directly.
* **Twitch / Kick / Google sessions accepted.** `resolveViewer()`
  (`src/lib/auth.ts`) maps each supported provider to a generic identity
  `{source, login, user_id, display}` derived **only** from the decrypted
  session — never a client body field. `twitch` → `twitchLogin`/`login`;
  `kick` → `login` (channel slug); `google` → `login` (email). Every other
  `authType` (github/saml/oidc/microsoft/apple) is rejected (401). The login
  keys the chatter row in chat-elixir via `(source, author_login)`; the
  Worker sends `source` + `login` (+ back-compat `twitch_*` mirrors) and
  chat-elixir's `vcs_extension_controller` resolves the chatter per-source
  (an absent `source` defaults to `twitch`; an unknown one is rejected
  `bad_source`).
* **DO state is in-memory, not persisted.** `pending` map for in-
  flight RPCs lives in the DO instance only. An eviction drops them;
  the page times out and retries. This is intentional — see
  `vcs-room.ts` moduledoc.
* **Renderer fallback for missing body row.** If a chatter never
  touched the builder, `loadout.body` is absent and `cosmetics.js`
  falls back to dress-driven detection. Same visuals as before the
  builder shipped — no regression.

## Wire protocol

The DO ↔ bridge protocol is plain JSON over text WS frames:

```jsonc
// Worker → bridge:
{"type":"rpc","req_id":"<uuid>","method":"GET","path":"/api/v1/vcs/me","body":{"twitch_login":"alice"}}

// bridge → Worker (the chat-elixir response, verbatim):
{"type":"rpc_reply","req_id":"<uuid>","status":200,"body":"{\"ok\":true,\"loadout\":{...}}"}
```

GET bodies become query strings on the bridge side. POST bodies are
JSON-marshalled into the chat-elixir request body.

## Sign-in flow

The page calls `GET /api/v1/vcs/me` on load:

* `200` → render the builder.
* `401` → render the sign-in prompt with three buttons — **Twitch**, **Kick**,
  and **Google** — each linking to
  `https://accounts.sigmashake.com/auth/<provider>?return_to=<vcs origin>/`
  (`provider` ∈ `twitch|kick|google`). Accounts runs that provider's OAuth
  round-trip and 302s back with the cookie set. Twitch + Kick are turnstile-free
  "audience" logins; Google's accounts handler fails-open on turnstile for a
  first-party `*.sigmashake.com` `return_to`, so the direct deep-link works
  regardless of whether `TURNSTILE_SECRET_KEY` is provisioned.

## Common pitfalls

* **`credentials: 'include'` is required** on every fetch from the
  page, including same-origin ones. Without it, the cookie isn't sent
  in some browser configurations (and `wrangler dev` against the
  deployed worker is technically cross-origin).
* **Cookie domain is `.sigmashake.com`.** If you test locally on
  `localhost:8787`, the cookie set by `accounts.sigmashake.com` won't
  reach you. Use a real subdomain in `wrangler dev` (`--port 8787 +
  CNAME entry`) or stub the session via `wrangler kv`.
* **Worker `[assets]` directory binding caches aggressively.** Edit
  + redeploy when you touch `index.html` / `panel.js` / `panel.css`.
  Test in incognito or hard-reload.
* **Secrets Store binding name vs. secret name** — the binding
  (`ENCRYPTION_KEY`, `VCS_HMAC_KEY`) is what the code references; the
  name in the store (`ENCRYPTION_KEY__prod`, `VCS_HMAC_KEY__prod`) is
  the one you `wrangler secret put`.
