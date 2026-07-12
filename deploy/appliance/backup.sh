#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
COMPOSE_FILE="${COMPOSE_FILE:-$SCRIPT_DIR/docker-compose.yml}"
QUOTEOPS_HOME="${QUOTEOPS_HOME:-/opt/quoteops-v1}"
ENV_FILE="${QUOTEOPS_ENV_FILE:-$QUOTEOPS_HOME/.env}"
OUTPUT_DIR=""
ENV_FILE_SET=0

usage() {
  cat <<USAGE
Usage: $(basename "$0") --output /opt/quoteops-v1/backups [options]

Options:
  --home PATH          Appliance data root (default: /opt/quoteops-v1)
  --env-file PATH      Compose env file (default: <home>/.env)
  --compose-file PATH  Compose file (default: deploy/appliance/docker-compose.yml)
  -h, --help           Show this help
USAGE
}

die() {
  echo "backup.sh: $*" >&2
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

redact_env_file() {
  local file="$1"
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      ""|\#*)
        printf "%s\n" "$line"
        ;;
      *=*)
        local key="${line%%=*}"
        case "$key" in
          *PASSWORD*|*TOKEN*|*API_KEY|*KEY)
            printf "%s=\"__REDACTED__\"\n" "$key"
            ;;
          *)
            printf "%s\n" "$line"
            ;;
        esac
        ;;
      *)
        printf "%s\n" "$line"
        ;;
    esac
  done < "$file"
}

write_secret_key_inventory() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    return
  fi
  awk -F= '/^[A-Z_][A-Z0-9_]*=/ { print $1"=set" }' "$file" | sort
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      require_value "$1" "${2:-}"
      OUTPUT_DIR="$2"
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
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ -n "$OUTPUT_DIR" ]] || die "--output is required"

COMPOSE_FILE="$(absolute_path "$COMPOSE_FILE")"
ENV_FILE="$(absolute_path "$ENV_FILE")"
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd -P)"
[[ -f "$COMPOSE_FILE" ]] || die "compose file not found: $COMPOSE_FILE"
[[ -f "$ENV_FILE" ]] || die "env file not found: $ENV_FILE"

need_docker_compose
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

QUOTEOPS_MANIFEST_DIR="${QUOTEOPS_MANIFEST_DIR:-$QUOTEOPS_HOME/manifests}"
QUOTEOPS_CRITERIA_DIR="${QUOTEOPS_CRITERIA_DIR:-$QUOTEOPS_HOME/criteria}"
QUOTEOPS_CLIENT_ID="${QUOTEOPS_CLIENT_ID:-unknown-client}"
QUOTEOPS_VERSION="${QUOTEOPS_VERSION:-unknown-version}"
POSTGRES_DB="${POSTGRES_DB:-quoteops}"
POSTGRES_USER="${POSTGRES_USER:-quoteops}"
QUOTEOPS_SECRETS_ENV_FILE="${QUOTEOPS_SECRETS_ENV_FILE:-$QUOTEOPS_HOME/secrets/client.env}"

[[ -d "$QUOTEOPS_MANIFEST_DIR" ]] || die "manifest dir not found: $QUOTEOPS_MANIFEST_DIR"
[[ -d "$QUOTEOPS_CRITERIA_DIR" ]] || die "criteria dir not found: $QUOTEOPS_CRITERIA_DIR"

TIMESTAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
SAFE_CLIENT="$(printf "%s" "$QUOTEOPS_CLIENT_ID" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_.-]/-/g')"
BACKUP_FILE="$OUTPUT_DIR/quoteops-${SAFE_CLIENT}-${QUOTEOPS_VERSION}-${TIMESTAMP}.tar.gz"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/quoteops-backup.XXXXXX")"
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

mkdir -p "$WORK_DIR/manifests" "$WORK_DIR/criteria"
cp -R "$QUOTEOPS_MANIFEST_DIR/." "$WORK_DIR/manifests/"
cp -R "$QUOTEOPS_CRITERIA_DIR/." "$WORK_DIR/criteria/"
redact_env_file "$ENV_FILE" > "$WORK_DIR/quoteops.env"
write_secret_key_inventory "$QUOTEOPS_SECRETS_ENV_FILE" > "$WORK_DIR/secrets.keys"

{
  printf "client_id=%s\n" "$QUOTEOPS_CLIENT_ID"
  printf "version=%s\n" "$QUOTEOPS_VERSION"
  printf "created_at=%s\n" "$TIMESTAMP"
  printf "postgres_db=%s\n" "$POSTGRES_DB"
  printf "postgres_user=%s\n" "$POSTGRES_USER"
  printf "secrets_env_file=%s\n" "$QUOTEOPS_SECRETS_ENV_FILE"
  printf "secrets_values_backed_up=false\n"
} > "$WORK_DIR/metadata.env"

compose config >/dev/null
compose exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > "$WORK_DIR/postgres.sql"

tar -czf "$BACKUP_FILE" -C "$WORK_DIR" .
chmod 600 "$BACKUP_FILE"

echo "$BACKUP_FILE"
