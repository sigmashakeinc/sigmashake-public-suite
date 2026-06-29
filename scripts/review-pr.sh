#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRUSTED_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SUITE_REPO="${SUITE_REPO:-sigmashakeinc/sigmashake-public-suite}"
STATUS_CONTEXT="${REVIEW_STATUS_CONTEXT:-sigmashake/public-suite-gates}"
MERGE=0
DEPLOY=0
PR_NUMBER=""
STATUS_FINALIZED=0

set_commit_status() {
  local state="$1"
  local description="$2"
  if [ -z "${HEAD_SHA:-}" ]; then
    return 0
  fi

  local args=(
    -f "state=$state"
    -f "context=$STATUS_CONTEXT"
    -f "description=$description"
  )
  if [ -n "${REVIEW_STATUS_TARGET_URL:-}" ]; then
    args+=(-f "target_url=$REVIEW_STATUS_TARGET_URL")
  fi

  if ! gh api -X POST "repos/${SUITE_REPO}/statuses/${HEAD_SHA}" "${args[@]}" >/dev/null; then
    echo "[review-pr] failed to publish GitHub status ${STATUS_CONTEXT}=${state}" >&2
    return 1
  fi
  echo "[review-pr] status ${STATUS_CONTEXT}=${state}"
}

on_exit() {
  local code=$?
  if [ "$code" -ne 0 ] && [ "$STATUS_FINALIZED" -eq 0 ]; then
    set_commit_status failure "Automated host review failed before merge." || true
  fi
  if [ -n "${WORKDIR:-}" ] && [ -d "$WORKDIR" ]; then
    rm -r -- "$WORKDIR"
  fi
}
trap on_exit EXIT

usage() {
  cat <<'EOF'
Usage:
  bash scripts/review-pr.sh <pr-number> [--merge] [--deploy]

Environment:
  SUITE_REPO                 owner/repo to review
  ALLOW_AUTOMATION_CHANGE=1  allow PRs that edit review/deploy automation
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --merge)
      MERGE=1
      shift
      ;;
    --deploy)
      DEPLOY=1
      MERGE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [ -n "$PR_NUMBER" ]; then
        echo "Unexpected argument: $1" >&2
        usage >&2
        exit 1
      fi
      PR_NUMBER="$1"
      shift
      ;;
  esac
done

if [ -z "$PR_NUMBER" ]; then
  usage >&2
  exit 1
fi

if [ "${ALLOW_AUTOMATION_CHANGE:-0}" = "1" ] && { [ "$MERGE" -eq 1 ] || [ "$DEPLOY" -eq 1 ]; }; then
  echo "[review-pr] refusing --merge/--deploy when ALLOW_AUTOMATION_CHANGE=1" >&2
  exit 1
fi

command -v gh >/dev/null 2>&1 || { echo "gh is required" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "git is required" >&2; exit 1; }

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/sigmashake-public-suite-pr.XXXXXX")"

echo "[review-pr] repo: $SUITE_REPO"
echo "[review-pr] pr: $PR_NUMBER"
git clone "https://github.com/${SUITE_REPO}.git" "$WORKDIR/repo"
cd "$WORKDIR/repo"

BASE_REF="$(gh pr view "$PR_NUMBER" --repo "$SUITE_REPO" --json baseRefName --jq '.baseRefName')"
HEAD_SHA="$(gh pr view "$PR_NUMBER" --repo "$SUITE_REPO" --json headRefOid --jq '.headRefOid')"
IS_DRAFT="$(gh pr view "$PR_NUMBER" --repo "$SUITE_REPO" --json isDraft --jq '.isDraft')"
if [ "$IS_DRAFT" = "true" ]; then
  echo "[review-pr] skipping draft PR"
  exit 0
fi
if [ -z "$HEAD_SHA" ]; then
  echo "[review-pr] unable to resolve PR head SHA" >&2
  exit 1
fi
set_commit_status pending "Automated host review is running the 19-gate suite."

git fetch origin "$BASE_REF"
gh pr checkout "$PR_NUMBER" --repo "$SUITE_REPO"
CHECKED_OUT_SHA="$(git rev-parse HEAD)"
if [ "$CHECKED_OUT_SHA" != "$HEAD_SHA" ]; then
  echo "[review-pr] checked out $CHECKED_OUT_SHA but GitHub reported $HEAD_SHA" >&2
  exit 1
fi

review_policy_args=(
  --root "$WORKDIR/repo"
  --base "origin/$BASE_REF"
)
if [ "${ALLOW_AUTOMATION_CHANGE:-0}" = "1" ]; then
  review_policy_args+=(--allow-automation-change)
fi

node "$TRUSTED_ROOT/scripts/review-policy.mjs" "${review_policy_args[@]}"

node "$TRUSTED_ROOT/scripts/run-gates.mjs" \
  --root "$WORKDIR/repo" \
  --manifest "$TRUSTED_ROOT/config/pr-gates.json" \
  --sandbox bwrap \
  --category bootstrap

node "$TRUSTED_ROOT/scripts/run-gates.mjs" \
  --root "$WORKDIR/repo" \
  --manifest "$TRUSTED_ROOT/config/pr-gates.json" \
  --sandbox bwrap \
  --category preflight

node "$TRUSTED_ROOT/scripts/run-gates.mjs" \
  --root "$WORKDIR/repo" \
  --manifest "$TRUSTED_ROOT/config/pr-gates.json" \
  --sandbox bwrap \
  --category test

CURRENT_HEAD_SHA="$(gh pr view "$PR_NUMBER" --repo "$SUITE_REPO" --json headRefOid --jq '.headRefOid')"
if [ "$CURRENT_HEAD_SHA" != "$HEAD_SHA" ]; then
  echo "[review-pr] PR head moved from $HEAD_SHA to $CURRENT_HEAD_SHA after gates; refusing merge" >&2
  exit 1
fi

gh pr review "$PR_NUMBER" --repo "$SUITE_REPO" --approve \
  --body "Automated host review passed for ${HEAD_SHA}: review policy, sandboxed bootstrap, sandboxed preflight, and all 19 sandboxed test gates completed successfully."

set_commit_status success "Automated host review passed all 19 gates."

if [ "$MERGE" -eq 1 ]; then
  gh pr merge "$PR_NUMBER" --repo "$SUITE_REPO" --squash --delete-branch --match-head-commit "$HEAD_SHA"
fi
STATUS_FINALIZED=1

if [ "$DEPLOY" -eq 1 ]; then
  git fetch origin "$BASE_REF"
  BASE_HEAD_SHA="$(git rev-parse "origin/$BASE_REF")"
  git checkout --detach "$BASE_HEAD_SHA"
  bash "$TRUSTED_ROOT/scripts/deploy-from-host.sh" \
    --root "$WORKDIR/repo" \
    --confirm \
    --expected-sha "$BASE_HEAD_SHA"

  if ! PR_NUMBER="$PR_NUMBER" \
    SUITE_REPO="$SUITE_REPO" \
    MERGED_SHA="$BASE_HEAD_SHA" \
    DEPLOYED_SHA="$BASE_HEAD_SHA" \
    DEPLOY_STATUS="deployed" \
    node "$TRUSTED_ROOT/scripts/notify-discord-deploy.mjs"; then
    echo "[review-pr] deploy notification failed after a successful deploy; leaving review/deploy successful and skipping retry" >&2
  fi
fi

echo "[review-pr] complete"
