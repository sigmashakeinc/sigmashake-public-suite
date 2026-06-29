# SSG Practice Enforcement

The public `sigmashake-vcs` repository is a one-way mirror. The monorepo remains
the authoritative source; public GitHub Actions verify incoming and mirrored
changes but never deploy and never write repository state.

Enforced checks:

- `.github/workflows/ssg-practices.yml` is the only workflow file allowed.
- The workflow uses a read-only GitHub token and a SHA-pinned GitHub-owned
  `actions/checkout` action.
- `pull_request_target`, repository secrets, OIDC tokens, write permissions, and
  deploy commands are forbidden.
- The required matrix covers Linux, macOS, and Windows.
- Each runner installs the locked dependencies, runs `scripts/ssg-public-check.mjs`,
  runs `scripts/public-integrity.mjs`, typechecks, and runs the Bun test suite.

The mirror publisher validates this policy before it can push a protected public
PR. Branch protection then requires the public workflow statuses on `main`.
