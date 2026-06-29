# sigmashake-abyss — ADR portfolio review log

This file is the "have we read our own ADRs lately?" sentinel. The
`workspace-certify` architecture dimension uses the most-recent ADR
mtime to detect stagnation; this file is updated in lockstep with any
deliberate architectural review even when no individual ADR changes.

| Review date | Reviewer | Result | Notes |
|---|---|---|---|
| 2026-05-27 | super@sigmashake.com | Initial portfolio (0001–0003) authored. | Platform choice, testing strategy, and deployment strategy ADRs in place. |

## How to use

When you do an architectural review (quarterly cadence target, or on a
significant decision change):

1. Read every ADR end-to-end.
2. Mark each `Accepted` / `Superseded by ADR NNNN` / `Deprecated`.
3. If superseding, write the new ADR with `Status: Accepted` and a
   `Supersedes ADR NNNN` line at the top.
4. Append a row to the table above with today's date.
5. Touch this file so the cert system picks up the freshness.

Avoid rewriting an ADR in-place after it's been accepted. Write a new
ADR that supersedes it — the audit trail of decisions matters.
