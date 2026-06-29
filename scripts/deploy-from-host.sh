#!/usr/bin/env bash
set -euo pipefail

ROOT="$(pwd)"
CONFIRM=0
ALLOW_DIRTY=0
SERVICES="vcs,abyss,mmo"
VERIFY=1

usage() {
  cat <<'EOF'
Usage:
  bash scripts/deploy-from-host.sh --confirm [--root <path>] [--services vcs,abyss,mmo] [--allow-dirty] [--skip-verify]

Environment overrides:
  VCS_DEPLOY_COMMAND    default: cd services/vcs && bun run deploy
  ABYSS_DEPLOY_COMMAND  default: cd services/abyss && bun run deploy
  MMO_DEPLOY_COMMAND    required for MMO deploys
  VCS_VERIFY_COMMAND    service-specific post-deploy verification
  ABYSS_VERIFY_COMMAND  service-specific post-deploy verification
  MMO_VERIFY_COMMAND    service-specific post-deploy verification
  DEPLOY_VERIFY_COMMAND generic post-deploy verification; {service} is replaced
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

run_service() {
  local service="$1"
  local command=""
  case "$service" in
    vcs)
      command="${VCS_DEPLOY_COMMAND:-cd services/vcs && bun run deploy}"
      ;;
    abyss)
      command="${ABYSS_DEPLOY_COMMAND:-cd services/abyss && bun run deploy}"
      ;;
    mmo)
      if [ -z "${MMO_DEPLOY_COMMAND:-}" ]; then
        echo "[deploy] MMO_DEPLOY_COMMAND is required for MMO deploys" >&2
        exit 1
      fi
      command="$MMO_DEPLOY_COMMAND"
      ;;
    *)
      echo "[deploy] unknown service: $service" >&2
      exit 1
      ;;
  esac

  echo "[deploy] $service: $command"
  (cd "$ROOT" && sh -lc "$command")
}

package_has_verify_script() {
  local service="$1"
  [ -f "$ROOT/services/$service/package.json" ] || return 1
  node -e 'const p=require(process.argv[1]); process.exit(p.scripts && p.scripts["verify:deploy"] ? 0 : 1)' \
    "$ROOT/services/$service/package.json"
}

run_verify() {
  local service="$1"
  local upper="${service^^}"
  local service_var="${upper}_VERIFY_COMMAND"
  local command="${!service_var:-}"
  if [ -z "$command" ] && [ -n "${DEPLOY_VERIFY_COMMAND:-}" ]; then
    command="${DEPLOY_VERIFY_COMMAND//\{service\}/$service}"
  fi
  if [ -z "$command" ] && package_has_verify_script "$service"; then
    command="cd services/$service && bun run verify:deploy"
  fi
  if [ -z "$command" ]; then
    echo "[deploy] post-deploy verification command required for $service" >&2
    echo "[deploy] set ${upper}_VERIFY_COMMAND, DEPLOY_VERIFY_COMMAND, or add services/$service verify:deploy" >&2
    exit 1
  fi

  echo "[deploy] verify $service: $command"
  (cd "$ROOT" && sh -lc "$command")
}

IFS=',' read -r -a selected <<< "$SERVICES"
for service in "${selected[@]}"; do
  run_service "$service"
  if [ "$VERIFY" -eq 1 ]; then
    run_verify "$service"
  fi
done

echo "[deploy] complete (verify=$VERIFY)"
