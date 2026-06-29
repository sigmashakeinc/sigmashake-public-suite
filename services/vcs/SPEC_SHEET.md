# sigmashake-vcs Public Spec Sheet

Last reviewed: 2026-06-28

This sheet is for collaborators adding features to the public
`sigmashake-vcs` mirror. It describes the public codebase shape, stable
contracts, extension points, and contribution gates. The deeper operational
runbook remains in `README.md`, `RUNBOOK.md`, and `CLAUDE.md`.

## Product Summary

`sigmashake-vcs` is the Vibe Coder Sim character builder at
`https://vcs.sigmashake.com`.

Viewers sign in with the shared `sigmashake-accounts` session cookie, customize
their on-stream avatar, and optionally change MMO-related sigma gear/build
settings. The Cloudflare Worker is the public edge. Actual persisted character
and inventory data is owned by private backend services reached through the
streamer-side bridge.

## Public Mirror Scope

The public mirror is a sanitized snapshot. It is intended for feature work on
the public Worker, UI, API client tools, tests, and static assets.

Included:

- `src/` - Cloudflare Worker, Hono routes, Durable Object, auth/dispatch helpers.
- `static/` - single-page UI, CSS, browser JS, and bundled public assets.
- `tools/` - CLI and MCP helper surfaces for agents and operators.
- `test/` - Bun tests covering routes, auth, bridge dispatch, public API, and
  reliability scenarios.
- `README.md`, `RUNBOOK.md`, `CLAUDE.md`, `SPEC_SHEET.md`, `openapi.yaml`,
  `wrangler.example.toml`, `tsconfig*.json`, `package.json`, and license files.

Excluded or scrubbed:

- Real Cloudflare namespace IDs, service bindings, secrets, and production-only
  on-call/privacy docs.
- `.wrangler/`, `node_modules/`, `dist/`, local `.sigmashake/` files.
- Real deployment guard wiring; the mirror's `package.json` deploy script is
  transformed to plain `wrangler deploy`.

## Runtime Stack

- Runtime: Cloudflare Workers.
- Framework: Hono.
- Stateful edge component: hibernatable Cloudflare Durable Object `VcsRoom`.
- Package manager/test runner: Bun.
- Static frontend: vanilla HTML/CSS/JavaScript. No frontend framework.
- Public API docs: generated OpenAPI JSON from `src/lib/openapi.ts`; the root
  `openapi.yaml` is only a stub baseline.
- Deployed host: `vcs.sigmashake.com`.

## Architecture

```text
Viewer browser
  -> Cloudflare Worker (Hono app)
  -> VcsRoom Durable Object
  -> WebSocket RPC to streamer-side vcs bridge
  -> private loopback services on the streamer box
  -> chat-elixir / MMO data stores
```

Key files:

- `src/index.ts` mounts route groups, CORS, health, static asset fallback, and
  top-level error handling.
- `src/routes/viewer.ts` owns cookie-authenticated viewer routes.
- `src/routes/public.ts` owns bearer-key public API routes.
- `src/routes/bridge.ts` owns streamer WebSocket auth and bridge status.
- `src/vcs-room.ts` owns WebSocket state, RPC allowlisting, dispatch, timeouts,
  and bridge disconnect handling.
- `src/lib/auth.ts` resolves the `session_id` cookie into a generic viewer
  identity.
- `src/lib/api-key.ts` validates public API bearer keys.
- `src/lib/dispatch.ts` sends Worker route calls to the Durable Object.
- `static/panel.js` owns the SPA state machine and all viewer UI calls.

## Auth And Trust Boundaries

Viewer UI:

- Uses `session_id` from `.sigmashake.com`, written by `sigmashake-accounts`.
- `resolveViewer()` accepts Twitch, Kick, and Google sessions.
- The Worker derives `source`, `login`, `user_id`, and `display` only from the
  decrypted session. Do not trust a client-supplied login for viewer mutations.
- Back-compat `twitch_*` mirror fields are still sent on bridged RPCs.

Public API:

- Uses `Authorization: Bearer sk_vcs_*`.
- Keys are stored as `sha256(token) -> { owner, scopes, created }` in
  `VCS_API_KEYS`.
- Public API v1 is read-only. Do not add public mutations without an explicit
  product/security review.
- `POST /api/v1/vcs/brains/tick` is viewer-session only. Keep it off the
  public bearer-key/OpenAPI surface unless the product explicitly introduces a
  public auth model for it.
- OBS browser-source brain ticks are loopback-only and must carry a
  `VCS_BRAIN_LOCAL_TOKEN` HMAC over `<source>:<login>` so the local overlay
  server cannot be used to spoof arbitrary character identities.

Streamer bridge:

- The bridge connects inbound to `GET /ws/streamer`.
- The Worker verifies `X-Vcs-Timestamp` and `X-Vcs-Signature`.
- Signature body is the literal string `timestamp:<unix_seconds>`.
- Timestamp must be within 30 seconds.
- After auth, the request is handed to the broadcaster's `VcsRoom`.

Durable Object:

- `VcsRoom` is the only component that can forward RPCs to the bridge.
- `RPC_ROUTE_ALLOWLIST` rejects unknown paths, methods, and body fields before
  they reach private services.
- In-flight RPC state is in memory only. Eviction or bridge loss resolves
  requests with structured errors instead of persistence/replay.

## HTTP Surface

Public unauthenticated:

- `GET /healthz` - liveness.
- `GET /api/public/openapi.json` - generated OpenAPI 3.1 public API spec.
- `GET /api/public/docs` - Swagger UI.
- Static assets under `/`.

Public API, bearer key required, read-only:

- `GET /api/public/v1/catalog`
- `GET /api/public/v1/character/:login`
- `GET /api/public/v1/character/:login/combat-gear`

Cookie-authenticated viewer API:

- `GET /api/v1/vcs/whoami`
- `GET /api/v1/vcs/me`
- `POST /api/v1/vcs/brains/tick`
- `GET /api/v1/vcs/catalog`
- `GET /api/v1/vcs/combat-gear`
- `GET /api/v1/vcs/combat-loadout`
- `GET /api/v1/vcs/combat-sigma`
- `GET /api/v1/vcs/combat-passive-tree`
- `GET /api/v1/vcs/combat-weapon-catalog`
- `GET /api/v1/vcs/combat-weapons`
- `POST /api/v1/vcs/combat-equip`
- `POST /api/v1/vcs/combat-passives`
- `POST /api/v1/vcs/combat-weapons`
- `POST /api/v1/vcs/combat-reserve`
- `POST /api/v1/vcs/combat-position`
- `POST /api/v1/vcs/combat-swap-set`
- `POST /api/v1/vcs/equip`
- `POST /api/v1/vcs/unequip`
- `POST /api/v1/vcs/buy`
- `POST /api/v1/vcs/color`
- `POST /api/v1/vcs/hue`
- `POST /api/v1/vcs/raw_slot`
- `POST /api/v1/vcs/body`
- `POST /api/v1/vcs/clear_body`
- `POST /api/v1/vcs/clear_raw_slot`

Bridge:

- `GET /ws/streamer`
- `GET /api/v1/vcs/bridge/status`

## Wire Protocol

The DO-to-bridge protocol is JSON over WebSocket text frames.

Worker to bridge:

```json
{
  "type": "rpc",
  "req_id": "<uuid>",
  "method": "GET",
  "path": "/api/v1/vcs/me",
  "body": {
    "twitch_login": "alice"
  }
}
```

Bridge to Worker:

```json
{
  "type": "rpc_reply",
  "req_id": "<same uuid>",
  "status": 200,
  "body": "{\"ok\":true,\"loadout\":{}}"
}
```

Heartbeat:

- Bridge sends `{ "type": "ping", "ts": <number> }`.
- Worker replies `{ "type": "pong", "ts": <same number> }`.

## Data Contracts

Important rule: bridged response schemas are owned by the private backend. The
Worker generally passes bridge responses through unchanged.

Stable Worker-side envelopes:

- Errors use JSON with `ok: false` and a machine-readable `error` string.
- `whoami` returns `ok: true`, generic identity fields, and `twitch_*`
  back-compat mirrors.
- `POST /api/v1/vcs/brains/tick` forwards the canonical viewer envelope plus
  only these optional fields when present: `scene`, `stimulus`, `mood`,
  `nearby`, `image_data_url`.
- The local OBS `/api/vcs/brains/tick` endpoint mirrors that optional-field
  allowlist and rejects missing/invalid signed Garden pet tokens before calling
  Cerebras.
- Public API auth failures are:
  - `503 api_not_configured`
  - `401 missing_api_key`
  - `401 invalid_api_key`
  - `403 insufficient_scope`
- Bridge availability failures include:
  - `503 bridge_offline`
  - `504 bridge_timeout`
  - `502 bridge_disconnected`
  - `502 bridge_error`

## Frontend Contract

The UI is a single static app:

- `static/index.html` defines all markup.
- `static/panel.css` defines the page styling.
- `static/panel.js` performs all state management and network calls.
- `static/assets/js/vibe-coder-sim/*` contains avatar rendering, cosmetics,
  LPC manifest handling, recoloring, hero/shop preview, and particle helpers.

Frontend fetch rules:

- Use `credentials: "include"` for viewer routes.
- Call `/api/v1/vcs/whoami` before `/me` so auth errors are separated from
  bridge availability errors.
- Treat `bridge_offline` as a user-visible offline state, not an unhandled
  exception.
- After a mutation, re-render from the returned payload or refetch the affected
  data path.

## Extension Paths

### Add a viewer mutation

Touch points:

- Add route handler in `src/routes/viewer.ts`.
- Add exact path/method/body fields to `RPC_ROUTE_ALLOWLIST` in
  `src/vcs-room.ts`.
- Implement or confirm the streamer bridge/private backend handler.
- Add UI call in `static/panel.js` if user-facing.
- Add route and allowlist tests, usually in `test/routes.test.ts` and
  `test/vcs-room.test.ts`.

Checklist:

- The viewer identity must come from `resolveViewer()`.
- Do not accept `login`, `user_id`, or `source` from the request body for a
  viewer-scoped mutation.
- Unknown body fields must be rejected by the DO allowlist.

### Add a public read-only endpoint

Touch points:

- Add route in `src/routes/public.ts`.
- Require `requireApiKey(c, "read")`.
- Normalize and validate any path params.
- Dispatch only allowlisted bridge paths.
- Update generated spec in `src/lib/openapi.ts`.
- Add tests in `test/public-api.test.ts`.
- Optionally expose it through `tools/vcs-cli.ts` and `tools/vcs-mcp.ts`.

Checklist:

- No public API key may be embedded in browser code.
- Public v1 endpoints should remain read-only.
- Login-like params must be normalized before dispatch.

### Add a cosmetic slot or item type

Touch points:

- Catalog/private backend schema for the new slot.
- `static/panel.js` slot rendering and mutation calls.
- `static/index.html` slot controls or catalog grouping.
- `static/assets/js/vibe-coder-sim/cosmetics.js` renderer mapping.
- LPC/static assets and `static/assets/lpc/index.json` if assets are bundled.
- Attribution rows in `static/assets/lpc/CREDITS.csv` for every bundled LPC PNG.

Checklist:

- Keep existing loadouts rendering if the new slot is absent.
- Preserve `body` auto fallback behavior unless the feature intentionally
  changes body selection.
- Run the LPC attribution validation before public mirror publish.

### Add combat/MMO builder features

Touch points:

- `src/routes/viewer.ts` for the viewer route.
- `RPC_ROUTE_ALLOWLIST` in `src/vcs-room.ts`.
- Streamer bridge interception/proxy behavior.
- Private MMO endpoint contract.
- `static/panel.js` combat/build UI state.
- Route and DO allowlist tests.

Checklist:

- Viewer login must be session-derived.
- Static catalogs can be auth-free only when they contain no viewer-specific
  state.
- Mutations should return enough data for the UI to refresh without guessing.

### Add agent/operator tooling

Touch points:

- `tools/vcs-cli.ts` for command-line JSON output.
- `tools/vcs-mcp.ts` for MCP tool exposure.
- Public API route and OpenAPI spec if the tool requires new server data.

Checklist:

- Keep tools zero-dependency unless there is a strong reason.
- Put protocol output on stdout and diagnostics on stderr for MCP.
- Respect `VCS_BASE_URL` and `VCS_API_KEY`.

## Local Development

Install:

```sh
bun install
```

Run Worker locally:

```sh
bun run dev
```

Type-check:

```sh
bun run typecheck
```

Lint:

```sh
bun run lint
```

Tests:

```sh
bun test
```

Focused test commands:

```sh
bun run test:api
bun run test:component
bun run test:configuration
bun run test:regression
bun run test:load
bun run test:stress
bun run test:spike
bun run test:soak
bun run test:scale
bun run test:chaos
bun run test:failover
bun run test:dast
bun run test:pen
```

Minimum PR gate:

- `bun run typecheck`
- `bun run lint`
- Relevant focused tests for changed surfaces.
- `bun test` before release or broad route/DO/auth changes.

## Public Mirror Publish Gate

The mirror is published by:

```sh
bash scripts/publish-vcs-mirror.sh
```

Dry run is default. It stages a sanitized copy, transforms mirror-only config,
runs fail-closed secret scans, validates LPC attribution, and prints the staged
file list.

Push requires:

```sh
bash scripts/publish-vcs-mirror.sh --confirm
```

Do not bypass the mirror script for public releases. It is the gate that prevents
real Cloudflare IDs, service bindings, and attribution-incomplete assets from
leaving the private monorepo.

## Security Invariants

- Public API mutations are out of scope for v1.
- Session-derived identity is the only identity source for viewer routes.
- The Worker never directly exposes private loopback services.
- `VcsRoom` must reject unknown RPC paths, methods, and body fields.
- HMAC timestamp replay protection must remain in place for `/ws/streamer`.
- Raw API keys are never stored; only SHA-256 hashes are persisted.
- Generated OpenAPI docs are public, but data routes require a bearer key.
- Do not commit real namespace IDs, secrets, production service bindings, or
  private operator docs to the public mirror.

## Licensing

Source code and original docs are public domain under The Unlicense.

Bundled LPC sprite assets use mixed upstream licenses including CC-BY,
CC-BY-SA, GPL, OGA-BY, OGA-SA, and CC0. Attribution and share-alike obligations
vary per asset. Keep `NOTICE`, `LICENSES/`, and `static/assets/lpc/CREDITS.csv`
accurate whenever assets change.

## Collaborator PR Checklist

- State which extension path your change follows.
- Identify every touched contract: viewer route, public route, DO allowlist,
  bridge protocol, frontend UI, CLI/MCP, OpenAPI, or assets.
- Add or update tests for the changed contract.
- Keep public API additions read-only unless explicitly approved.
- Keep viewer-scoped identity derived from the session.
- Keep `RPC_ROUTE_ALLOWLIST` synchronized with all dispatched paths and body
  fields.
- Update `src/lib/openapi.ts` for public API changes.
- Update CLI/MCP tools if collaborators or agents need the new public endpoint.
- For LPC assets, update attribution and run the mirror dry run.
- Run typecheck, lint, and relevant tests before handing off.
