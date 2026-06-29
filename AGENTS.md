# Public Suite Agent Notes

This repository is public. Treat every change as collaborator-facing.

## Standards

- Keep MMO, Abyss, and VCS service boundaries clear under `services/`.
- Treat `services/mmo`, `services/abyss`, and `services/vcs` as generated
  component snapshots. Do not edit them in suite PRs; send those changes to the
  matching component mirror fork instead.
- Do not add production secrets, private account IDs, private Wrangler config,
  local operator paths, `.sigmashake/`, `.wrangler/`, `node_modules/`, `dist/`,
  or MMO runtime `data/`.
- Update `config/pr-gates.json` when adding a required quality gate.
- Changes to automation files require maintainer review; the host review loop
  blocks them by default.
- Prefer extending existing service scripts and tests over adding wrappers.
- Public mocks and contracts must stay runnable without private SigmaShake
  services.

## Review Requirements

Before merge, host automation must pass:

- review policy scan;
- dependency bootstrap;
- preflight gates;
- all 19 test gates;
- optional deploy verification when the operator asked the loop to deploy.

If a service changes source, static UI, bridge contracts, or integrations, the
PR belongs in that component mirror and should include matching tests or public
mock updates in the same service.
