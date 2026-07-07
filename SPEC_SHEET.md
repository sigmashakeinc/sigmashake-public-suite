# SigmaShake Public Suite Spec

## Objective

Package the public MMO, Sigma Abyss, VCS, and OBS Chat Overlay surfaces into one
monorepo that is easy to clone, test, review, merge, and deploy from a trusted
maintainer host.

## Layout

```text
services/
  mmo/
  abyss/
  vcs/
  obs-chat-overlay/
config/
  pr-gates.json
scripts/
  run-gates.mjs
  review-policy.mjs
  review-pr.sh
  review-pr-loop.sh
  webhook-server.mjs
  deploy-from-host.sh
  publish-public-suite.sh
```

`services/` is generated during publishing from public component mirrors. The
private mono checkout stores only the suite scaffold and automation.

## Public Safety Boundary

The combined suite is composed only from public component mirrors. The publisher
performs a second fail-closed scan across the assembled tree before publishing.

Blocked content includes:

- private key material;
- known cloud/service ID shapes;
- local `/home/<user>` operator paths;
- production tunnel URLs;
- secret assignments for bridge, OBS, MMO, and Wrangler credentials;
- private runtime folders and build output;
- OBS chat overlay runtime/config artifacts such as scene collections, OBS
  profiles, websocket config, recordings, captures, screenshots, and chat logs.

## PR Gate Model

The gate manifest has three categories:

- `bootstrap`: dependency installation;
- `preflight`: typecheck, lint, and suite script syntax checks;
- `tests`: exactly 19 required test categories.

The host review loop executes the trusted manifest from the maintainer checkout
against a temporary PR clone. A PR cannot weaken the automation that is judging
it unless the maintainer explicitly allows automation changes.

The preferred trigger is a GitHub webhook delivered to `webhook-server.mjs`.
Polling is only a fallback for hosts that cannot receive inbound webhook
traffic.

## Deploy Model

Deploys are sequential and host-owned:

1. run trusted gates;
2. merge the PR;
3. pull the updated public suite on the host;
4. deploy VCS;
5. deploy Abyss;
6. deploy MMO with a host-provided command;
7. deploy OBS Chat Overlay with a host-provided command;
8. record failures immediately and stop on first failed service.

The public repository never stores deploy secrets.
