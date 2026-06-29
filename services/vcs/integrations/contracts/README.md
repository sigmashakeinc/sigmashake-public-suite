# VCS Integration Contracts

The public repository exposes contract docs and mocks for collaborators. The
production implementations live in the private stream stack.

## Bridge RPC

Worker to bridge:

```json
{"type":"rpc","req_id":"uuid","method":"GET","path":"/api/v1/vcs/me","body":{"source":"twitch","login":"devviewer"}}
```

Bridge to Worker:

```json
{"type":"rpc_reply","req_id":"uuid","status":200,"body":"{\"ok\":true}"}
```

Viewer-authenticated brain ticks use the same RPC envelope with
`path:"/api/v1/vcs/brains/tick"`. The Worker, not the client, supplies viewer
identity. Only the canonical viewer fields plus optional `scene`, `stimulus`,
`mood`, `nearby`, and `image_data_url` are allowed through `VcsRoom`.

The OBS browser-source autonomy loop does not call this Worker route directly.
It calls the local OBS overlay server with `X-VCS-Brain-Token`; chat-elixir
adds that token to each Garden pet snapshot by signing `<source>:<login>` with
`VCS_BRAIN_LOCAL_TOKEN`. The local OBS endpoint must verify the token and
mirror the same optional-field allowlist before calling Cerebras.

## Cosmetic Routes

These routes proxy to chat-elixir in production and to `mock-chat` in the
public harness:

- `GET /api/v1/vcs/me`
- `GET /api/v1/vcs/catalog`
- `POST /api/v1/vcs/equip`
- `POST /api/v1/vcs/unequip`
- `POST /api/v1/vcs/buy`
- `POST /api/v1/vcs/color`
- `POST /api/v1/vcs/hue`
- `POST /api/v1/vcs/raw_slot`
- `POST /api/v1/vcs/body`
- `POST /api/v1/vcs/clear_body`
- `POST /api/v1/vcs/clear_raw_slot`

## Combat Routes

These routes proxy to Sigma Shake MMO in production and to `mock-mmo` in the
public harness:

- `GET /api/v1/vcs/combat-gear`
- `GET /api/v1/vcs/combat-loadout`
- `POST /api/v1/vcs/combat-equip`
- `GET /api/v1/vcs/combat-sigma`
- `GET /api/v1/vcs/combat-passive-tree`
- `POST /api/v1/vcs/combat-passives`
- `POST /api/v1/vcs/combat-reserve`
- `POST /api/v1/vcs/combat-position`
- `POST /api/v1/vcs/combat-swap-set`
- `GET /api/v1/vcs/combat-weapon-catalog`
- `GET /api/v1/vcs/combat-weapons`
- `POST /api/v1/vcs/combat-weapons`

Combat routes that require a character are Twitch-only. Non-Twitch sessions
should return a successful unavailable envelope:

```json
{"ok":true,"unavailable":true,"reason":"combat_twitch_only"}
```

## Brain Route

`POST /api/v1/vcs/brains/tick` is intercepted by the bridge before the
chat-elixir fallback. In the public harness it only attempts the Cerebras path
when both of these are true:

- `VCS_BRAINS_ENABLED=1`
- `CEREBRAS_API_KEY` is set
- `VCS_BRAIN_LOCAL_TOKEN` is set for OBS browser-source autonomy ticks

Otherwise the bridge returns a successful unavailable envelope and does not
fall through to chat-elixir.
