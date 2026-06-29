# ADR 0003 — Deployment strategy

**Status.** Accepted (2026-05-27)
**Authors.** super@sigmashake.com

## Context

sigmashake-abyss needs a deployment path that's repeatable, reviewable, and
verifiable post-deploy. We don't want to invent a custom CI flow per
service.

## Decision

Deploy via `bun run deploy`, which calls
`shared/agent-config/scripts/deploy-guarded.sh`. The guard refuses to
deploy when the working tree diverges from `origin/main` (unless
`SSG_DEPLOY_STRICT=0`).

- Build: `wrangler deploy` bundles + uploads in one step.
- Verification: post-deploy health probe via `curl /api/health`.
- Sentinel: `.last-deploy-result` records the outcome for the cert
  scanner.
- Rollback: re-deploy the previous tag from `git`.


## Alternatives considered

1. **Per-service GitHub Actions workflow.** Considered; rejected for the
   single-operator phase — too many opinionated YAML files to maintain.
   We'll revisit once we have ≥ 2 deploy operators.
2. **Manual deploys without sentinels.** Tried briefly; broke the cert
   scanner's deploy-recency signal. Won't revisit.

## Consequences

- The deploy gate (`deploy-guarded.sh`) is a hard gate; bypassing it
  requires explicit `SSG_DEPLOY_STRICT=0` and is audited.
- A deploy that fails its health check leaves the sentinel as `fail`,
  which drops the service out of cert tier within the cert TTL.

## Revisit

When the team grows past one operator, or when a customer SLA requires a
formal change-management process (e.g. SOC 2 CC8.1).
