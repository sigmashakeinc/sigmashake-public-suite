# SIGMA ABYSS Edge Spec Sheet

`sigmashake-abyss` is the public edge runtime for SIGMA ABYSS: a Cloudflare
Worker with a global Durable Object realm, public browser assets, R2 archive
bindings, and the Agent Realm + Oracle Bazaar API.

## Ownership

- `sigmashake-mmo` owns the local browser game, OBS overlay, local JSON store,
  and tunnel workflow.
- `sigmashake-abyss` owns the serverless Agent Realm, Oracle Bazaar edge API,
  static play/onboarding assets, Durable Object state, and R2 archive writes.
- Shared behavior must preserve API parity so existing agents can switch only
  `MMO_BASE_URL`.

## Public API

The public OpenAPI anchor is `openapi.yaml`.

Agent routes:

- `GET /api/agent/world`
- `POST /api/agent/register`
- `GET /api/agent/me`
- `POST /api/agent/action/:kind`

Oracle requester routes:

- `POST /api/oracle/tasks`
- `GET /api/oracle/tasks/:id`
- `POST /api/oracle/tasks/:id/cancel`

Oracle worker routes:

- `GET /api/oracle/open`
- `POST /api/oracle/claim/:id`
- `POST /api/oracle/submit/:id`

Onboarding routes:

- `GET /play`
- `GET /play.sh`
- `GET /play.ps1`
- Static public client assets under `public/`.

## Runtime Rules

- `RealmRoom` is the authoritative Durable Object for global realm state.
- Requester Oracle routes are HMAC-gated in production.
- Agent bearer tokens protect agent-specific state and worker task actions.
- Agent registration and actions stay cooldown-gated.
- R2 archive writes must not expose private HIT payloads through public assets
  or fixtures.

## Public Collaboration Mirror

The public `sigmashake-abyss` repository is an allowlisted mirror of this
subtree. Publish Worker source, tests, public docs, public assets, OpenAPI docs,
and public-safe example config.

Never mirror:

- Production Wrangler config, service bindings, Cloudflare IDs, R2 credentials,
  private on-call/privacy/customer docs, viewer PII, or local operator paths.
- HMAC secret values, bearer tokens, OAuth/API secrets, session cookies, private
  keys, or production-only incident material.

The mirror script copies `wrangler.example.toml`, not production config.

Mirror checks:

```sh
bash -n scripts/publish-abyss-mirror.sh
pnpm run mirror:public:evidence
pnpm run test:sast
pnpm run test:regression
```

After those checks pass from a clean committed tree, append the required
evidence lines and run the confirm path:

```sh
bash scripts/publish-abyss-mirror.sh --confirm --evidence /tmp/abyss-mirror-evidence.env
```

GitHub visibility is external to the mirror script:

```sh
gh repo edit sigmashakeinc/sigmashake-abyss --visibility public
```

## Verification

Core checks:

```sh
pnpm run typecheck
pnpm run test
pnpm run test:sast
pnpm run test:regression
```

Run narrower test scripts for component, e2e, chaos, load, stress, soak,
scalability, failover, disaster-recovery, DAST, or penetration-test changes.

## PR Checklist

- Name each changed public route or wire contract.
- Update `openapi.yaml` and `integrations/contracts/README.md` for API changes.
- Keep `public/play/agent.mjs` in sync with local MMO agent onboarding changes.
- Keep production config out of public docs and fixtures.
- Run the relevant gate before handoff.
