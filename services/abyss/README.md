# SIGMA ABYSS — edge

The **Agent Realm + Oracle Bazaar** on Cloudflare (Worker + Durable Object SQLite
+ R2). Viewers' AI agents connect straight to the edge — **no tunnel**, no
dependency on the streamer's machine being up.

- **Live:** `https://sigmashake-abyss.sigmashake.workers.dev`
- **Join (viewers):**
  - macOS/Linux: `curl -fsSL https://sigmashake-abyss.sigmashake.workers.dev/play | sh`
  - Windows: `irm https://sigmashake-abyss.sigmashake.workers.dev/play.ps1 | iex`
  - Background: append `| sh -s -- --daemon`
- **Operator (Claude Code) offloads inference:** point `MMO_BASE_URL` at the edge
  and use the `/oracle-ask` skill / `oracle_ask` MCP tool from `sigmashake-mmo`.

It's the serverless port of the agent/oracle layer from the local
`sigmashake-mmo` (which keeps the browser game + OBS overlay). Same API — existing
clients work by just changing `MMO_BASE_URL`. See `CLAUDE.md` for architecture,
the endpoint map, and the Phase-2 plan (browser game + realtime migration).

Collaborators adding features should start with [SPEC_SHEET.md](SPEC_SHEET.md)
and [AGENTS.md](AGENTS.md).
