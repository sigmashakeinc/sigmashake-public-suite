#!/usr/bin/env bash
set -euo pipefail

ROOT="$(pwd)"
CONFIRM=0
ALLOW_DIRTY=0
SERVICES="vcs,abyss,mmo,obs-chat-overlay"
VERIFY=1

usage() {
  cat <<'EOF'
Usage:
  bash scripts/deploy-from-host.sh --confirm [--root <path>] [--services vcs,abyss,mmo,obs-chat-overlay] [--allow-dirty] [--skip-verify]

Environment overrides:
  VCS_DEPLOY_COMMAND               default: cd services/vcs && bun run deploy
  ABYSS_DEPLOY_COMMAND             default: cd services/abyss && bun run deploy
  MMO_DEPLOY_COMMAND               required for MMO deploys
  OBS_CHAT_OVERLAY_DEPLOY_COMMAND  required for OBS chat overlay deploys
  VCS_VERIFY_COMMAND               service-specific post-deploy verification
  ABYSS_VERIFY_COMMAND             service-specific post-deploy verification
  MMO_VERIFY_COMMAND               service-specific post-deploy verification
  OBS_CHAT_OVERLAY_VERIFY_COMMAND  service-specific post-deploy verification
  DEPLOY_VERIFY_COMMAND            generic post-deploy verification; {service} is replaced
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

ROOT="$(cd "$ROOT" && pwd)"
if [ "$ALLOW_DIRTY" -ne 1 ]; then
  dirty="$(git -C "$ROOT" status --porcelain --untracked-files=all)"
  if [ -n "$dirty" ]; then
    echo "[deploy] refusing to deploy from dirty checkout" >&2
    echo "$dirty" >&2
    exit 1
  fi
fi

env_prefix() {
  local upper="${1^^}"
  echo "${upper//-/_}"
}

deploy_command_for() {
  local service="$1"
  local command=""
  local prefix
  local command_var
  prefix="$(env_prefix "$service")"
  command_var="${prefix}_DEPLOY_COMMAND"
  command="${!command_var:-}"
  case "$service" in
    vcs)
      command="${command:-cd services/vcs && bun run deploy}"
      ;;
    abyss)
      command="${command:-cd services/abyss && bun run deploy}"
      ;;
    mmo|obs-chat-overlay)
      if [ -z "$command" ]; then
        echo "[deploy] ${command_var} is required for $service deploys" >&2
        exit 1
      fi
      ;;
    *)
      echo "[deploy] unknown service: $service" >&2
      exit 1
      ;;
  esac
  echo "$command"
}

run_service() {
  local service="$1"
  local command
  command="$(deploy_command_for "$service")"
  echo "[deploy] $service: $command"
  (cd "$ROOT" && sh -lc "$command")
}

package_has_verify_script() {
  local service="$1"
  [ -f "$ROOT/services/$service/package.json" ] || return 1
  node -e 'const p=require(process.argv[1]); process.exit(p.scripts && p.scripts["verify:deploy"] ? 0 : 1)' \
    "$ROOT/services/$service/package.json"
}

verify_command_for() {
  local service="$1"
  local prefix
  local service_var
  prefix="$(env_prefix "$service")"
  service_var="${prefix}_VERIFY_COMMAND"
  local command="${!service_var:-}"
  if [ -z "$command" ] && [ -n "${DEPLOY_VERIFY_COMMAND:-}" ]; then
    command="${DEPLOY_VERIFY_COMMAND//\{service\}/$service}"
  fi
  if [ -z "$command" ] && package_has_verify_script "$service"; then
    command="cd services/$service && bun run verify:deploy"
  fi
  if [ -z "$command" ]; then
    echo "[deploy] post-deploy verification command required for $service" >&2
    echo "[deploy] set ${service_var}, DEPLOY_VERIFY_COMMAND, or add services/$service verify:deploy" >&2
    exit 1
  fi
  echo "$command"
}

run_verify() {
  local service="$1"
  local command
  command="$(verify_command_for "$service")"
  echo "[deploy] verify $service: $command"
  (cd "$ROOT" && sh -lc "$command")
}

IFS=',' read -r -a selected <<< "$SERVICES"
for service in "${selected[@]}"; do
  deploy_command_for "$service" >/dev/null
  if [ "$VERIFY" -eq 1 ]; then
    verify_command_for "$service" >/dev/null
  fi
done

for service in "${selected[@]}"; do
  run_service "$service"
  if [ "$VERIFY" -eq 1 ]; then
    run_verify "$service"
  fi
done

echo "[deploy] complete (verify=$VERIFY)"
