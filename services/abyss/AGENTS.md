# sigmashake-abyss Agent Guide

This is the public collaboration guide for SIGMA ABYSS edge: the Cloudflare
Worker, Durable Object, R2 archive, browser client, Agent Realm, and Oracle
Bazaar service.

## Collaboration Contract

- Keep public contributors inside `sigmashake-abyss/` unless the change is
  explicitly about parity with `sigmashake-mmo`.
- Publish Worker source, public assets, tests, OpenAPI docs, example Wrangler
  config, and local development docs. Do not publish real Cloudflare account
  IDs, private service bindings, secrets, R2 credentials, production-only
  on-call/privacy docs, viewer PII, or local operator paths.
- The public mirror is allowlist-only. If a new file should be public, add it
  to `scripts/publish-abyss-mirror.sh` and keep the fail-closed scan green.
- `wrangler.toml` is production config. The public mirror gets
  `wrangler.example.toml` with placeholders and public-safe comments.
- `MMO_HMAC_KEY` is a secret. Docs may name the env var, but never include a
  value.
- `public/play/agent.mjs` is the public onboarding runner and must stay in sync
  with `sigmashake-mmo/tools/agent-bot.js` when that contract changes.

## Local Setup

```sh
pnpm install
pnpm run dev
```

Run targeted checks:

```sh
pnpm run typecheck
pnpm run test
```

## Public Mirror

Dry-run the sanitized mirror:

```sh
bash scripts/publish-abyss-mirror.sh --write-evidence /tmp/abyss-mirror-evidence.env
```

The dry run stages an allowlisted tree, uses `wrangler.example.toml` instead of
the production Wrangler config, runs a fail-closed secret/private-path scan, and
prints the exact file list. It does not push.

Confirming a publish requires release evidence from the same source commit and
prints the operator commands for the external mirror step:

```sh
bash scripts/publish-abyss-mirror.sh --confirm --evidence /tmp/abyss-mirror-evidence.env
```

GitHub repository visibility is a separate external setting. After the mirror is
published and reviewed, an operator can make the target repo public with:

```sh
gh repo edit sigmashakeinc/sigmashake-abyss --visibility public
```

## Required Gates

For docs or mirror changes:

```sh
bash -n scripts/publish-abyss-mirror.sh
pnpm run test:regression
```

For Worker or DO changes, also run `pnpm run typecheck` and the affected test
kind.

## Design Rules

- `RealmRoom` is the authoritative global Durable Object state owner.
- Oracle requester routes are HMAC-gated in production.
- Agent registration and agent actions stay cooldown-gated.
- R2 archive behavior must not leak private HIT payloads into public fixtures.
- Keep `src/world.ts` parity with the local MMO world model when balance changes.
