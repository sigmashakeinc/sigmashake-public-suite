# Host Webhook Automation

`scripts/webhook-server.mjs` is the preferred no-polling entry point for public
suite automation.

## GitHub Webhook

Create a repository webhook on `sigmashakeinc/sigmashake-public-suite`:

- Payload URL: `https://<host-public-url>/github`
- Content type: `application/json`
- Secret: a random value stored only on the host as `GITHUB_WEBHOOK_SECRET`
- Events: `Pull requests` and `Workflow runs`

The server also exposes `GET /healthz` for local health checks.

## Host Requirements

- `gh`, `git`, `node`, `bun`, and `bwrap` must be installed on the host.
- Host reviews pin the PR `headRefOid` before checkout, re-check it after all
  gates pass, and merge with GitHub's matching-head guard.
- PR-controlled gate commands run through Bubblewrap with a clean environment,
  temp home, isolated `/proc`, and only the checked-out suite mounted writable.
  The webhook secret is not passed to the review child process.
- `AUTO_DEPLOY=1` requires real post-deploy verification commands. Set
  `VCS_VERIFY_COMMAND`, `ABYSS_VERIFY_COMMAND`, `MMO_VERIFY_COMMAND`, a generic
  `DEPLOY_VERIFY_COMMAND`, or add a service `verify:deploy` package script.

## Run Locally

```sh
GITHUB_WEBHOOK_SECRET='<webhook secret>' \
SUITE_REPO=sigmashakeinc/sigmashake-public-suite \
AUTO_MERGE=1 \
AUTO_DEPLOY=1 \
VCS_VERIFY_COMMAND='curl -fsS https://vcs.example.com/healthz' \
ABYSS_VERIFY_COMMAND='curl -fsS https://abyss.example.com/healthz' \
MMO_VERIFY_COMMAND='curl -fsS https://mmo.example.com/healthz' \
PUBLIC_SUITE_WEBHOOK_HOST=127.0.0.1 \
PUBLIC_SUITE_WEBHOOK_PORT=7918 \
bun run review:webhook
```

`AUTO_MERGE=1` approves and merges when all gates pass. `AUTO_DEPLOY=1` also
runs `scripts/deploy-from-host.sh --confirm` after merge. Deploys are still
host-owned; no deploy secrets are stored in the public repository, and deploy
completion requires a configured smoke/probe command for each deployed service.

By default, pull request events enqueue a review immediately and successful
workflow-run events enqueue a review after GitHub's light gates pass. Disable
either trigger with:

```sh
TRIGGER_ON_PR=0
TRIGGER_ON_WORKFLOW_SUCCESS=0
```

## Example Systemd Unit

Copy `systemd/sigmashake-public-suite-webhook.service.example` to a host-owned
unit path, set the environment values, and start it with the normal systemd
workflow for that host.

The unit should normally bind to `127.0.0.1` behind a reverse proxy or tunnel
that terminates TLS and forwards only the `/github` webhook path.
