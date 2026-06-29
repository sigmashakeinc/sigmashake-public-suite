# SigmaShake Public Suite

Public collaboration monorepo for the SigmaShake stream service:

- `services/mmo` - Sigma Shake MMO runtime and public game contracts.
- `services/abyss` - Sigma Abyss Worker and public integration surface.
- `services/vcs` - Viewer Collaboration System Worker, panel, bridge mocks, and public contracts.

This repository is generated from the public component mirrors. Private runtime
state, Cloudflare production IDs, local operator paths, secrets, `.wrangler/`,
`.sigmashake/`, dependency folders, build output, and MMO runtime data are not
allowed in the public suite.

## Source Of Truth

The suite is an aggregate package. The service directories under
`services/mmo`, `services/abyss`, and `services/vcs` are generated snapshots of
the public component mirrors and are replaced during suite publishing.

Send component code, contracts, tests, and component docs to the component repo:

- MMO: https://github.com/sigmashakeinc/sigmashake-mmo
- Abyss: https://github.com/sigmashakeinc/sigmashake-abyss
- VCS: https://github.com/sigmashakeinc/sigmashake-vcs

Use this suite repo for aggregate scaffold, suite automation, host review/deploy
automation, and root-level collaboration docs. A PR that edits a generated
component snapshot in `services/{mmo,abyss,vcs}` is rejected by the host review
policy because the change would be overwritten by the next mirror publish.

## Contributor Flow

See [CONTRIBUTING.md](CONTRIBUTING.md) for path-based PR routing. To verify the
aggregate suite locally:

```sh
bun install
bun run bootstrap
bun run check
bun run test:19
```

The authoritative host review loop runs the same manifest from `config/pr-gates.json`.
GitHub Actions may run a lighter subset, but a PR is not merged by automation
until the host loop has completed all required gates.

## Nineteen Test Gates

`bun run test:19` runs these gate categories in order:

1. unit
2. api
3. component
4. integration
5. e2e
6. regression
7. configuration
8. dependencies
9. sast
10. dast
11. penetration
12. load
13. stress
14. spike
15. soak
16. scalability
17. chaos
18. failover
19. disaster-recovery

Each gate contains the component commands that exist for MMO, Abyss, and VCS.
Missing service directories are a packaging error in the generated public suite.

## Host Automation

The preferred maintainer-host flow is event-driven. Run the webhook worker on
the host and configure a GitHub repository webhook for `Pull requests` and
`Workflow runs` events:

```sh
GITHUB_WEBHOOK_SECRET='<secret from GitHub webhook settings>' \
AUTO_MERGE=1 \
AUTO_DEPLOY=1 \
bun run review:webhook
```

GitHub sends an event to the host, the host verifies the
`X-Hub-Signature-256` HMAC, queues the PR, runs the trusted gates, and deploys
only after the PR has passed, merged, and the host checkout has advanced.

Polling remains available as a fallback when inbound webhooks are not practical:

```sh
SUITE_REPO=sigmashakeinc/sigmashake-public-suite \
  bash scripts/review-pr-loop.sh --merge --deploy
```

For each non-draft PR the loop:

1. checks out the PR in a temporary clone;
2. runs the trusted review policy from the host checkout;
3. bootstraps dependencies;
4. runs preflight gates;
5. runs all 19 test gates;
6. approves and merges only if every gate passes;
7. deploys from the host only after merge, when `--deploy` is set.

Automation changes under `.github/`, `scripts/`, `config/pr-gates.json`, or the
root `package.json` require manual review unless the host operator explicitly
sets `ALLOW_AUTOMATION_CHANGE=1`.

See [docs/host-webhook.md](docs/host-webhook.md) for the webhook deployment
details and the example systemd unit.

## Publishing The Public Suite

From the private SigmaShake mono checkout:

```sh
cd sigmashake-public-suite
bash scripts/publish-public-suite.sh \
  --stage-dir /tmp/sigmashake-public-suite-stage \
  --write-evidence /tmp/sigmashake-public-suite.env
```

The publisher clones the public MMO, Abyss, and VCS mirrors into
`services/`, scans the combined tree, and writes release evidence. Confirm mode
pushes a clean snapshot to `sigmashakeinc/sigmashake-public-suite` after the
required evidence lines are present.

## Deploying

Deploys are host-only and sequential. The default VCS and Abyss commands call
their public `bun run deploy` scripts. MMO deploys are host-specific and must be
provided through `MMO_DEPLOY_COMMAND`.

```sh
MMO_DEPLOY_COMMAND='systemctl --user restart sigmashake-mmo-public.service' \
  bash scripts/deploy-from-host.sh --confirm
```

The deploy script refuses to run from a dirty checkout unless
`--allow-dirty` is passed.
