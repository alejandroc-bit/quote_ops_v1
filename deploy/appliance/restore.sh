#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
COMPOSE_FILE="${COMPOSE_FILE:-$SCRIPT_DIR/docker-compose.yml}"
QUOTEOPS_HOME="${QUOTEOPS_HOME:-/opt/quoteops}"
ENV_FILE="${QUOTEOPS_ENV_FILE:-$QUOTEOPS_HOME/.env}"
BACKUP_FILE=""
SKIP_PRE_RESTORE_BACKUP=0
ENV_FILE_SET=0

usage() {
  cat <<USAGE
Usage: $(basename "$0") --backup backup-file [options]

Options:
  --home PATH                  Appliance data root (default: /opt/quoteops)
  --env-file PATH              Compose env file (default: <home>/.env)
  --compose-file PATH          Compose file (default: deploy/appliance/docker-compose.yml)
  --skip-pre-restore-backup    Do not back up the current appliance before restore
  -h, --help                   Show this help
USAGE
}

die() {
  echo "restore.sh: $*" >&2
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

validate_pg_identifier() {
  local label="$1"
  local value="$2"
  [[ "$value" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "$label must be a PostgreSQL-safe identifier"
}

ensure_safe_dir() {
  local label="$1"
  local path="$2"
  [[ -n "$path" && "$path" == /* && "$path" != "/" ]] || die "$label must be an absolute non-root path"
}

replace_dir_from_backup() {
  local source_dir="$1"
  local target_dir="$2"
  ensure_safe_dir "restore target" "$target_dir"
  mkdir -p "$target_dir"
  find "$target_dir" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  cp -R "$source_dir/." "$target_dir/"
}

wait_for_postgres() {
  local attempt
  for attempt in {1..30}; do
    if compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d postgres >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  die "postgres did not become ready"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup)
      require_value "$1" "${2:-}"
      BACKUP_FILE="$2"
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
    --skip-pre-restore-backup)
      SKIP_PRE_RESTORE_BACKUP=1
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

[[ -n "$BACKUP_FILE" ]] || die "--backup is required"

COMPOSE_FILE="$(absolute_path "$COMPOSE_FILE")"
ENV_FILE="$(absolute_path "$ENV_FILE")"
BACKUP_FILE="$(absolute_path "$BACKUP_FILE")"
[[ -f "$COMPOSE_FILE" ]] || die "compose file not found: $COMPOSE_FILE"
[[ -f "$ENV_FILE" ]] || die "env file not found: $ENV_FILE"
[[ -f "$BACKUP_FILE" ]] || die "backup file not found: $BACKUP_FILE"
[[ -r "$BACKUP_FILE" ]] || die "backup file is not readable: $BACKUP_FILE"

need_docker_compose
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

QUOTEOPS_MANIFEST_DIR="${QUOTEOPS_MANIFEST_DIR:-$QUOTEOPS_HOME/manifests}"
QUOTEOPS_CRITERIA_DIR="${QUOTEOPS_CRITERIA_DIR:-$QUOTEOPS_HOME/criteria}"
QUOTEOPS_BACKUP_DIR="${QUOTEOPS_BACKUP_DIR:-$QUOTEOPS_HOME/backups}"
POSTGRES_DB="${POSTGRES_DB:-quoteops}"
POSTGRES_USER="${POSTGRES_USER:-quoteops}"
validate_pg_identifier "POSTGRES_DB" "$POSTGRES_DB"
validate_pg_identifier "POSTGRES_USER" "$POSTGRES_USER"
ensure_safe_dir "QUOTEOPS_MANIFEST_DIR" "$QUOTEOPS_MANIFEST_DIR"
ensure_safe_dir "QUOTEOPS_CRITERIA_DIR" "$QUOTEOPS_CRITERIA_DIR"
ensure_safe_dir "QUOTEOPS_BACKUP_DIR" "$QUOTEOPS_BACKUP_DIR"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/quoteops-restore.XXXXXX")"
LIST_FILE="$WORK_DIR/archive-list.txt"
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

tar -tzf "$BACKUP_FILE" > "$LIST_FILE"
while IFS= read -r member; do
  case "$member" in
    /*|../*|*/../*|*/..|..)
      die "unsafe backup archive member: $member"
      ;;
  esac
done < "$LIST_FILE"

tar -xzf "$BACKUP_FILE" -C "$WORK_DIR"
[[ -f "$WORK_DIR/postgres.sql" ]] || die "backup is missing postgres.sql"
[[ -d "$WORK_DIR/manifests" ]] || die "backup is missing manifests/"
[[ -d "$WORK_DIR/criteria" ]] || die "backup is missing criteria/"

if [[ "$SKIP_PRE_RESTORE_BACKUP" -eq 0 ]]; then
  "$SCRIPT_DIR/backup.sh" --env-file "$ENV_FILE" --compose-file "$COMPOSE_FILE" --output "$QUOTEOPS_BACKUP_DIR" >/dev/null
fi

compose config >/dev/null
compose up -d postgres redis
wait_for_postgres
compose stop quoteops-agent quoteops-api quoteops-web caddy >/dev/null

PRE_RESTORE_DIR="$QUOTEOPS_BACKUP_DIR/pre-restore-$(date -u +"%Y%m%dT%H%M%SZ")"
mkdir -p "$PRE_RESTORE_DIR"
if [[ -d "$QUOTEOPS_MANIFEST_DIR" ]]; then
  mkdir -p "$PRE_RESTORE_DIR/manifests"
  cp -R "$QUOTEOPS_MANIFEST_DIR/." "$PRE_RESTORE_DIR/manifests/"
fi
if [[ -d "$QUOTEOPS_CRITERIA_DIR" ]]; then
  mkdir -p "$PRE_RESTORE_DIR/criteria"
  cp -R "$QUOTEOPS_CRITERIA_DIR/." "$PRE_RESTORE_DIR/criteria/"
fi

replace_dir_from_backup "$WORK_DIR/manifests" "$QUOTEOPS_MANIFEST_DIR"
replace_dir_from_backup "$WORK_DIR/criteria" "$QUOTEOPS_CRITERIA_DIR"

compose exec -T postgres psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 <<SQL
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = '$POSTGRES_DB' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS "$POSTGRES_DB";
CREATE DATABASE "$POSTGRES_DB" OWNER "$POSTGRES_USER";
SQL

compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 < "$WORK_DIR/postgres.sql"
compose up -d

echo "QuoteOps appliance restored from: $BACKUP_FILE"
echo "Pre-restore files saved under: $PRE_RESTORE_DIR"
