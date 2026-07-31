#!/usr/bin/env bash
set -Eeuo pipefail

QUOTEOPS_HOME="${QUOTEOPS_HOME:-/opt/quoteops-v1}"
ENV_FILE="${QUOTEOPS_ENV_FILE:-$QUOTEOPS_HOME/.env}"
BACKUP_FILE=""
ACCESS_SOURCE_FILE=""
ENV_FILE_SET=0
WORK_DIR=""
ACCESS_ENV_FILE=""
ACCESS_COPIED=0
KEEP_ACCESS=0

usage() {
  cat <<USAGE
Usage: $(basename "$0") --backup backup-file [options]

Options:
  --home PATH                       Appliance data root
  --env-file PATH                   Shared env file (default: <home>/.env)
  --cloudflare-access-file PATH     Fresh caller-owned mode-0600 Service Auth file
  --compose-file PATH               Deprecated; the active release compose file is used
  -h, --help                        Show this help
USAGE
}

die() {
  printf 'restore.sh: %s\n' "$*" >&2
  exit 1
}

require_value() {
  [[ -n "${2:-}" && "${2:-}" != --* ]] || die "$1 requires a value"
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

absolute_existing_file() {
  local path="$1"
  local directory
  directory="$(cd "$(dirname "$path")" && pwd -P)" ||
    die "cannot resolve path: $path"
  printf '%s/%s\n' "$directory" "$(basename "$path")"
}

read_env_value() {
  local key="$1"
  local file="$2"
  local value
  [[ -f "$file" && ! -L "$file" ]] || return 1
  value="$(
    awk -v key="$key" -F= '
      $1 == key { count++; value=substr($0,index($0,"=")+1) }
      END { if (count == 1) print value; else exit 1 }
    ' "$file"
  )" || return 1
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value#\"}"
    value="${value%\"}"
  fi
  [[ -n "$value" && "$value" != *$'\n'* && "$value" != *$'\r'* ]] ||
    return 1
  printf '%s' "$value"
}

mode_of() {
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

validate_deployment_json() {
  jq -e '
    type == "object" and
    keys == ["active_version","previous_version"] and
    (.active_version | type == "string" and test("^v[0-9]+[.][0-9]+[.][0-9]+$")) and
    (.previous_version | type == "string" and test("^v[0-9]+[.][0-9]+[.][0-9]+$"))
  ' "$1" >/dev/null
}

validate_backup_manifest() {
  jq -e '
    type == "object" and
    keys == ["client_id","created_at","includes","installation_id","quoteops_version","required_secret_keys","schema_version"] and
    .schema_version == 1 and
    (.client_id | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._-]*$")) and
    (.installation_id | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._-]*$")) and
    (.quoteops_version | type == "string" and test("^v[0-9]+[.][0-9]+[.][0-9]+$")) and
    (.created_at | type == "string" and
      test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.]([0-9]{3})Z$")) and
    .includes == ["postgres.sql","manifests","criteria","connectors","settings","state"] and
    (.required_secret_keys | type == "array" and length >= 2 and
      all(.[]; type == "string" and test("^[A-Z_][A-Z0-9_]*$")) and
      . == (sort | unique) and
      index("POSTGRES_PASSWORD") != null and
      index("QUOTEOPS_REGISTRATION_TOKEN") != null)
  ' "$1" >/dev/null
}

validate_cloudflare_json() {
  jq -e '
    type == "object" and
    keys == ["origin_url","provider","public_hostname"] and
    .provider == "cloudflare" and
    .origin_url == "http://caddy:80" and
    (.public_hostname | type == "string" and
      test("^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$"))
  ' "$1" >/dev/null
}

copy_access_credentials() {
  local source="$ACCESS_SOURCE_FILE"
  local keys
  local client_id
  local client_secret
  local temporary
  if [[ -z "$source" ]]; then
    [[ -t 0 && -r /dev/tty ]] ||
      die "Cloudflare Access credentials required; resume with --cloudflare-access-file /absolute/mode-0600-file"
    temporary="$WORK_DIR/prompted-cloudflare-access.env"
    umask 077
    printf 'Cloudflare Access Client ID: ' >/dev/tty
    IFS= read -r client_id </dev/tty
    printf 'Cloudflare Access Client Secret: ' >/dev/tty
    IFS= read -r -s client_secret </dev/tty
    printf '\n' >/dev/tty
    printf 'CF_ACCESS_CLIENT_ID=%s\nCF_ACCESS_CLIENT_SECRET=%s\n' \
      "$client_id" "$client_secret" >"$temporary"
    source="$temporary"
  else
    [[ "$source" == /* ]] ||
      die "--cloudflare-access-file must be absolute"
    source="$(absolute_existing_file "$source")"
    [[ -f "$source" && ! -L "$source" && -O "$source" ]] ||
      die "Cloudflare Access source must be caller-owned regular file"
    [[ "$(mode_of "$source")" == 600 ]] ||
      die "Cloudflare Access source must be mode 0600"
  fi
  keys="$(
    awk -F= '/^[A-Z_][A-Z0-9_]*=/ {print $1}' "$source" |
      LC_ALL=C sort |
      tr '\n' ' '
  )"
  [[ "$keys" == "CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET " ]] ||
    die "Cloudflare Access source contains unknown or duplicate keys"
  client_id="$(read_env_value CF_ACCESS_CLIENT_ID "$source")" ||
    die "Cloudflare Access source must contain one client ID"
  client_secret="$(read_env_value CF_ACCESS_CLIENT_SECRET "$source")" ||
    die "Cloudflare Access source must contain one client secret"
  [[ "$client_id" =~ ^[A-Za-z0-9._~-]+$ &&
     "$client_secret" =~ ^[A-Za-z0-9._~-]+$ ]] ||
    die "Cloudflare Access values must be single-line safe values"
  mkdir -p "$QUOTEOPS_HOME/secrets"
  temporary="$QUOTEOPS_HOME/secrets/.cloudflare-access-validation.env.tmp.$$"
  umask 077
  printf 'CF_ACCESS_CLIENT_ID=%s\nCF_ACCESS_CLIENT_SECRET=%s\n' \
    "$client_id" "$client_secret" >"$temporary"
  chmod 600 "$temporary"
  mv -f "$temporary" "$ACCESS_ENV_FILE"
  ACCESS_COPIED=1
  unset client_id client_secret
}

cleanup() {
  local status=$?
  if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then
    rm -rf "$WORK_DIR"
  fi
  if [[ "$ACCESS_COPIED" -eq 1 && "$KEEP_ACCESS" -eq 0 ]]; then
    rm -f "$ACCESS_ENV_FILE"
  fi
  exit "$status"
}
trap cleanup EXIT

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
    --cloudflare-access-file)
      require_value "$1" "${2:-}"
      ACCESS_SOURCE_FILE="$2"
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

[[ -n "$BACKUP_FILE" ]] || die "--backup is required"
need_command jq
need_command tar
need_command awk
need_command cmp
need_command docker
if ! command -v sha256sum >/dev/null 2>&1; then
  need_command shasum
fi

[[ -d "$QUOTEOPS_HOME" && ! -L "$QUOTEOPS_HOME" ]] ||
  die "home must be a physical directory"
QUOTEOPS_HOME="$(cd "$QUOTEOPS_HOME" && pwd -P)"
[[ "$QUOTEOPS_HOME" != "/" ]] || die "home cannot be /"
ENV_FILE="$(absolute_existing_file "$ENV_FILE")"
BACKUP_FILE="$(absolute_existing_file "$BACKUP_FILE")"
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] ||
  die "env file must be a regular file"
[[ -f "$BACKUP_FILE" && ! -L "$BACKUP_FILE" && -r "$BACKUP_FILE" ]] ||
  die "backup must be a readable regular file"
[[ -L "$QUOTEOPS_HOME/current" ]] || die "current release link is missing"
ACTIVE_RELEASE="$(cd "$QUOTEOPS_HOME/current" && pwd -P)"
case "$ACTIVE_RELEASE" in
  "$QUOTEOPS_HOME"/releases/v[0-9]*.[0-9]*.[0-9]*) ;;
  *) die "current release escaped the release directory" ;;
esac
RELEASE_ENV_FILE="$ACTIVE_RELEASE/release.env"
COMPOSE_FILE="$ACTIVE_RELEASE/docker-compose.yml"
[[ -f "$RELEASE_ENV_FILE" && -f "$COMPOSE_FILE" ]] ||
  die "active release metadata is missing"
ACTIVE_VERSION="$(read_env_value QUOTEOPS_VERSION "$RELEASE_ENV_FILE")" ||
  die "active release.env is invalid"
[[ "$ACTIVE_VERSION" =~ ^v[0-9]+[.][0-9]+[.][0-9]+$ &&
   "$(basename "$ACTIVE_RELEASE")" == "$ACTIVE_VERSION" ]] ||
  die "active release identity is invalid"

DEPLOYMENT_FILE="$QUOTEOPS_HOME/state/deployment.json"
DEPLOYMENT_MISSING=0
if [[ -e "$DEPLOYMENT_FILE" ]]; then
  [[ -f "$DEPLOYMENT_FILE" && ! -L "$DEPLOYMENT_FILE" ]] ||
    die "deployment state must be a regular file"
  validate_deployment_json "$DEPLOYMENT_FILE" ||
    die "deployment state failed exact-schema validation"
  [[ "$(jq -er '.active_version' "$DEPLOYMENT_FILE")" == "$ACTIVE_VERSION" ]] ||
    die "deployment state does not match current"
else
  DEPLOYMENT_MISSING=1
fi

# shellcheck disable=SC1090
set -a
. "$ENV_FILE"
set +a
QUOTEOPS_CLIENT_ID="${QUOTEOPS_CLIENT_ID:-}"
QUOTEOPS_INSTALLATION_ID="${QUOTEOPS_INSTALLATION_ID:-}"
POSTGRES_DB="${POSTGRES_DB:-quoteops}"
POSTGRES_USER="${POSTGRES_USER:-quoteops}"
QUOTEOPS_BACKUP_DIR="${QUOTEOPS_BACKUP_DIR:-$QUOTEOPS_HOME/backups}"
CLIENT_ENV_FILE="${QUOTEOPS_CLIENT_ENV_FILE:-$QUOTEOPS_HOME/secrets/client.env}"
CLOUDFLARE_ENV_FILE="${QUOTEOPS_CLOUDFLARE_ENV_FILE:-$QUOTEOPS_HOME/secrets/cloudflare.env}"
[[ "$POSTGRES_DB" =~ ^[A-Za-z_][A-Za-z0-9_]*$ &&
   "$POSTGRES_USER" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
  die "PostgreSQL identifiers are invalid"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/quoteops-restore.XXXXXX")"
chmod 700 "$WORK_DIR"
ARCHIVE_LIST="$WORK_DIR/archive-list"
ARCHIVE_TYPES="$WORK_DIR/archive-types"
tar -tzf "$BACKUP_FILE" >"$ARCHIVE_LIST" ||
  die "backup archive is unreadable"
tar -tvzf "$BACKUP_FILE" >"$ARCHIVE_TYPES" ||
  die "backup archive metadata is unreadable"
awk '$1 !~ /^[-d]/ { exit 1 }' "$ARCHIVE_TYPES" ||
  die "backup archive contains a link or unsupported member"
NORMALIZED_LIST="$WORK_DIR/normalized-list"
: >"$NORMALIZED_LIST"
while IFS= read -r member; do
  normalized="$member"
  while [[ "$normalized" == ./* ]]; do normalized="${normalized#./}"; done
  [[ -n "$normalized" ]] || continue
  [[ "$normalized" != /* &&
     "$normalized" != .. &&
     "$normalized" != ../* &&
     "$normalized" != */../* &&
     "$normalized" != */.. &&
     "$normalized" != *$'\n'* &&
     "$normalized" != *$'\r'* ]] ||
    die "backup archive contains an unsafe member"
  case "$normalized" in
    backup-manifest.json|SHA256SUMS|postgres.sql|\
    manifests|manifests/*|criteria|criteria/*|connectors|connectors/*|\
    settings|settings/*|state|state/*) ;;
    *) die "backup archive contains an unmanifested member: $normalized" ;;
  esac
  printf '%s\n' "$normalized" >>"$NORMALIZED_LIST"
done <"$ARCHIVE_LIST"
[[ "$(LC_ALL=C sort "$NORMALIZED_LIST" | uniq -d | wc -l | tr -d ' ')" == 0 ]] ||
  die "backup archive contains duplicate members"

EXTRACTED="$WORK_DIR/extracted"
mkdir "$EXTRACTED"
tar -xzf "$BACKUP_FILE" -C "$EXTRACTED"
for required in backup-manifest.json SHA256SUMS postgres.sql; do
  [[ -f "$EXTRACTED/$required" && ! -L "$EXTRACTED/$required" ]] ||
    die "backup is missing $required"
done
for required_dir in manifests criteria connectors settings state; do
  [[ -d "$EXTRACTED/$required_dir" && ! -L "$EXTRACTED/$required_dir" ]] ||
    die "backup is missing $required_dir"
done
validate_backup_manifest "$EXTRACTED/backup-manifest.json" ||
  die "backup-manifest.json failed exact-schema validation"
[[ "$(jq -er '.client_id' "$EXTRACTED/backup-manifest.json")" == "$QUOTEOPS_CLIENT_ID" &&
   "$(jq -er '.installation_id' "$EXTRACTED/backup-manifest.json")" == "$QUOTEOPS_INSTALLATION_ID" ]] ||
  die "backup identity does not match this installation"
[[ ! -e "$EXTRACTED/state/deployment.json" ]] ||
  die "backup contains a stale deployment pointer"

CHECKSUM_NAMES="$WORK_DIR/checksum-names"
if ! awk '
  /^[a-f0-9]{64}  [A-Za-z0-9._\/-]+$/ {
    name=substr($0,67)
    if (name == "SHA256SUMS" || name ~ /^\// || name ~ /(^|\/)[.][.](\/|$)/ || seen[name]++) exit 1
    print name
    next
  }
  { exit 1 }
' "$EXTRACTED/SHA256SUMS" >"$CHECKSUM_NAMES"; then
  die "backup checksums have an invalid shape"
fi
(
  cd "$EXTRACTED"
  LC_ALL=C find . -type f ! -name SHA256SUMS -print |
    sed 's#^[.]/##' |
    LC_ALL=C sort
) >"$WORK_DIR/actual-files"
LC_ALL=C sort "$CHECKSUM_NAMES" >"$WORK_DIR/checksum-files"
cmp -s "$WORK_DIR/actual-files" "$WORK_DIR/checksum-files" ||
  die "backup checksum inventory is not exact"
(
  cd "$EXTRACTED"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c SHA256SUMS >/dev/null
  else
    shasum -a 256 -c SHA256SUMS >/dev/null
  fi
) || die "backup checksum verification failed"

AVAILABLE_SECRET_KEYS="$WORK_DIR/available-secret-keys"
{
  for secret_file in "$CLIENT_ENV_FILE" "$CLOUDFLARE_ENV_FILE"; do
    [[ -f "$secret_file" && ! -L "$secret_file" ]] || continue
    awk -F= '/^[A-Z_][A-Z0-9_]*=.+/ { print $1 }' "$secret_file"
  done
} | LC_ALL=C sort -u >"$AVAILABLE_SECRET_KEYS"
while IFS= read -r required_key; do
  grep -Fxq "$required_key" "$AVAILABLE_SECRET_KEYS" ||
    die "required local secret key is missing: $required_key"
done < <(jq -r '.required_secret_keys[]' "$EXTRACTED/backup-manifest.json")

TUNNEL_ENABLED=0
if [[ -e "$QUOTEOPS_HOME/settings/cloudflare.json" ]]; then
  validate_cloudflare_json "$QUOTEOPS_HOME/settings/cloudflare.json" ||
    die "local Cloudflare settings failed exact-schema validation"
  TUNNEL_ENABLED=1
fi
ORIGINAL_TUNNEL_ENABLED="$TUNNEL_ENABLED"
RESTORE_TUNNEL_ENABLED=0
if [[ -e "$EXTRACTED/settings/cloudflare.json" ]]; then
  validate_cloudflare_json "$EXTRACTED/settings/cloudflare.json" ||
    die "backup Cloudflare settings failed exact-schema validation"
  RESTORE_TUNNEL_ENABLED=1
fi
ACCESS_ENV_FILE="$QUOTEOPS_HOME/secrets/cloudflare-access-validation.env"
if [[ "$ORIGINAL_TUNNEL_ENABLED" -eq 1 || "$RESTORE_TUNNEL_ENABLED" -eq 1 ]]; then
  copy_access_credentials
fi

compose() {
  local profile=()
  if [[ "$TUNNEL_ENABLED" -eq 1 ]]; then
    profile=(--profile tunnel)
  fi
  docker compose \
    --env-file "$ENV_FILE" \
    --env-file "$RELEASE_ENV_FILE" \
    -f "$COMPOSE_FILE" \
    "${profile[@]}" \
    "$@"
}

wait_for_postgres() {
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d postgres >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

reset_database() {
  compose exec -T postgres psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 <<SQL
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = '$POSTGRES_DB' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS "$POSTGRES_DB";
CREATE DATABASE "$POSTGRES_DB" OWNER "$POSTGRES_USER";
SQL
}

replace_directory() {
  local source="$1"
  local target="$2"
  [[ "$target" == "$QUOTEOPS_HOME"/* && "$target" != "$QUOTEOPS_HOME" ]] ||
    return 1
  rm -rf "$target"
  mkdir -p "$target"
  cp -R "$source/." "$target/"
}

"$ACTIVE_RELEASE/backup.sh" \
  --home "$QUOTEOPS_HOME" \
  --env-file "$ENV_FILE" \
  --output "$QUOTEOPS_BACKUP_DIR" >/dev/null

if [[ "$DEPLOYMENT_MISSING" -eq 1 ]]; then
  mkdir -p "$QUOTEOPS_HOME/state"
  deployment_tmp="$QUOTEOPS_HOME/state/.deployment.json.tmp.$$"
  jq -n --arg active "$ACTIVE_VERSION" \
    '{active_version:$active,previous_version:$active}' >"$deployment_tmp"
  chmod 600 "$deployment_tmp"
  mv -f "$deployment_tmp" "$DEPLOYMENT_FILE"
fi

PREVIOUS_FILES="$WORK_DIR/previous-files"
mkdir "$PREVIOUS_FILES"
for directory in manifests criteria connectors settings state; do
  mkdir -p "$PREVIOUS_FILES/$directory"
  if [[ -d "$QUOTEOPS_HOME/$directory" ]]; then
    cp -R "$QUOTEOPS_HOME/$directory/." "$PREVIOUS_FILES/$directory/"
  fi
done

compose config >/dev/null
compose up -d postgres redis
wait_for_postgres || die "PostgreSQL did not become ready before restore"
compose exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" \
  >"$WORK_DIR/previous-postgres.sql"

restore_previous() {
  local recovered=1
  TUNNEL_ENABLED="$ORIGINAL_TUNNEL_ENABLED"
  for directory in manifests criteria connectors settings state; do
    replace_directory "$PREVIOUS_FILES/$directory" "$QUOTEOPS_HOME/$directory" ||
      recovered=0
  done
  reset_database || recovered=0
  compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -v ON_ERROR_STOP=1 <"$WORK_DIR/previous-postgres.sql" || recovered=0
  compose up -d --remove-orphans || recovered=0
  QUOTEOPS_HOME="$QUOTEOPS_HOME" \
    "$ACTIVE_RELEASE/verify-install.sh" --resume-guided || recovered=0
  if [[ "$recovered" -eq 1 ]]; then
    rm -f "$ACCESS_ENV_FILE"
    ACCESS_COPIED=0
    return 0
  fi
  KEEP_ACCESS=1
  return 1
}

apply_restore() {
  compose stop quoteops-agent quoteops-api quoteops-web caddy cloudflared >/dev/null ||
    return 1
  for directory in manifests criteria connectors settings; do
    replace_directory "$EXTRACTED/$directory" "$QUOTEOPS_HOME/$directory" ||
      return 1
  done
  TUNNEL_ENABLED="$RESTORE_TUNNEL_ENABLED"
  local saved_deployment="$WORK_DIR/deployment.json"
  cp "$DEPLOYMENT_FILE" "$saved_deployment" || return 1
  replace_directory "$EXTRACTED/state" "$QUOTEOPS_HOME/state" || return 1
  cp "$saved_deployment" "$DEPLOYMENT_FILE" || return 1
  chmod 600 "$DEPLOYMENT_FILE" || return 1
  validate_deployment_json "$DEPLOYMENT_FILE" || return 1
  reset_database || return 1
  compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -v ON_ERROR_STOP=1 <"$EXTRACTED/postgres.sql" || return 1
  compose up -d --remove-orphans || return 1
  QUOTEOPS_HOME="$QUOTEOPS_HOME" \
    "$ACTIVE_RELEASE/verify-install.sh" --resume-guided || return 1
}

if ! apply_restore; then
  if restore_previous; then
    die "restore failed; original files and PostgreSQL data were restored and verified"
  fi
  die "restore failed and recovery health is unresolved; run quoteops onboard --resume"
fi

rm -f "$ACCESS_ENV_FILE"
ACCESS_COPIED=0
printf 'QuoteOps appliance restored from: %s\n' "$BACKUP_FILE"
