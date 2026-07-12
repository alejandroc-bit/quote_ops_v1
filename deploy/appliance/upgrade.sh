#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
COMPOSE_FILE="${COMPOSE_FILE:-$SCRIPT_DIR/docker-compose.yml}"
QUOTEOPS_HOME="${QUOTEOPS_HOME:-/opt/quoteops-v1}"
ENV_FILE="${QUOTEOPS_ENV_FILE:-$QUOTEOPS_HOME/.env}"
TO_VERSION=""
SKIP_BACKUP=0
ENV_FILE_SET=0

usage() {
  cat <<USAGE
Usage: $(basename "$0") --to v0.1.1 [options]

Options:
  --home PATH          Appliance data root (default: /opt/quoteops-v1)
  --env-file PATH      Compose env file (default: <home>/.env)
  --compose-file PATH  Compose file (default: deploy/appliance/docker-compose.yml)
  --skip-backup        Do not create a pre-upgrade backup
  -h, --help           Show this help
USAGE
}

die() {
  echo "upgrade.sh: $*" >&2
  exit 1
}

require_value() {
  local flag="$1"
  local value="${2:-}"
  [[ -n "$value" && "$value" != --* ]] || die "$flag requires a value"
}

absolute_path() {
  local path="$1"
  local dir
  local base
  dir="$(cd "$(dirname "$path")" && pwd -P)" || die "cannot resolve path: $path"
  base="$(basename "$path")"
  printf "%s/%s\n" "$dir" "$base"
}

need_docker_compose() {
  command -v docker >/dev/null 2>&1 || die "docker is required"
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required"
}

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

update_env_key() {
  local key="$1"
  local value="$2"
  local tmp="$ENV_FILE.tmp.$$"
  awk -v key="$key" -v value="$value" '
    BEGIN { found = 0 }
    $0 ~ "^" key "=" {
      print key "=\"" value "\""
      found = 1
      next
    }
    { print }
    END {
      if (found == 0) {
        print key "=\"" value "\""
      }
    }
  ' "$ENV_FILE" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --to)
      require_value "$1" "${2:-}"
      TO_VERSION="$2"
      shift 2
      ;;
    --home)
      require_value "$1" "${2:-}"
      QUOTEOPS_HOME="$2"
      if [[ "$ENV_FILE_SET" -eq 0 ]]; then
        ENV_FILE="$QUOTEOPS_HOME/.env"
      fi
      shift 2
      ;;
    --env-file)
      require_value "$1" "${2:-}"
      ENV_FILE="$2"
      ENV_FILE_SET=1
      shift 2
      ;;
    --compose-file)
      require_value "$1" "${2:-}"
      COMPOSE_FILE="$2"
      shift 2
      ;;
    --skip-backup)
      SKIP_BACKUP=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ -n "$TO_VERSION" ]] || die "--to is required"
[[ "$TO_VERSION" =~ ^v[0-9]+[.][0-9]+[.][0-9]+([-+A-Za-z0-9.]+)?$ ]] || die "--to must look like v0.1.1"

COMPOSE_FILE="$(absolute_path "$COMPOSE_FILE")"
ENV_FILE="$(absolute_path "$ENV_FILE")"
[[ -f "$COMPOSE_FILE" ]] || die "compose file not found: $COMPOSE_FILE"
[[ -f "$ENV_FILE" ]] || die "env file not found: $ENV_FILE"

need_docker_compose
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

BACKUP_DIR="${QUOTEOPS_BACKUP_DIR:-$QUOTEOPS_HOME/backups}"
if [[ "$SKIP_BACKUP" -eq 0 ]]; then
  "$SCRIPT_DIR/backup.sh" --env-file "$ENV_FILE" --compose-file "$COMPOSE_FILE" --output "$BACKUP_DIR"
fi

update_env_key QUOTEOPS_VERSION "$TO_VERSION"

compose config >/dev/null
compose pull quoteops-agent quoteops-api quoteops-web caddy
compose up -d --remove-orphans quoteops-agent quoteops-api quoteops-web caddy

echo "QuoteOps appliance upgraded to: $TO_VERSION"
