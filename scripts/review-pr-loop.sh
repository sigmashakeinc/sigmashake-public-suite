#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUITE_REPO="${SUITE_REPO:-sigmashakeinc/sigmashake-public-suite}"
MERGE=0
DEPLOY=0
WATCH=0
SLEEP_SECONDS="${SLEEP_SECONDS:-300}"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/review-pr-loop.sh [--merge] [--deploy] [--watch]

Processes every non-draft open PR once. With --watch, repeats every
SLEEP_SECONDS seconds.
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
    --watch)
      WATCH=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

command -v gh >/dev/null 2>&1 || { echo "gh is required" >&2; exit 1; }

run_once() {
  mapfile -t prs < <(gh pr list \
    --repo "$SUITE_REPO" \
    --state open \
    --json number,isDraft \
    --jq '.[] | select(.isDraft == false) | .number')

  if [ "${#prs[@]}" -eq 0 ]; then
    echo "[review-loop] no non-draft PRs"
    return 0
  fi

  for pr in "${prs[@]}"; do
    args=("$pr")
    [ "$MERGE" -eq 1 ] && args+=("--merge")
    [ "$DEPLOY" -eq 1 ] && args+=("--deploy")
    if ! bash "$SCRIPT_DIR/review-pr.sh" "${args[@]}"; then
      echo "[review-loop] PR #$pr failed review; continuing" >&2
    fi
  done
}

while true; do
  run_once
  [ "$WATCH" -eq 1 ] || break
  sleep "$SLEEP_SECONDS"
done
