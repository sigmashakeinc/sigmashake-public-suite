#!/usr/bin/env bash
# publish-mmo-mirror.sh — public-safe snapshot builder for sigmashake-mmo
#
# Usage:
#   bash scripts/publish-mmo-mirror.sh [--write-evidence <file>]
#   bash scripts/publish-mmo-mirror.sh --confirm --evidence <file>
#
# Dry run builds a staging tree from an explicit allowlist, applies public-only
# scrubs, runs fail-closed scanning, prints the staged file list, and optionally
# writes release evidence. Confirm mode validates evidence for the same source
# commit and prints the operator commands for the external mirror/visibility
# step. This script does not write to GitHub directly.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MIRROR_REPO="${MIRROR_REPO:-sigmashakeinc/sigmashake-mmo}"
MIRROR_BRANCH="${MIRROR_BRANCH:-main}"
CONFIRM=0
EVIDENCE_FILE=""
WRITE_EVIDENCE_FILE=""
SOURCE_COMMIT="unknown"
SOURCE_REL="$SRC_DIR"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --confirm)
      CONFIRM=1
      shift
      ;;
    --evidence)
      [ "$#" -ge 2 ] || { echo "--evidence requires a file path" >&2; exit 1; }
      EVIDENCE_FILE="$2"
      shift 2
      ;;
    --write-evidence)
      [ "$#" -ge 2 ] || { echo "--write-evidence requires a file path" >&2; exit 1; }
      WRITE_EVIDENCE_FILE="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
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
  local git_root dirty
  if git_root="$(git -C "$SRC_DIR" rev-parse --show-toplevel 2>/dev/null)"; then
    SOURCE_COMMIT="$(git -C "$git_root" rev-parse HEAD)"
    SOURCE_REL="$(realpath --relative-to="$git_root" "$SRC_DIR")"
    dirty="$(git -C "$git_root" status --porcelain --untracked-files=all -- "$SOURCE_REL")"
    if [ -n "$dirty" ]; then
      echo "[publish-mmo-mirror] ABORT: source subtree is dirty; publish from a clean committed tree" >&2
      echo "$dirty" >&2
      exit 1
    fi
    return 0
  fi

  if [ "$CONFIRM" -eq 1 ]; then
    echo "[publish-mmo-mirror] ABORT: --confirm requires a git worktree source" >&2
    exit 1
  fi
  echo "[publish-mmo-mirror] WARNING: source is not a git worktree; clean-tree guard skipped for dry run" >&2
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
    echo "source_rel=$SOURCE_REL"
    echo "mirror_repo=$MIRROR_REPO"
    echo "dry_run=passed"
    echo "scan=passed"
    echo "staged_files=$STAGED_FILES"
    echo "generated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$WRITE_EVIDENCE_FILE"
  echo "[publish-mmo-mirror] wrote release evidence: $WRITE_EVIDENCE_FILE"
}

require_release_evidence() {
  if [ -z "$EVIDENCE_FILE" ]; then
    echo "[publish-mmo-mirror] ABORT: --confirm requires --evidence <file>" >&2
    echo "  Run a clean dry run with --write-evidence, then append sast=passed and regression=passed after gates pass." >&2
    exit 1
  fi
  if [ ! -f "$EVIDENCE_FILE" ]; then
    echo "[publish-mmo-mirror] ABORT: release evidence file not found: $EVIDENCE_FILE" >&2
    exit 1
  fi
  for required in \
    "source_commit=$SOURCE_COMMIT" \
    "dry_run=passed" \
    "scan=passed" \
    "sast=passed" \
    "regression=passed"; do
    if ! evidence_has "$required"; then
      echo "[publish-mmo-mirror] ABORT: release evidence missing '$required'" >&2
      exit 1
    fi
  done
  echo "[publish-mmo-mirror] release evidence: PASSED ($EVIDENCE_FILE)"
}

copy_tree() {
  local rel="$1"
  local src="$SRC_DIR/$rel"
  local dst="$STAGE/$rel"
  [ -e "$src" ] || return 0
  mkdir -p "$(dirname "$dst")"
  if [ -d "$src" ]; then
    mkdir -p "$dst"
    rsync -a \
      --exclude='.sigmashake/' \
      --exclude='node_modules/' \
      --exclude='dist/' \
      --exclude='.wrangler/' \
      --exclude='data/' \
      "$src/" "$dst/"
  else
    mkdir -p "$(dirname "$dst")"
    cp -p "$src" "$dst"
  fi
}

rewrite_public_only_values() {
  for rel in "README.md" "AGENTS.md"; do
    [ -f "$STAGE/$rel" ] || continue
    python3 - "$STAGE/$rel" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
text = text.replace("~/.sigmashake/mmo.env", "<LOCAL_MMO_ENV_FILE>")
text = text.replace("data/public-url.txt", "<LOCAL_PUBLIC_URL_FILE>")
path.write_text(text)
PY
  done
}

scan_regex() {
  local label="$1"
  local regex="$2"
  if grep -RInE --exclude-dir='.git' -- "$regex" "$STAGE"; then
    echo "[publish-mmo-mirror] ABORT: staged tree matched private pattern: $label" >&2
    exit 1
  fi
}

scan_stage() {
  scan_regex "local operator path" '/home/[A-Za-z0-9_.-]+'
  scan_regex "private key material" 'BEGIN [A-Z ]*PRIVATE KEY'
  scan_regex "AWS access key" 'AKIA[0-9A-Z]{16}'
  scan_regex "32-hex service id" '\b[0-9a-f]{32}\b'
  scan_regex "HMAC secret assignment" 'MMO_HMAC_KEY=[A-Za-z0-9_./+=:-]{8,}'
  scan_regex "OBS websocket secret assignment" 'OBS_WS_PASSWORD=[A-Za-z0-9_./+=:-]{8,}'
  scan_regex "runtime public tunnel URL" 'https://[A-Za-z0-9.-]+\.trycloudflare\.com'
  if [ -e "$STAGE/data" ]; then
    echo "[publish-mmo-mirror] ABORT: staged tree contains runtime data directory" >&2
    exit 1
  fi

  if ! command -v gitleaks >/dev/null 2>&1; then
    echo "[publish-mmo-mirror] ABORT: gitleaks is required for public mirror scans" >&2
    exit 1
  fi
  gitleaks detect --no-git --source "$STAGE" --verbose
}

ensure_clean_source

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/sigmashake-mmo-mirror.XXXXXX")"

echo "[publish-mmo-mirror] source: $SRC_DIR"
echo "[publish-mmo-mirror] staging: $STAGE"
echo "[publish-mmo-mirror] target: github.com/$MIRROR_REPO @ $MIRROR_BRANCH"

# Allowlist-only public copy. Runtime state, local tunnel output, OBS secrets,
# private operator files, build output, dependency folders, and hidden
# SigmaShake runtime folders are intentionally excluded.
for item in \
  "client" \
  "server" \
  "shared" \
  "tools" \
  "integrations" \
  "test" \
  "scripts/publish-mmo-mirror.sh" \
  "docs/design" \
  "docs/vampire-survivors-contract.md" \
  "README.md" \
  "AGENTS.md" \
  "SPEC_SHEET.md" \
  "RUNBOOK.md" \
  "CLAUDE.md" \
  "package.json" \
  "biome.json" \
  "jsconfig.json" \
  "bun.lock" \
  "pnpm-lock.yaml"; do
  copy_tree "$item"
done

rewrite_public_only_values
scan_stage

STAGED_FILES="$(find "$STAGE" -type f | wc -l | tr -d ' ')"

echo ""
echo "[publish-mmo-mirror] staged files:"
find "$STAGE" -type f -printf '%P\n' | sort

echo ""
echo "[publish-mmo-mirror] public mirror staging passed ($STAGED_FILES files)."
write_release_evidence

if [ "$CONFIRM" -eq 1 ]; then
  require_release_evidence
  echo ""
  echo "[publish-mmo-mirror] operator publish commands:"
  printf '  # create or refresh github.com/%s from staging %s\n' "$MIRROR_REPO" "$STAGE"
  printf '  gh repo edit %s --visibility public\n' "$MIRROR_REPO"
fi
