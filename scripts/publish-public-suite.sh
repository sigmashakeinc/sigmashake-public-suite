#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SUITE_REPO="${SUITE_REPO:-sigmashakeinc/sigmashake-public-suite}"
SUITE_BRANCH="${SUITE_BRANCH:-main}"
MMO_REPO="${MMO_REPO:-sigmashakeinc/sigmashake-mmo}"
ABYSS_REPO="${ABYSS_REPO:-sigmashakeinc/sigmashake-abyss}"
VCS_REPO="${VCS_REPO:-sigmashakeinc/sigmashake-vcs}"
OBS_CHAT_OVERLAY_REPO="${OBS_CHAT_OVERLAY_REPO:-sigmashakeinc/sigmashake-obs-chat-overlay}"
MMO_BRANCH="${MMO_BRANCH:-main}"
ABYSS_BRANCH="${ABYSS_BRANCH:-main}"
VCS_BRANCH="${VCS_BRANCH:-main}"
OBS_CHAT_OVERLAY_BRANCH="${OBS_CHAT_OVERLAY_BRANCH:-main}"
CONFIRM=0
EVIDENCE_FILE=""
WRITE_EVIDENCE_FILE=""
STAGE_DIR=""
SOURCE_COMMIT="unknown"
STAGED_FILES=0
MMO_SHA=""
ABYSS_SHA=""
VCS_SHA=""
OBS_CHAT_OVERLAY_SHA=""

usage() {
  cat <<'EOF'
Usage:
  bash scripts/publish-public-suite.sh [--stage-dir <dir>] [--write-evidence <file>]
  bash scripts/publish-public-suite.sh --confirm --evidence <file> [--stage-dir <dir>]

Environment:
  SUITE_REPO     target owner/repo, default sigmashakeinc/sigmashake-public-suite
  MMO_REPO       component owner/repo, default sigmashakeinc/sigmashake-mmo
  ABYSS_REPO     component owner/repo, default sigmashakeinc/sigmashake-abyss
  VCS_REPO       component owner/repo, default sigmashakeinc/sigmashake-vcs
  OBS_CHAT_OVERLAY_REPO component owner/repo, default sigmashakeinc/sigmashake-obs-chat-overlay
  MMO_BRANCH     component branch, default main
  ABYSS_BRANCH   component branch, default main
  VCS_BRANCH     component branch, default main
  OBS_CHAT_OVERLAY_BRANCH component branch, default main
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --confirm)
      CONFIRM=1
      shift
      ;;
    --evidence)
      EVIDENCE_FILE="$2"
      shift 2
      ;;
    --write-evidence)
      WRITE_EVIDENCE_FILE="$2"
      shift 2
      ;;
    --stage-dir)
      STAGE_DIR="$2"
      shift 2
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

if [ "$CONFIRM" -eq 0 ] && [ -n "$EVIDENCE_FILE" ]; then
  echo "--evidence is only valid with --confirm" >&2
  exit 1
fi
if [ "$CONFIRM" -eq 1 ] && [ -n "$WRITE_EVIDENCE_FILE" ]; then
  echo "--write-evidence is only valid for dry runs" >&2
  exit 1
fi

ensure_clean_source() {
  local git_root dirty rel
  if git_root="$(git -C "$SRC_DIR" rev-parse --show-toplevel 2>/dev/null)"; then
    SOURCE_COMMIT="$(git -C "$git_root" rev-parse HEAD)"
    rel="$(realpath --relative-to="$git_root" "$SRC_DIR")"
    dirty="$(git -C "$git_root" status --porcelain --untracked-files=all -- "$rel")"
    if [ -n "$dirty" ]; then
      echo "[publish-public-suite] ABORT: suite scaffold is dirty; publish from a clean committed tree" >&2
      echo "$dirty" >&2
      exit 1
    fi
  fi
}

evidence_has() {
  local expected="$1"
  grep -Fxq "$expected" "$EVIDENCE_FILE"
}

write_release_evidence() {
  [ -n "$WRITE_EVIDENCE_FILE" ] || return 0
  mkdir -p "$(dirname "$WRITE_EVIDENCE_FILE")"
  {
    echo "source_commit=$SOURCE_COMMIT"
    echo "suite_repo=$SUITE_REPO"
    echo "mmo_sha=$MMO_SHA"
    echo "abyss_sha=$ABYSS_SHA"
    echo "vcs_sha=$VCS_SHA"
    echo "obs_chat_overlay_sha=$OBS_CHAT_OVERLAY_SHA"
    echo "dry_run=passed"
    echo "scan=passed"
    echo "staged_files=$STAGED_FILES"
    [ -n "$STAGE_DIR" ] && echo "stage_dir=$STAGE_DIR"
    echo "generated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$WRITE_EVIDENCE_FILE"
  echo "[publish-public-suite] wrote release evidence: $WRITE_EVIDENCE_FILE"
}

require_release_evidence() {
  if [ -z "$EVIDENCE_FILE" ]; then
    echo "[publish-public-suite] ABORT: --confirm requires --evidence <file>" >&2
    echo "  Required lines: dry_run=passed scan=passed suite_preflight=passed suite_tests_19=passed automated_review=passed" >&2
    exit 1
  fi
  if [ ! -f "$EVIDENCE_FILE" ]; then
    echo "[publish-public-suite] ABORT: evidence file not found: $EVIDENCE_FILE" >&2
    exit 1
  fi

  for required in \
    "source_commit=$SOURCE_COMMIT" \
    "mmo_sha=$MMO_SHA" \
    "abyss_sha=$ABYSS_SHA" \
    "vcs_sha=$VCS_SHA" \
    "obs_chat_overlay_sha=$OBS_CHAT_OVERLAY_SHA" \
    "dry_run=passed" \
    "scan=passed" \
    "suite_preflight=passed" \
    "suite_tests_19=passed" \
    "automated_review=passed"; do
    if ! evidence_has "$required"; then
      echo "[publish-public-suite] ABORT: evidence missing '$required'" >&2
      exit 1
    fi
  done
  echo "[publish-public-suite] release evidence: PASSED ($EVIDENCE_FILE)"
}

copy_scaffold() {
  rsync -a \
    --exclude='.git/' \
    --exclude='services/' \
    --exclude='node_modules/' \
    --exclude='dist/' \
    --exclude='.wrangler/' \
    --exclude='graphify-out/' \
    --exclude='.last-audit-result' \
    --exclude='.last-test-result*' \
    --exclude='.last-test-report-*.json' \
    --exclude='.test-history-*.jsonl' \
    --exclude='tmp/' \
    "$SRC_DIR/" "$STAGE/"
}

clone_component() {
  local name="$1"
  local repo="$2"
  local branch="$3"
  local dest="$STAGE/services/$name"
  local clone="$WORK/components/$name"
  echo "[publish-public-suite] cloning $repo#$branch -> services/$name"
  git clone --depth 1 --branch "$branch" "https://github.com/${repo}.git" "$clone"
  case "$name" in
    mmo) MMO_SHA="$(git -C "$clone" rev-parse HEAD)" ;;
    abyss) ABYSS_SHA="$(git -C "$clone" rev-parse HEAD)" ;;
    vcs) VCS_SHA="$(git -C "$clone" rev-parse HEAD)" ;;
    obs-chat-overlay) OBS_CHAT_OVERLAY_SHA="$(git -C "$clone" rev-parse HEAD)" ;;
  esac
  rm -rf "$clone/.git"
  mkdir -p "$dest"
  rsync -a "$clone/" "$dest/"
}

write_services_readme() {
  mkdir -p "$STAGE/services"
  cat > "$STAGE/services/README.md" <<EOF
# Services

Generated from public component mirrors.

- mmo: https://github.com/$MMO_REPO @ $MMO_SHA
- abyss: https://github.com/$ABYSS_REPO @ $ABYSS_SHA
- vcs: https://github.com/$VCS_REPO @ $VCS_SHA
- obs-chat-overlay: https://github.com/$OBS_CHAT_OVERLAY_REPO @ $OBS_CHAT_OVERLAY_SHA
EOF
}

scan_regex() {
  local label="$1"
  local regex="$2"
  if grep -RInE --exclude-dir='.git' --exclude-dir='node_modules' -- "$regex" "$STAGE"; then
    echo "[publish-public-suite] ABORT: staged tree matched private pattern: $label" >&2
    exit 1
  fi
}

scan_obs_chat_overlay_runtime_paths() {
  local obs_root="$STAGE/services/obs-chat-overlay"
  [ -d "$obs_root" ] || return 0

  for path in data runtime state logs chat-logs recordings captures screenshots obs-config obs-studio scene-collections profiles; do
    if [ -e "$obs_root/$path" ]; then
      echo "[publish-public-suite] ABORT: staged tree contains OBS chat overlay runtime/config path: services/obs-chat-overlay/$path" >&2
      exit 1
    fi
  done

  if find "$obs_root" \
    \( -name 'global.ini' \
      -o -name 'service.json' \
      -o -name 'obs-websocket*.json' \
      -o -name 'scene-collection*.json' \
    \) -print -quit | grep -q .; then
    echo "[publish-public-suite] ABORT: staged tree contains OBS chat overlay runtime config artifact" >&2
    exit 1
  fi
}

scan_stage() {
  scan_regex "local operator path" '/home/[A-Za-z0-9_.-]+'
  scan_regex "private key material" 'BEGIN [A-Z ]*PRIVATE KEY'
  scan_regex "AWS access key" 'AKIA[0-9A-Z]{16}'
  scan_regex "HMAC/OBS/Wrangler secret assignment" '(VCS_HMAC_KEY|MMO_HMAC_KEY|OBS_WS_PASSWORD|OBS_WEBSOCKET_PASSWORD|OBS_CHAT_HMAC_KEY|OBS_CHAT_OVERLAY_HMAC_KEY|OBS_CHAT_OVERLAY_SECRET|TWITCH_(CLIENT_SECRET|OAUTH_TOKEN|IRC_TOKEN|BOT_TOKEN|CHAT_TOKEN)|YOUTUBE_(API_KEY|CLIENT_SECRET|REFRESH_TOKEN|ACCESS_TOKEN)|DISCORD_WEBHOOK_URL|STREAM_KEY|RTMP_URL|WRANGLER_API_TOKEN)=[A-Za-z0-9_./+=:-]{20,}'
  scan_regex "OBS/chat runtime config secret field" '"?(streamKey|stream_key|oauthToken|oauth_token|chatToken|chat_token|obsWebSocketPassword|obs_ws_password)"?[[:space:]]*[:=][[:space:]]*"?[A-Za-z0-9_./+=:-]{20,}'
  scan_regex "runtime public tunnel URL" 'https://[A-Za-z0-9.-]+\.trycloudflare\.com'
  scan_obs_chat_overlay_runtime_paths
  if [ -e "$STAGE/services/mmo/data" ]; then
    echo "[publish-public-suite] ABORT: staged tree contains MMO runtime data" >&2
    exit 1
  fi

  if ! command -v gitleaks >/dev/null 2>&1; then
    echo "[publish-public-suite] ABORT: gitleaks is required for public suite scans" >&2
    exit 1
  fi
  gitleaks detect --no-git --source "$STAGE" --redact
}

publish_stage() {
  command -v gh >/dev/null 2>&1 || { echo "gh is required for --confirm" >&2; exit 1; }
  if ! gh repo view "$SUITE_REPO" >/dev/null 2>&1; then
    gh repo create "$SUITE_REPO" --public --description "Public SigmaShake MMO, Abyss, VCS, and OBS Chat Overlay suite"
  fi

  cd "$STAGE"
  git init -q
  git checkout -q -b "$SUITE_BRANCH"
  git add -A
  git -c user.name="sigmashake public suite mirror" \
    -c user.email="noreply@sigmashake.com" \
    commit -q -m "mirror: public suite snapshot $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "[publish-public-suite] commit: $(git rev-parse HEAD)"
  git push --force "https://github.com/${SUITE_REPO}.git" "$SUITE_BRANCH"
}

ensure_clean_source

WORK="$(mktemp -d "${TMPDIR:-/tmp}/sigmashake-public-suite-work.XXXXXX")"
if [ -n "$STAGE_DIR" ]; then
  STAGE="$(mkdir -p "$(dirname "$STAGE_DIR")" && realpath -m "$STAGE_DIR")"
  rm -rf "$STAGE"
  mkdir -p "$STAGE"
else
  STAGE="$(mktemp -d "${TMPDIR:-/tmp}/sigmashake-public-suite-stage.XXXXXX")"
  trap 'rm -rf "$WORK" "$STAGE"' EXIT
fi
trap 'rm -rf "$WORK"' EXIT

echo "[publish-public-suite] source: $SRC_DIR"
echo "[publish-public-suite] staging: $STAGE"
echo "[publish-public-suite] target: github.com/$SUITE_REPO @ $SUITE_BRANCH"

copy_scaffold
clone_component "mmo" "$MMO_REPO" "$MMO_BRANCH"
clone_component "abyss" "$ABYSS_REPO" "$ABYSS_BRANCH"
clone_component "vcs" "$VCS_REPO" "$VCS_BRANCH"
clone_component "obs-chat-overlay" "$OBS_CHAT_OVERLAY_REPO" "$OBS_CHAT_OVERLAY_BRANCH"
write_services_readme
scan_stage

STAGED_FILES="$(find "$STAGE" -type f | wc -l | tr -d ' ')"

echo ""
echo "[publish-public-suite] public suite staging passed ($STAGED_FILES files)."
echo "[publish-public-suite] component SHAs:"
echo "  mmo=$MMO_SHA"
echo "  abyss=$ABYSS_SHA"
echo "  vcs=$VCS_SHA"
echo "  obs-chat-overlay=$OBS_CHAT_OVERLAY_SHA"
write_release_evidence

if [ "$CONFIRM" -eq 1 ]; then
  require_release_evidence
  publish_stage
fi
