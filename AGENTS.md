# Public Suite Agent Notes

This repository is public. Treat every change as collaborator-facing.

## Standards

- Keep MMO, Abyss, VCS, and OBS Chat Overlay service boundaries clear under
  `services/`.
- Do not add production secrets, private account IDs, private Wrangler config,
  local operator paths, `.sigmashake/`, `.wrangler/`, `node_modules/`, `dist/`,
  MMO runtime `data/`, or OBS chat overlay runtime/config artifacts.
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
PR should include matching tests or public mock updates in the same service.
