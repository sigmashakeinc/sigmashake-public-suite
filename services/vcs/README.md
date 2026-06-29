# sigmashake-vcs

Standalone web app at **vcs.sigmashake.com** that lets viewers customize
their on-stream character in the Vibe Coder Sim OBS overlay.

Collaborators adding features should start with [SPEC_SHEET.md](SPEC_SHEET.md)
and [AGENTS.md](AGENTS.md). Agent-assisted collaborators can load the Codex
skill at [`.agents/skills/vcs/SKILL.md`](.agents/skills/vcs/SKILL.md) or the
Claude Code skill at [`.claude/skills/vcs/SKILL.md`](.claude/skills/vcs/SKILL.md).

> History: This project shipped as a Twitch Extension panel first, but
> Twitch's Extension service was broken so we pivoted to a regular
> website signed in via the shared `sigmashake-accounts` Twitch OAuth.
> The backend bridge architecture and chat-elixir surface are
> identical — only the front-door auth and UI shell changed.

```
[Viewer's browser: vcs.sigmashake.com]
        │  session_id cookie (set by accounts.sigmashake.com on Twitch OAuth)
        ▼
[CF Worker: vcs.sigmashake.com]  ─── decrypts session via SESSIONS KV ──┐
        │  HTTP /api/v1/vcs/*                                          │
        ▼                                                               │
[VcsRoom Durable Object]  ─── per-broadcaster bridge hub                │
        │  WSS RPC                                                      │
        ▼                                                               │
[sigmashake-obs/src/lib/vcs-bridge.ts]  ─── HMAC handshake ─────────────┘
        │  HTTP /api/v1/vcs/*  (loopback)
        ▼
[chat-elixir Phoenix :8081 / VcsExtensionController]
        │  Ecto
        ▼
[~/.sigmashake/chatter-db.sqlite : vibe_loadout, vibe_inventory]
```

The bridge pattern matches `sigmashake-ask` and `sigmashake-bets` so any
Cloudflare Worker change can be deployed independently of the streamer
box; the box only needs to be up when viewers are actually using the
builder (the worker returns 503 `bridge_offline` otherwise).

## Setup

### 1. Cloudflare bindings

```sh
# HMAC key for the streamer-side bridge handshake
openssl rand -hex 32 > /tmp/vcs-hmac-key
wrangler secret put VCS_HMAC_KEY__prod \
  --store-id <PLACEHOLDER_SECRETS_STORE_ID> < /tmp/vcs-hmac-key
shred -u /tmp/vcs-hmac-key
```

The session encryption key (`ENCRYPTION_KEY__prod`) and the `SESSIONS`
KV namespace are shared with `sigmashake-accounts`, `sigmashake-ask`,
and `sigmashake-bets` — they're already provisioned. No new KV needs
creating.

### 2. Deploy

```sh
bun install
bun run typecheck
bun run deploy   # routed through deploy-guarded.sh — pulls origin/main
                 # diff guard, refuses to deploy if your tree diverges
```

`bun run deploy` runs `wrangler deploy`. The Worker route in
`wrangler.toml` (`vcs.sigmashake.com/*` + `zone_name = "sigmashake.com"`)
makes wrangler auto-create the matching DNS record on first deploy —
no manual Cloudflare DNS step required. See the monorepo CLAUDE.md
`<deploys>` section for the race-protection rationale.

### 3. Bridge on the streamer box

The Cloudflare Worker is just a fan-in for viewer requests; the actual
DB writes happen in chat-elixir on the streamer machine. Run
`vcs-bridge.ts` alongside the other obs daemons:

```sh
# In ~/.config/sigmashake-obs/env (or wherever obs:chat:start picks up env):
VCS_BRIDGE_ENABLED=1
# Set VCS_HMAC_KEY to the same private bridge secret configured on the Worker.
VCS_BRAINS_ENABLED=1
CEREBRAS_API_KEY=<required for /api/v1/vcs/brains/tick>
VCS_BRAIN_LOCAL_TOKEN=<shared only between chat-elixir and the OBS overlay server>
```

Then `bun run obs:chat:start` — the bridge starts as part of
`overlay/server.ts` and auto-reconnects on disconnect.

Verify the bridge is wired up:

```sh
curl https://vcs.sigmashake.com/api/v1/vcs/bridge/status
# {"bridge_connected":true,"bridges":1,"pending_rpcs":0}
```

## Auth flow

1. Viewer hits `vcs.sigmashake.com`.
2. The page calls `GET /api/v1/vcs/me` with `credentials: 'include'`.
3. If no `session_id` cookie or the session isn't Twitch-authed, the
   worker returns 401 and the page renders a "Sign in with Twitch"
   button linking to `https://accounts.sigmashake.com/auth/twitch?return_to=https://vcs.sigmashake.com/`.
4. `sigmashake-accounts` runs the Twitch OAuth round-trip and sets
   `session_id` cookie on the parent `.sigmashake.com` domain.
5. Viewer is redirected back to `vcs.sigmashake.com`. Page re-fetches
   `/me`, this time succeeds, drops into the builder UI.

The cookie is `httpOnly; Secure; SameSite=Lax; Domain=.sigmashake.com`
and is shared with every other `*.sigmashake.com` surface — a viewer
who's already signed in to (say) `bet.sigmashake.com` is one click
away from being signed into vcs as well.

## Backend surface (chat-elixir)

All endpoints live under `/api/v1/vcs/*` and pipe through `[:api,
:local_only]`, so only the bridge process — running on the same box —
can call them. The worker passes verified `twitch_user_id`,
`twitch_login`, and `twitch_display` on every request.

| Method | Path                              | Purpose                              |
|--------|-----------------------------------|--------------------------------------|
| GET    | `/api/v1/vcs/me`                  | Loadout + inventory + XP + shop view |
| POST   | `/api/v1/vcs/brains/tick`         | Session-derived viewer brain tick    |
| GET    | `/api/v1/vcs/catalog`             | Full catalog grouped by slot         |
| POST   | `/api/v1/vcs/equip`               | Equip an owned item                  |
| POST   | `/api/v1/vcs/unequip`             | Clear a slot                         |
| POST   | `/api/v1/vcs/buy`                 | Purchase from shop                   |
| POST   | `/api/v1/vcs/color`               | Set per-part colour (c_skin/...)     |
| POST   | `/api/v1/vcs/hue`                 | Set whole-avatar hue (0-359)         |
| POST   | `/api/v1/vcs/raw_slot`            | Set hair_style or hat_style          |
| POST   | `/api/v1/vcs/body`                | Set body type (fem/masc/...)         |
| POST   | `/api/v1/vcs/clear_body`          | Reset body to dress-driven default   |
| POST   | `/api/v1/vcs/clear_raw_slot`      | Clear a colour or style slot         |

See `lib/chat_web/controllers/vcs_extension_controller.ex` for the
canonical schema.

`POST /api/v1/vcs/brains/tick` stays on the cookie-authenticated viewer
surface. The worker resolves the viewer session first, ignores any identity
fields supplied in the request body, and forwards only the canonical viewer
envelope plus optional clamped `scene`, `stimulus`, `mood`, `nearby`, and
`image_data_url`. It is intentionally not added to the public bearer-key
OpenAPI surface.

The OBS browser-source autonomy loop uses a separate loopback endpoint,
`POST http://127.0.0.1:8080/api/vcs/brains/tick`. Chat-elixir signs each
visible Garden pet as `brain_token = HMAC_SHA256(VCS_BRAIN_LOCAL_TOKEN,
"<source>:<login>")`; the OBS overlay server verifies that token before it
spends a Cerebras request. This keeps direct browser-source ticks from
spoofing arbitrary VCS identities.

## Body type

`body` is a first-class slot on top of the existing 10 catalog slots.
Values:

| value         | renderer behaviour                                     |
|---------------|--------------------------------------------------------|
| `fem`         | Female LPC body sprite                                 |
| `masc`        | Male LPC body sprite                                   |
| `androgynous` | Male sprite for now (no androgynous LPC asset shipped) |
| `auto`        | Falls back to dress-driven detection                   |
| (no row)      | Same as `auto` — preserves pre-extension behaviour     |

The renderer rule lives in `cosmetics.js → resolveBodyVariant()`.

## Licensing

This project uses a **mixed license model**.

| Content | License |
|---|---|
| Source code and original docs (`src/`, `tools/`, `test/`, `static/index.html`, `static/panel.*`, `static/assets/js/`) | [The Unlicense](UNLICENSE) (public domain) |
| Bundled LPC sprite assets (`static/assets/lpc/**`) | Upstream licenses — CC-BY, CC-BY-SA, GPL-2.0, GPL-3.0, OGA-BY, OGA-SA, CC0 (varies per asset) |

Attribution is **required** for the LPC assets. See:

- `NOTICE` — explicit carve-out and share-alike obligations
- `LICENSES/` — complete license texts for all nine applicable licenses
- `static/assets/lpc/CREDITS-LPC.md` — author list and upstream source collections
- `static/assets/lpc/CREDITS.csv` — per-local-PNG attribution rows mapped to upstream `CREDITS.csv`

`scripts/publish-vcs-mirror.sh` refuses to push the public mirror unless `CREDITS.csv`
has one resolved attribution row for every bundled LPC PNG and no `BLOCKER:` sentinel.

## Architecture rationale

* **Why a CF Worker fronting chat-elixir?** chat-elixir's HTTP endpoint
  binds 127.0.0.1 (single-box safety invariant in the monorepo
  CLAUDE.md). The worker is the part that's safe to expose to the
  internet — it verifies the session, rate-limits, and proxies through
  an HMAC-authed WS to the box.
* **Why Durable Object + in-memory RPC map?** Latency. The builder
  becomes sluggish past ~150 ms per click; a non-hibernating DO with an
  in-memory pending-RPC map round-trips in <10 ms over a warm WS.
  Tradeoff: an evicted DO drops in-flight requests (the page sees a
  504 and retries).
* **Why share `sigmashake-accounts` for auth?** Single sign-in across
  `*.sigmashake.com`. A viewer who's already signed into the chatter-
  archive site, the bets site, etc. lands on vcs already authed. Vcs
  itself never sees the Twitch OAuth secrets.
