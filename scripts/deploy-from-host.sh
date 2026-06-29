#!/usr/bin/env bash
set -euo pipefail

ROOT="$(pwd)"
CONFIRM=0
ALLOW_DIRTY=0
SERVICES="vcs,abyss,mmo"
VERIFY=1
EXPECTED_SHA=""

usage() {
  cat <<'EOF'
Usage:
  bash scripts/deploy-from-host.sh --confirm [--root <path>] [--services vcs,abyss,mmo] [--allow-dirty] [--skip-verify] [--expected-sha <sha>]

Environment:
  VCS_DEPLOY_COMMAND    absolute host-owned script path for VCS deploy
  ABYSS_DEPLOY_COMMAND  absolute host-owned script path for Abyss deploy
  MMO_DEPLOY_COMMAND    absolute host-owned script path for MMO deploy
  VCS_VERIFY_COMMAND    absolute host-owned script path for VCS verify
  ABYSS_VERIFY_COMMAND  absolute host-owned script path for Abyss verify
  MMO_VERIFY_COMMAND    absolute host-owned script path for MMO verify
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --confirm)
      CONFIRM=1
      shift
      ;;
    --root)
      ROOT="$2"
      shift 2
      ;;
    --services)
      SERVICES="$2"
      shift 2
      ;;
    --allow-dirty)
      ALLOW_DIRTY=1
      shift
      ;;
    --skip-verify)
      VERIFY=0
      shift
      ;;
    --expected-sha)
      EXPECTED_SHA="$2"
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

if [ "$CONFIRM" -ne 1 ]; then
  echo "[deploy] refusing to deploy without --confirm" >&2
  exit 1
fi

ROOT="$(cd "$ROOT" && pwd -P)"

reject_command() {
  local env_name="$1"
  local message="$2"
  echo "[deploy] ${env_name}: ${message}" >&2
  exit 1
}

validate_host_command() {
  local env_name="$1"
  local candidate="$2"
  local resolved=""

  if [ -z "$candidate" ]; then
    reject_command "$env_name" "must be set to an absolute host script path"
  fi

  case "$candidate" in
    /*) ;;
    *)
      reject_command "$env_name" "must be an absolute path"
      ;;
  esac

  case "$candidate" in
    *[!A-Za-z0-9._/+:-]*)
      reject_command "$env_name" "contains unsupported characters"
      ;;
  esac

  if [ -L "$candidate" ]; then
    reject_command "$env_name" "must not be a symlink: $candidate"
  fi

  resolved="$(realpath -- "$candidate")" || reject_command "$env_name" "failed to resolve path"

  if [ ! -f "$resolved" ]; then
    reject_command "$env_name" "does not exist: $candidate"
  fi

  if [ ! -x "$resolved" ]; then
    reject_command "$env_name" "is not executable: $candidate"
  fi

  if [ ! -O "$resolved" ]; then
    reject_command "$env_name" "must be owned by the current host user"
  fi

  case "$resolved" in
    "$ROOT"|"$ROOT"/*)
      reject_command "$env_name" "must point outside the repository root"
      ;;
  esac

  printf '%s\n' "$resolved"
}

if [ "$ALLOW_DIRTY" -ne 1 ]; then
  dirty="$(git -C "$ROOT" status --porcelain --untracked-files=all)"
  if [ -n "$dirty" ]; then
    echo "[deploy] refusing to deploy from dirty checkout" >&2
    echo "$dirty" >&2
    exit 1
  fi
fi

if [ -n "$EXPECTED_SHA" ]; then
  actual_sha="$(git -C "$ROOT" rev-parse HEAD)"
  if [ "$actual_sha" != "$EXPECTED_SHA" ]; then
    echo "[deploy] refusing to deploy unexpected revision: expected $EXPECTED_SHA got $actual_sha" >&2
    exit 1
  fi
fi

command_var_for_service() {
  local service="$1"
  local kind="$2"
  case "$service:$kind" in
    vcs:deploy) echo "VCS_DEPLOY_COMMAND" ;;
    abyss:deploy) echo "ABYSS_DEPLOY_COMMAND" ;;
    mmo:deploy) echo "MMO_DEPLOY_COMMAND" ;;
    vcs:verify) echo "VCS_VERIFY_COMMAND" ;;
    abyss:verify) echo "ABYSS_VERIFY_COMMAND" ;;
    mmo:verify) echo "MMO_VERIFY_COMMAND" ;;
    *)
      echo "[deploy] unknown service/kind: $service/$kind" >&2
      exit 1
      ;;
  esac
}

run_host_command() {
  local service="$1"
  local kind="$2"
  local env_name="$3"
  local script_path="$4"
  echo "[deploy] ${kind} ${service}: ${script_path}"
  (
    cd "$ROOT"
    PUBLIC_SUITE_ROOT="$ROOT" PUBLIC_SUITE_SERVICE="$service" PUBLIC_SUITE_ACTION="$kind" "$script_path"
  )
}

run_service() {
  local service="$1"
  local env_name=""
  local script_path=""
  env_name="$(command_var_for_service "$service" "deploy")"
  script_path="$(validate_host_command "$env_name" "${!env_name:-}")"
  run_host_command "$service" "deploy" "$env_name" "$script_path"
}

run_verify() {
  local service="$1"
  local env_name=""
  local script_path=""
  env_name="$(command_var_for_service "$service" "verify")"
  script_path="$(validate_host_command "$env_name" "${!env_name:-}")"
  run_host_command "$service" "verify" "$env_name" "$script_path"
}

IFS=',' read -r -a selected <<< "$SERVICES"
for service in "${selected[@]}"; do
  run_service "$service"
  if [ "$VERIFY" -eq 1 ]; then
    run_verify "$service"
  fi
done

echo "[deploy] complete (verify=$VERIFY)"
