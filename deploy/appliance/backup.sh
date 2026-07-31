#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
QUOTEOPS_HOME="${QUOTEOPS_HOME:-/opt/quoteops-v1}"
ENV_FILE="${QUOTEOPS_ENV_FILE:-$QUOTEOPS_HOME/.env}"
OUTPUT_DIR=""
ENV_FILE_SET=0

usage() {
  cat <<USAGE
Usage: $(basename "$0") --output /opt/quoteops-v1/backups [options]

Options:
  --home PATH          Appliance data root (default: /opt/quoteops-v1)
  --env-file PATH      Shared env file (default: <home>/.env)
  --compose-file PATH  Deprecated; the active release compose file is always used
  -h, --help           Show this help
USAGE
}

die() {
  printf 'backup.sh: %s\n' "$*" >&2
  exit 1
}

require_value() {
  [[ -n "${2:-}" && "${2:-}" != --* ]] || die "$1 requires a value"
}

absolute_existing_file() {
  local path="$1"
  local directory
  directory="$(cd "$(dirname "$path")" && pwd -P)" ||
    die "cannot resolve path: $path"
  printf '%s/%s\n' "$directory" "$(basename "$path")"
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

read_env_value() {
  local key="$1"
  local file="$2"
  local lines
  local value
  [[ -f "$file" && ! -L "$file" ]] || return 1
  lines="$(awk -v key="$key" -F= '$1 == key { count++; value=substr($0,index($0,"=")+1) } END { if (count == 1) print value; else exit 1 }' "$file")" ||
    return 1
  value="$lines"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value#\"}"
    value="${value%\"}"
  fi
  [[ -n "$value" && "$value" != *$'\n'* && "$value" != *$'\r'* ]] ||
    return 1
  printf '%s' "$value"
}

validate_deployment_json() {
  local file="$1"
  jq -e '
    type == "object" and
    keys == ["active_version","previous_version"] and
    (.active_version | type == "string" and test("^v[0-9]+[.][0-9]+[.][0-9]+$")) and
    (.previous_version | type == "string" and test("^v[0-9]+[.][0-9]+[.][0-9]+$"))
  ' "$file" >/dev/null
}

validate_cloudflare_json() {
  local file="$1"
  jq -e '
    type == "object" and
    keys == ["origin_url","provider","public_hostname"] and
    .provider == "cloudflare" and
    .origin_url == "http://caddy:80" and
    (.public_hostname | type == "string" and
      test("^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$"))
  ' "$file" >/dev/null
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
need_command jq
need_command tar
need_command awk
if ! command -v sha256sum >/dev/null 2>&1; then
  need_command shasum
fi
need_command docker
docker compose version >/dev/null 2>&1 ||
  die "Docker Compose v2 is required"

[[ -d "$QUOTEOPS_HOME" && ! -L "$QUOTEOPS_HOME" ]] ||
  die "home must be a physical directory"
QUOTEOPS_HOME="$(cd "$QUOTEOPS_HOME" && pwd -P)"
[[ "$QUOTEOPS_HOME" != "/" ]] || die "home cannot be /"
ENV_FILE="$(absolute_existing_file "$ENV_FILE")"
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] ||
  die "env file must be a regular file"
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd -P)"

[[ -L "$QUOTEOPS_HOME/current" ]] || die "current release link is missing"
ACTIVE_RELEASE="$(cd "$QUOTEOPS_HOME/current" && pwd -P)"
case "$ACTIVE_RELEASE" in
  "$QUOTEOPS_HOME"/releases/v[0-9]*.[0-9]*.[0-9]*) ;;
  *) die "current release escaped the release directory" ;;
esac
RELEASE_ENV_FILE="$ACTIVE_RELEASE/release.env"
COMPOSE_FILE="$ACTIVE_RELEASE/docker-compose.yml"
[[ -f "$RELEASE_ENV_FILE" && ! -L "$RELEASE_ENV_FILE" ]] ||
  die "active release.env is missing"
[[ -f "$COMPOSE_FILE" && ! -L "$COMPOSE_FILE" ]] ||
  die "active compose file is missing"
QUOTEOPS_VERSION="$(read_env_value QUOTEOPS_VERSION "$RELEASE_ENV_FILE")" ||
  die "active release.env has no exact QUOTEOPS_VERSION"
[[ "$QUOTEOPS_VERSION" =~ ^v[0-9]+[.][0-9]+[.][0-9]+$ ]] ||
  die "active release version is invalid"
[[ "$(basename "$ACTIVE_RELEASE")" == "$QUOTEOPS_VERSION" ]] ||
  die "current release and release.env disagree"

DEPLOYMENT_FILE="$QUOTEOPS_HOME/state/deployment.json"
if [[ -e "$DEPLOYMENT_FILE" ]]; then
  [[ -f "$DEPLOYMENT_FILE" && ! -L "$DEPLOYMENT_FILE" ]] ||
    die "deployment state must be a regular file"
  validate_deployment_json "$DEPLOYMENT_FILE" ||
    die "deployment state failed exact-schema validation"
  [[ "$(jq -er '.active_version' "$DEPLOYMENT_FILE")" == "$QUOTEOPS_VERSION" ]] ||
    die "deployment state does not match current"
fi

CLOUDFLARE_SETTINGS_FILE="$QUOTEOPS_HOME/settings/cloudflare.json"
if [[ -e "$CLOUDFLARE_SETTINGS_FILE" ]]; then
  [[ -f "$CLOUDFLARE_SETTINGS_FILE" && ! -L "$CLOUDFLARE_SETTINGS_FILE" ]] ||
    die "Cloudflare settings must be a regular file"
  validate_cloudflare_json "$CLOUDFLARE_SETTINGS_FILE" ||
    die "Cloudflare settings failed exact-schema validation"
fi

# shellcheck disable=SC1090
set -a
. "$ENV_FILE"
set +a
QUOTEOPS_CLIENT_ID="${QUOTEOPS_CLIENT_ID:-}"
QUOTEOPS_INSTALLATION_ID="${QUOTEOPS_INSTALLATION_ID:-}"
POSTGRES_DB="${POSTGRES_DB:-quoteops}"
POSTGRES_USER="${POSTGRES_USER:-quoteops}"
[[ "$QUOTEOPS_CLIENT_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] ||
  die "QUOTEOPS_CLIENT_ID is invalid"
[[ "$QUOTEOPS_INSTALLATION_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] ||
  die "QUOTEOPS_INSTALLATION_ID is invalid"
[[ "$POSTGRES_DB" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
  die "POSTGRES_DB is invalid"
[[ "$POSTGRES_USER" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
  die "POSTGRES_USER is invalid"

CLIENT_ENV_FILE="${QUOTEOPS_CLIENT_ENV_FILE:-$QUOTEOPS_HOME/secrets/client.env}"
CLOUDFLARE_ENV_FILE="${QUOTEOPS_CLOUDFLARE_ENV_FILE:-$QUOTEOPS_HOME/secrets/cloudflare.env}"
for secret_file in "$CLIENT_ENV_FILE" "$CLOUDFLARE_ENV_FILE"; do
  if [[ -e "$secret_file" ]]; then
    [[ -f "$secret_file" && ! -L "$secret_file" ]] ||
      die "secret inventory source must be a regular file"
  fi
done

TIMESTAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
CREATED_AT="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
SAFE_CLIENT="$(printf '%s' "$QUOTEOPS_CLIENT_ID" |
  tr '[:upper:]' '[:lower:]' |
  sed 's/[^a-z0-9_.-]/-/g')"
BACKUP_FILE="$OUTPUT_DIR/quoteops-$SAFE_CLIENT-$QUOTEOPS_VERSION-$TIMESTAMP.tar.gz"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/quoteops-backup.XXXXXX")"
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

for directory in manifests criteria connectors settings state; do
  mkdir -p "$WORK_DIR/$directory"
  source_directory="$QUOTEOPS_HOME/$directory"
  if [[ -d "$source_directory" ]]; then
    if find "$source_directory" -type l -print -quit | grep -q .; then
      die "$directory contains a symbolic link"
    fi
    cp -R "$source_directory/." "$WORK_DIR/$directory/"
  fi
done
rm -f "$WORK_DIR/state/deployment.json"

find "$WORK_DIR" -type f -name '*.json' -print0 |
  while IFS= read -r -d '' json_file; do
    jq -e . "$json_file" >/dev/null ||
      die "backup source contains invalid JSON: ${json_file#"$WORK_DIR/"}"
  done

REQUIRED_KEYS_FILE="$WORK_DIR/.required-secret-keys"
{
  printf '%s\n' POSTGRES_PASSWORD QUOTEOPS_REGISTRATION_TOKEN
  for secret_file in "$CLIENT_ENV_FILE" "$CLOUDFLARE_ENV_FILE"; do
    [[ -f "$secret_file" ]] || continue
    awk -F= '
      /^[A-Z_][A-Z0-9_]*=/ {
        key=$1
        if (key != "CF_ACCESS_CLIENT_ID" && key != "CF_ACCESS_CLIENT_SECRET") print key
      }
    ' "$secret_file"
  done
} | LC_ALL=C sort -u >"$REQUIRED_KEYS_FILE"
REQUIRED_KEYS_JSON="$(jq -Rsc 'split("\n") | map(select(length > 0))' "$REQUIRED_KEYS_FILE")"
rm -f "$REQUIRED_KEYS_FILE"

jq -n \
  --arg client "$QUOTEOPS_CLIENT_ID" \
  --arg installation "$QUOTEOPS_INSTALLATION_ID" \
  --arg version "$QUOTEOPS_VERSION" \
  --arg created "$CREATED_AT" \
  --argjson required "$REQUIRED_KEYS_JSON" \
  '{
    schema_version: 1,
    client_id: $client,
    installation_id: $installation,
    quoteops_version: $version,
    created_at: $created,
    includes: [
      "postgres.sql",
      "manifests",
      "criteria",
      "connectors",
      "settings",
      "state"
    ],
    required_secret_keys: $required
  }' >"$WORK_DIR/backup-manifest.json"

compose() {
  docker compose \
    --env-file "$ENV_FILE" \
    --env-file "$RELEASE_ENV_FILE" \
    -f "$COMPOSE_FILE" \
    "$@"
}
compose config >/dev/null
compose exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" \
  >"$WORK_DIR/postgres.sql"

(
  cd "$WORK_DIR"
  : >SHA256SUMS
  while IFS= read -r file; do
    file="${file#./}"
    [[ "$file" =~ ^[A-Za-z0-9._/-]+$ &&
       "$file" != *$'\n'* &&
       "$file" != *$'\r'* ]] ||
      die "backup path is not a safe portable relative path"
    printf '%s  %s\n' "$(sha256_file "$file")" "$file" >>SHA256SUMS
  done < <(LC_ALL=C find . -type f ! -name SHA256SUMS -print | LC_ALL=C sort)
)

tar -czf "$BACKUP_FILE" -C "$WORK_DIR" .
chmod 600 "$BACKUP_FILE"
printf '%s\n' "$BACKUP_FILE"
