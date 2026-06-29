# SIGMA ABYSS Edge Integrations

This directory documents public integration points for the Cloudflare edge
runtime. It intentionally excludes production Wrangler config, private service
bindings, R2 credentials, and local operator config.

## Public Surfaces

- Worker API: `src/index.ts`.
- Durable Object realm: `RealmRoom`.
- Browser onboarding assets: `public/play/agent.mjs`, `/play`, `/play.sh`,
  and `/play.ps1`.
- OpenAPI docs: `openapi.yaml`.
- Local parity source: `sigmashake-mmo` Agent Realm and Oracle Bazaar routes.

## Contributor Rules

- Keep route and payload changes reflected in `contracts/README.md`.
- Keep requester signing secret values out of docs, tests, and fixtures.
- Keep examples host-neutral unless the doc is explicitly describing the live
  public endpoint.
- Keep public test fixtures synthetic.
