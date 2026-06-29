# ADR 0002 — Testing strategy

**Status.** Accepted (2026-05-27)
**Authors.** super@sigmashake.com

## Context

Every service in the monorepo is held to the SigmaShake 19-test-kind
taxonomy (component / configuration / dependencies / e2e / integration /
unit / sast / pen / api / etc.). The cert scanner expects ≥ 6 kinds for
"ok" coverage.

## Decision

sigmashake-abyss ships tests across the kinds applicable to its surface, captured
by sentinel files at the project root:

- `.last-test-result` — overall test pass/fail
- `.last-test-result-<kind>` — per-kind sentinel for the cert taxonomy
  signal
- Integration tests use `@cloudflare/vitest-pool-workers` against `wrangler dev`.

- The cert scanner reads `.last-test-result*` sentinels — services
  refresh them via the nightly `refresh-workspace-sentinels.ts` timer
  or manually after a fix.

## Alternatives considered

1. **Single `test` script with no taxonomy.** Simpler, but loses the
   signal the cert scanner uses to flag missing surfaces (e.g. a service
   with no e2e test isn't surfaced as a gap).
2. **CI-only enforcement.** Tried initially; failed because the cert
   scanner needs filesystem sentinels at request time (no subprocess).

## Consequences

- New surfaces in sigmashake-abyss ship with a corresponding test kind.
- The sentinel file is the contract — touching it without a real test
  pass is a lint violation.
- 7-day fresh window: sentinels older than that drop from "ok" to "warn"
  in the cert scanner.

## Revisit

When the test taxonomy itself evolves (new kinds added, kinds retired) in
the monorepo's certify handler.
