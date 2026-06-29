#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRUSTED_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SUITE_REPO="${SUITE_REPO:-sigmashakeinc/sigmashake-public-suite}"
SUITE_REPO_CLONE_URL="${SUITE_REPO_CLONE_URL:-https://github.com/${SUITE_REPO}.git}"
STATUS_CONTEXT="${REVIEW_STATUS_CONTEXT:-sigmashake/public-suite-gates}"
DEPLOY_STATUS_CONTEXT="${DEPLOY_STATUS_CONTEXT:-sigmashake/public-suite-deploy}"
MERGE=0
DEPLOY=0
DEPLOY_ONLY=0
REQUIRE_DEPLOY_READY=0
PR_NUMBER=""
MERGED_SHA=""
BASE_REF_OVERRIDE=""
STATUS_FINALIZED=0

set_commit_status_for_sha() {
  local sha="$1"
  local context="$2"
  local state="$3"
  local description="$4"
  if [ -z "$sha" ]; then
    return 0
  fi

  local args=(
    -f "state=$state"
    -f "context=$context"
    -f "description=$description"
  )
  if [ -n "${REVIEW_STATUS_TARGET_URL:-}" ]; then
    args+=(-f "target_url=$REVIEW_STATUS_TARGET_URL")
  fi

  if ! gh api -X POST "repos/${SUITE_REPO}/statuses/${sha}" "${args[@]}" >/dev/null; then
    echo "[review-pr] failed to publish GitHub status ${context}=${state}" >&2
    return 1
  fi
  echo "[review-pr] status ${context}=${state}"
}

set_commit_status() {
  local state="$1"
  local description="$2"
  set_commit_status_for_sha "${HEAD_SHA:-}" "$STATUS_CONTEXT" "$state" "$description"
}

set_deploy_status() {
  local sha="$1"
  local state="$2"
  local description="$3"
  set_commit_status_for_sha "$sha" "$DEPLOY_STATUS_CONTEXT" "$state" "$description"
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
  bash scripts/review-pr.sh <pr-number> --deploy-only --merged-sha <sha> [--base-ref <name>]

Environment:
  SUITE_REPO                 owner/repo to review
  ALLOW_AUTOMATION_CHANGE=1  allow PRs that edit review/deploy automation
  ALLOW_GENERATED_SERVICE_CHANGE=1
                             allow PRs that edit generated service snapshots
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
    --deploy-only)
      DEPLOY_ONLY=1
      shift
      ;;
    --require-deploy-ready)
      REQUIRE_DEPLOY_READY=1
      shift
      ;;
    --merged-sha)
      MERGED_SHA="$2"
      shift 2
      ;;
    --base-ref)
      BASE_REF_OVERRIDE="$2"
      shift 2
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

if [ "$DEPLOY_ONLY" -eq 1 ] && { [ "$MERGE" -eq 1 ] || [ "$DEPLOY" -eq 1 ] || [ "$REQUIRE_DEPLOY_READY" -eq 1 ]; }; then
  echo "[review-pr] refusing to combine --deploy-only with review/merge options" >&2
  exit 1
fi

if [ "${ALLOW_AUTOMATION_CHANGE:-0}" = "1" ] && { [ "$MERGE" -eq 1 ] || [ "$DEPLOY" -eq 1 ] || [ "$DEPLOY_ONLY" -eq 1 ] || [ "$REQUIRE_DEPLOY_READY" -eq 1 ]; }; then
  echo "[review-pr] refusing --merge/--deploy when ALLOW_AUTOMATION_CHANGE=1" >&2
  exit 1
fi
if [ "${ALLOW_GENERATED_SERVICE_CHANGE:-0}" = "1" ] && { [ "$MERGE" -eq 1 ] || [ "$DEPLOY" -eq 1 ] || [ "$DEPLOY_ONLY" -eq 1 ] || [ "$REQUIRE_DEPLOY_READY" -eq 1 ]; }; then
  echo "[review-pr] refusing --merge/--deploy when ALLOW_GENERATED_SERVICE_CHANGE=1" >&2
  exit 1
fi

command -v gh >/dev/null 2>&1 || { echo "gh is required" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "git is required" >&2; exit 1; }

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/sigmashake-public-suite-pr.XXXXXX")"

echo "[review-pr] repo: $SUITE_REPO"
echo "[review-pr] pr: $PR_NUMBER"
git clone "$SUITE_REPO_CLONE_URL" "$WORKDIR/repo"
cd "$WORKDIR/repo"

BASE_REF="${BASE_REF_OVERRIDE:-$(gh pr view "$PR_NUMBER" --repo "$SUITE_REPO" --json baseRefName --jq '.baseRefName')}"

notify_deploy() {
  local merged_sha="$1"
  local deployed_sha="$2"
  local status="$3"
  if ! PR_NUMBER="$PR_NUMBER" \
    SUITE_REPO="$SUITE_REPO" \
    MERGED_SHA="$merged_sha" \
    DEPLOYED_SHA="$deployed_sha" \
    DEPLOY_STATUS="$status" \
    node "$TRUSTED_ROOT/scripts/notify-discord-deploy.mjs"; then
    echo "[review-pr] deploy notification failed; continuing with recorded deploy status" >&2
  fi
}

validate_deploy_ready() {
  bash "$TRUSTED_ROOT/scripts/deploy-from-host.sh" \
    --root "$WORKDIR/repo" \
    --confirm \
    --validate-only
}

run_deploy_for_sha() {
  local merged_sha="$1"
  set_deploy_status "$merged_sha" pending "Host deployment is running."
  git fetch origin "$BASE_REF"
  if ! git merge-base --is-ancestor "$merged_sha" "origin/$BASE_REF"; then
    echo "[review-pr] refusing to deploy non-base commit $merged_sha for $BASE_REF" >&2
    set_deploy_status "$merged_sha" failure "Host deployment refused a non-base commit." || true
    notify_deploy "$merged_sha" "$merged_sha" "failed"
    return 1
  fi
  git checkout --detach "$merged_sha"
  local code=0
  bash "$TRUSTED_ROOT/scripts/deploy-from-host.sh" \
    --root "$WORKDIR/repo" \
    --confirm \
    --expected-sha "$merged_sha" || code=$?
  if [ "$code" -eq 0 ]; then
    set_deploy_status "$merged_sha" success "Host deployment completed."
    notify_deploy "$merged_sha" "$merged_sha" "deployed"
    return 0
  fi

  set_deploy_status "$merged_sha" failure "Host deployment failed." || true
  notify_deploy "$merged_sha" "$merged_sha" "failed"
  return "$code"
}

if [ "$DEPLOY_ONLY" -eq 1 ]; then
  if [ -z "$MERGED_SHA" ]; then
    MERGED_SHA="$(gh pr view "$PR_NUMBER" --repo "$SUITE_REPO" --json mergeCommit --jq '.mergeCommit.oid // ""')"
  fi
  if [ -z "$MERGED_SHA" ]; then
    echo "[review-pr] --deploy-only requires --merged-sha or a merged PR" >&2
    exit 1
  fi
  run_deploy_for_sha "$MERGED_SHA"
  STATUS_FINALIZED=1
  echo "[review-pr] complete"
  exit 0
fi

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
if [ "${ALLOW_GENERATED_SERVICE_CHANGE:-0}" = "1" ]; then
  review_policy_args+=(--allow-generated-service-change)
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

if [ "$DEPLOY" -eq 1 ] || [ "$REQUIRE_DEPLOY_READY" -eq 1 ]; then
  validate_deploy_ready
fi

if ! gh pr review "$PR_NUMBER" --repo "$SUITE_REPO" --approve \
  --body "Automated host review passed for ${HEAD_SHA}: review policy, sandboxed bootstrap, sandboxed preflight, and all 19 sandboxed test gates completed successfully."; then
  echo "[review-pr] unable to approve PR; continuing because status checks are authoritative" >&2
fi

set_commit_status success "Automated host review passed all 19 gates."

if [ "$MERGE" -eq 1 ]; then
  gh pr merge "$PR_NUMBER" --repo "$SUITE_REPO" --squash --delete-branch --match-head-commit "$HEAD_SHA"
fi
STATUS_FINALIZED=1

if [ "$DEPLOY" -eq 1 ]; then
  for _ in 1 2 3 4 5; do
    MERGED_SHA="$(gh pr view "$PR_NUMBER" --repo "$SUITE_REPO" --json mergeCommit --jq '.mergeCommit.oid // ""')"
    [ -n "$MERGED_SHA" ] && break
    sleep 1
  done
  if [ -z "$MERGED_SHA" ]; then
    echo "[review-pr] unable to resolve merged commit SHA for PR #$PR_NUMBER" >&2
    exit 1
  fi
  run_deploy_for_sha "$MERGED_SHA"
fi

echo "[review-pr] complete"
