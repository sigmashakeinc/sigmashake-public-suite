# ADR 0001 — Platform & runtime choice

**Status.** Accepted (2026-05-27)
**Authors.** super@sigmashake.com

## Context

sigmashake-abyss is a SigmaShake monorepo service. We needed to pick a runtime
that matches the service's role in the stack — edge HTTP API vs. local
operator tool vs. background BEAM cluster — without proliferating
incompatible deployment targets.

## Decision

Run sigmashake-abyss on **Cloudflare Workers**.

- The dispatcher Worker pattern (used by sigmashake-fleet) is the
  reference for any new HTTP API surface.
- Storage via D1 / KV / R2 — managed at the platform layer.
- Secrets via Cloudflare Secrets Store — propagated via Quicksilver
  rather than re-uploaded on rotation.


## Alternatives considered

1. **Bun/Node service on a container.** Lower platform lock-in, but loses
   the Quicksilver secret-rotation propagation and the per-tenant
   sub-100ms cold-start that Workers give us.
2. **Long-running Elixir cluster.** Better for stateful workloads; not
   needed for this surface.


## Consequences

- We accept the Cloudflare-platform lock-in.
- Operational visibility tied to Cloudflare's observability stack.
- Hot deploys via `wrangler deploy` — no manual machine provisioning.


## Revisit

The platform choice is revisited when:

- The service grows past 10× its current request rate.
- A platform-specific dependency goes EOL.
- A customer's data-residency / compliance requirement forces a move.
