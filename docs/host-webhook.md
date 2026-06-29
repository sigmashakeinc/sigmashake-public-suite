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
- `AUTO_DEPLOY=1` requires absolute, executable, host-owned deploy and verify
  script paths for every deployed service. Set `VCS_DEPLOY_COMMAND`,
  `ABYSS_DEPLOY_COMMAND`, `MMO_DEPLOY_COMMAND`, `VCS_VERIFY_COMMAND`,
  `ABYSS_VERIFY_COMMAND`, and `MMO_VERIFY_COMMAND`.

## Run Locally

```sh
GITHUB_WEBHOOK_SECRET='<webhook secret>' \
SUITE_REPO=sigmashakeinc/sigmashake-public-suite \
AUTO_MERGE=1 \
AUTO_DEPLOY=1 \
VCS_DEPLOY_COMMAND='/srv/sigmashake-public-suite-host/deploy-vcs.sh' \
ABYSS_DEPLOY_COMMAND='/srv/sigmashake-public-suite-host/deploy-abyss.sh' \
MMO_DEPLOY_COMMAND='/srv/sigmashake-public-suite-host/deploy-mmo.sh' \
VCS_VERIFY_COMMAND='/srv/sigmashake-public-suite-host/verify-vcs.sh' \
ABYSS_VERIFY_COMMAND='/srv/sigmashake-public-suite-host/verify-abyss.sh' \
MMO_VERIFY_COMMAND='/srv/sigmashake-public-suite-host/verify-mmo.sh' \
PUBLIC_SUITE_WEBHOOK_HOST=127.0.0.1 \
PUBLIC_SUITE_WEBHOOK_PORT=7918 \
bun run review:webhook
```

`AUTO_MERGE=1` approves and merges when all gates pass. When `AUTO_DEPLOY=1`,
review jobs first run `scripts/deploy-from-host.sh --validate-only` so invalid
host deploy wiring blocks before merge. The actual deploy is owned by the
`pull_request.closed` merged event and runs `review-pr.sh --deploy-only` against
the event's exact `merge_commit_sha`; this avoids duplicate deploys and prevents
a later `main` update from being deployed by accident.

Deploys are still host-owned; no deploy secrets are stored in the public
repository. The webhook persists both delivery IDs and queued/running jobs in
`PUBLIC_SUITE_WEBHOOK_STATE`; if the service restarts, incomplete jobs are
requeued before new deliveries are accepted.

Deployment publishes a separate `sigmashake/public-suite-deploy` status on the
merged commit. Success and failure both send a sanitized Discord notification
when `DISCORD_DEPLOY_WEBHOOK_URL` is set; raw deploy logs are not posted.

By default, pull request events enqueue a review immediately. Successful
workflow-run events enqueue a review after GitHub's light gates pass only when
`TRIGGER_ON_WORKFLOW_SUCCESS=1` is set. Configure either trigger with:

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
