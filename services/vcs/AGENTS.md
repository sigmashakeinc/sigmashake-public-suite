# sigmashake-vcs Agent Guide

This is the public collaboration guide for the Vibe Coder Sim web app.
Start with [SPEC_SHEET.md](SPEC_SHEET.md), then use this file as the
working checklist for code changes.

## Collaboration Contract

- Agent-assisted contributors should use the public VCS skill:
  `.agents/skills/vcs/SKILL.md` for Codex and `.claude/skills/vcs/SKILL.md`
  for Claude Code. Claude Code public specialists live in `.claude/agents/`.
- Keep public contributors inside `sigmashake-vcs/` unless a change is
  explicitly about a cross-repo contract.
- Publish contract-shaped mocks and docs, not private OBS, chat-elixir,
  account, or MMO implementation internals.
- Never add real secrets, real Cloudflare IDs, streamer-local paths,
  production tokens, OAuth client secrets, session cookies, or viewer PII.
- If you add, rename, or remove an endpoint, update the Worker route,
  `VcsRoom` RPC allowlist, static UI, OpenAPI/public docs where applicable,
  integration mocks, this guide, and the spec sheet.
- If the public mirror should receive a new file or directory, add it to
  `scripts/publish-vcs-mirror.sh`; the mirror is allowlist-only.

## Full Stream Setup

The production path has four pieces:

1. Viewer browser: `static/index.html`, `static/panel.js`, `static/panel.css`.
2. Cloudflare Worker and Durable Object: `src/`.
3. Streamer-side bridge: `integrations/bridge/vcs-bridge.js` for public
   development, `sigmashake-obs/src/lib/vcs-bridge.ts` in the private stream
   stack.
4. Loopback services on the streamer box:
   `integrations/mock-chat/server.js` stands in for chat-elixir and
   `integrations/mock-mmo/server.js` stands in for Sigma Shake MMO.

Run the public harness in separate terminals:

```sh
bun run integration:mock-chat
bun run integration:mock-mmo
VCS_BASE_URL=http://127.0.0.1:8787 VCS_HMAC_KEY=dev-vcs-secret bun run integration:bridge
bun run dev
```

Use the same `VCS_HMAC_KEY` in local Worker config and the bridge process.
For cookie-auth testing, see `integrations/mock-auth/README.md`.

## Required Gates

Before handing off work:

```sh
bun run typecheck
bun test
bash -n scripts/publish-vcs-mirror.sh
```

For endpoint or bridge changes, also boot the integration harness above and
exercise the touched route through the Worker, not just the mock directly.

## Design Rules

- Viewer identity must come from `session_id` and the decrypted accounts
  session, never from client-supplied body fields.
- The Worker never calls streamer-local services directly. It dispatches to
  the Durable Object, which forwards over an outbound HMAC-authenticated
  WebSocket bridge.
- Cosmetic/account endpoints proxy to chat-elixir. Combat endpoints proxy to
  the MMO loopback service. Keep that split visible in docs and mocks.
- Non-Twitch sessions may use cosmetics, but Twitch-only combat data should
  degrade with `{ok:true, unavailable:true, reason:"combat_twitch_only"}`.
- Durable Object in-flight RPC state is memory-only. Do not add persistence
  unless the spec explicitly changes.
