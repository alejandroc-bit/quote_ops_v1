#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
QUOTEOPS_HOME="${QUOTEOPS_HOME:-/opt/quoteops-v1}"
ENV_FILE="${QUOTEOPS_ENV_FILE:-$QUOTEOPS_HOME/.env}"
TO_VERSION=""
ROLLBACK=0
SKIP_BACKUP=0
ENV_FILE_SET=0
ACCESS_SOURCE_FILE=""
WORK_DIR=""
ACCESS_ENV_FILE=""
ACCESS_COPIED=0
SWITCHED=0
KEEP_ACCESS=0

usage() {
  cat <<USAGE
Usage: $(basename "$0") --to v0.2.1 [options]
       $(basename "$0") --rollback [options]

Options:
  --home PATH                       Appliance data root
  --env-file PATH                   Shared env file (default: <home>/.env)
  --cloudflare-access-file PATH     Caller-owned regular mode-0600 Service Auth file
  --skip-backup                     Skip the pre-update backup
  --rollback                        Switch to deployment.json.previous_version
  -h, --help                        Show this help
USAGE
}

die() {
  printf 'upgrade.sh: %s\n' "$*" >&2
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

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
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

validate_release_manifest() {
  local manifest="$1"
  local expected_version="$2"
  jq -e --arg version "$expected_version" '
    type == "object" and
    keys == ["created_at","files_sha256","git_sha","images","platform","schema_version","version"] and
    .schema_version == 1 and
    .version == $version and
    (.version | test("^v[0-9]+[.][0-9]+[.][0-9]+$")) and
    (.git_sha | type == "string" and test("^[a-f0-9]{40}$")) and
    .platform == "linux/amd64" and
    (.created_at | type == "string" and
      test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.]([0-9]{3})Z$")) and
    (.images | type == "object" and
      keys == ["agent","api","caddy","cloudflared","postgres","redis","web"] and
      all(.[]; type == "string" and test("@sha256:[a-f0-9]{64}$"))) and
    (.files_sha256 | type == "object" and length > 0 and
      all(to_entries[];
        (.key | test("^[A-Za-z0-9._/-]+$") and
          (startswith("/") | not) and
          (contains("../") | not)) and
        (.value | type == "string" and test("^[a-f0-9]{64}$"))))
  ' "$manifest" >/dev/null
}

expected_release_env() {
  jq -r '
    [
      "QUOTEOPS_VERSION=" + .version,
      "QUOTEOPS_PLATFORM=" + .platform,
      "QUOTEOPS_AGENT_IMAGE=" + .images.agent,
      "QUOTEOPS_API_IMAGE=" + .images.api,
      "QUOTEOPS_WEB_IMAGE=" + .images.web,
      "QUOTEOPS_POSTGRES_IMAGE=" + .images.postgres,
      "QUOTEOPS_REDIS_IMAGE=" + .images.redis,
      "QUOTEOPS_CADDY_IMAGE=" + .images.caddy,
      "QUOTEOPS_CLOUDFLARED_IMAGE=" + .images.cloudflared
    ] | .[]
  ' "$1"
}

verify_payload_checksums() {
  local directory="$1"
  local expected_sums="$WORK_DIR/expected-payload-sums"
  (
    cd "$directory"
    {
      jq -r '.files_sha256 | keys[]' release.json
      printf '%s\n' release.json
    } | LC_ALL=C sort |
      while IFS= read -r file; do
        printf '%s  %s\n' "$(sha256_file "$file")" "$file"
      done >"$expected_sums"
    cmp -s "$expected_sums" PAYLOAD_SHA256SUMS
  ) || return 1
  (
    cd "$directory"
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum -c PAYLOAD_SHA256SUMS >/dev/null
    else
      shasum -a 256 -c PAYLOAD_SHA256SUMS >/dev/null
    fi
  )
}

validate_release_directory() {
  local directory="$1"
  local expected_version="$2"
  local expected_env="$WORK_DIR/expected-release.env"
  local file
  local expected
  [[ -d "$directory" && ! -L "$directory" ]] || return 1
  [[ -f "$directory/release.json" &&
     -f "$directory/PAYLOAD_SHA256SUMS" &&
     -f "$directory/release.env" &&
     -f "$directory/docker-compose.yml" &&
     -x "$directory/verify-install.sh" ]] || return 1
  validate_release_manifest "$directory/release.json" "$expected_version" ||
    return 1
  expected_release_env "$directory/release.json" >"$expected_env"
  cmp -s "$expected_env" "$directory/release.env" || return 1
  while IFS=$'\t' read -r file expected; do
    [[ -f "$directory/$file" && ! -L "$directory/$file" ]] || return 1
    [[ "$(sha256_file "$directory/$file")" == "$expected" ]] || return 1
  done < <(jq -r '.files_sha256 | to_entries[] | [.key,.value] | @tsv' "$directory/release.json")
  verify_payload_checksums "$directory"
}

validate_archive_and_extract() {
  local archive="$1"
  local directory="$2"
  local expected_version="$3"
  local listing="$WORK_DIR/archive-members"
  local types="$WORK_DIR/archive-types"
  local actual_inventory="$WORK_DIR/actual-inventory"
  local expected_inventory="$WORK_DIR/expected-inventory"
  tar -tzf "$archive" >"$listing" || die "release archive is unreadable"
  [[ -s "$listing" ]] || die "release archive is empty"
  while IFS= read -r member; do
    [[ -n "$member" &&
       "$member" != /* &&
       "$member" != .. &&
       "$member" != ../* &&
       "$member" != */../* &&
       "$member" != */.. &&
       "$member" != *$'\n'* &&
       "$member" != *$'\r'* ]] ||
      die "release archive contains an unsafe member"
  done <"$listing"
  tar -tvzf "$archive" >"$types" || die "release archive metadata is unreadable"
  awk '$1 !~ /^-/ { exit 1 }' "$types" ||
    die "release archive contains a link or non-file member"
  mkdir -p "$directory"
  tar -xzf "$archive" -C "$directory"
  [[ -f "$directory/release.json" && ! -L "$directory/release.json" ]] ||
    die "release archive is missing release.json"
  validate_release_manifest "$directory/release.json" "$expected_version" ||
    die "release.json failed exact-schema validation"
  LC_ALL=C sort "$listing" >"$actual_inventory"
  {
    jq -r '.files_sha256 | keys[]' "$directory/release.json"
    printf '%s\n' PAYLOAD_SHA256SUMS release.json
  } | LC_ALL=C sort >"$expected_inventory"
  cmp -s "$actual_inventory" "$expected_inventory" ||
    die "release archive inventory does not match release.json"
  validate_release_directory "$directory" "$expected_version" ||
    die "release payload checksum or metadata validation failed"
}

write_deployment_state() {
  local active="$1"
  local previous="$2"
  local temporary="$QUOTEOPS_HOME/state/.deployment.json.tmp.$$"
  mkdir -p "$QUOTEOPS_HOME/state"
  jq -n --arg active "$active" --arg previous "$previous" \
    '{active_version:$active,previous_version:$previous}' >"$temporary"
  chmod 600 "$temporary"
  mv -f "$temporary" "$QUOTEOPS_HOME/state/deployment.json"
}

switch_current() {
  local version="$1"
  local temporary="$QUOTEOPS_HOME/.current.tmp.$$"
  rm -f "$temporary"
  ln -s "releases/$version" "$temporary"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    mv -fh "$temporary" "$QUOTEOPS_HOME/current"
  else
    mv -fT "$temporary" "$QUOTEOPS_HOME/current"
  fi
}

compose_release() {
  local directory="$1"
  shift
  local profile=()
  if [[ "$TUNNEL_ENABLED" -eq 1 ]]; then
    profile=(--profile tunnel)
  fi
  docker compose \
    --env-file "$ENV_FILE" \
    --env-file "$directory/release.env" \
    -f "$directory/docker-compose.yml" \
    "${profile[@]}" \
    "$@"
}

copy_access_credentials() {
  local source="$ACCESS_SOURCE_FILE"
  local temporary
  local client_id
  local client_secret
  local source_keys
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
    [[ "$(mode_of "$source")" == "600" ]] ||
      die "Cloudflare Access source must be mode 0600"
  fi
  client_id="$(read_env_value CF_ACCESS_CLIENT_ID "$source")" ||
    die "Cloudflare Access source must contain one client ID"
  client_secret="$(read_env_value CF_ACCESS_CLIENT_SECRET "$source")" ||
    die "Cloudflare Access source must contain one client secret"
  [[ "$client_id" =~ ^[A-Za-z0-9._~-]+$ &&
     "$client_secret" =~ ^[A-Za-z0-9._~-]+$ ]] ||
    die "Cloudflare Access values must be single-line safe values"
  source_keys="$(
    awk -F= '/^[A-Z_][A-Z0-9_]*=/ {print $1}' "$source" |
      LC_ALL=C sort |
      tr '\n' ' '
  )"
  [[ "$source_keys" == "CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET " ]] ||
    die "Cloudflare Access source contains unknown or duplicate keys"
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
    --to)
      require_value "$1" "${2:-}"
      TO_VERSION="$2"
      shift 2
      ;;
    --rollback)
      ROLLBACK=1
      shift
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
    --cloudflare-access-file)
      require_value "$1" "${2:-}"
      ACCESS_SOURCE_FILE="$2"
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

[[ "$ROLLBACK" -eq 0 || -z "$TO_VERSION" ]] ||
  die "--rollback and --to are mutually exclusive"
[[ "$ROLLBACK" -eq 1 || -n "$TO_VERSION" ]] ||
  die "--to is required"
need_command jq
need_command tar
need_command curl
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
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] ||
  die "env file must be a regular file"
[[ -L "$QUOTEOPS_HOME/current" ]] || die "current release link is missing"
CURRENT_RELEASE="$(cd "$QUOTEOPS_HOME/current" && pwd -P)"
case "$CURRENT_RELEASE" in
  "$QUOTEOPS_HOME"/releases/v[0-9]*.[0-9]*.[0-9]*) ;;
  *) die "current release escaped the release directory" ;;
esac
ACTIVE_VERSION="$(read_env_value QUOTEOPS_VERSION "$CURRENT_RELEASE/release.env")" ||
  die "active release.env is invalid"
[[ "$ACTIVE_VERSION" =~ ^v[0-9]+[.][0-9]+[.][0-9]+$ &&
   "$(basename "$CURRENT_RELEASE")" == "$ACTIVE_VERSION" ]] ||
  die "active release identity is invalid"

DEPLOYMENT_FILE="$QUOTEOPS_HOME/state/deployment.json"
if [[ -e "$DEPLOYMENT_FILE" ]]; then
  [[ -f "$DEPLOYMENT_FILE" && ! -L "$DEPLOYMENT_FILE" ]] ||
    die "deployment state must be a regular file"
  validate_deployment_json "$DEPLOYMENT_FILE" ||
    die "deployment state failed exact-schema validation"
  [[ "$(jq -er '.active_version' "$DEPLOYMENT_FILE")" == "$ACTIVE_VERSION" ]] ||
    die "deployment state does not match current"
fi

if [[ "$ROLLBACK" -eq 1 ]]; then
  [[ -f "$DEPLOYMENT_FILE" ]] ||
    die "deployment state is required for rollback"
  TO_VERSION="$(jq -er '.previous_version' "$DEPLOYMENT_FILE")"
fi
[[ "$TO_VERSION" =~ ^v[0-9]+[.][0-9]+[.][0-9]+$ ]] ||
  die "target must be an exact stable semver such as v0.2.1"
[[ "$TO_VERSION" != "$ACTIVE_VERSION" ]] ||
  die "target version is already active"

mkdir -p "$QUOTEOPS_HOME/releases"
WORK_DIR="$(mktemp -d "$QUOTEOPS_HOME/releases/.$TO_VERSION.lifecycle.XXXXXX")"
chmod 700 "$WORK_DIR"
ACCESS_ENV_FILE="$QUOTEOPS_HOME/secrets/cloudflare-access-validation.env"
TUNNEL_ENABLED=0
CLOUDFLARE_SETTINGS_FILE="$QUOTEOPS_HOME/settings/cloudflare.json"
if [[ -e "$CLOUDFLARE_SETTINGS_FILE" ]]; then
  [[ -f "$CLOUDFLARE_SETTINGS_FILE" && ! -L "$CLOUDFLARE_SETTINGS_FILE" ]] ||
    die "Cloudflare settings must be a regular file"
  validate_cloudflare_json "$CLOUDFLARE_SETTINGS_FILE" ||
    die "Cloudflare settings failed exact-schema validation"
  TUNNEL_ENABLED=1
fi

TARGET_RELEASE="$QUOTEOPS_HOME/releases/$TO_VERSION"
if [[ "$ROLLBACK" -eq 0 ]]; then
  CONTROL_PLANE_URL="$(read_env_value QUOTEOPS_CONTROL_PLANE_URL "$ENV_FILE")" ||
    die "QUOTEOPS_CONTROL_PLANE_URL is missing"
  [[ "$CONTROL_PLANE_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] ||
    die "control-plane URL must be an HTTPS origin"
  CLIENT_ENV_FILE="$(read_env_value QUOTEOPS_CLIENT_ENV_FILE "$ENV_FILE")" ||
    die "QUOTEOPS_CLIENT_ENV_FILE is missing"
  INSTALLATION_TOKEN="$(read_env_value QUOTEOPS_REGISTRATION_TOKEN "$CLIENT_ENV_FILE")" ||
    die "installation token is missing"
  [[ "${#INSTALLATION_TOKEN}" -ge 32 &&
     "$INSTALLATION_TOKEN" =~ ^[A-Za-z0-9._~-]+$ ]] ||
    die "installation token is invalid"
  CURL_CONFIG="$WORK_DIR/release-download.curl"
  umask 077
  printf 'header = "Authorization: Bearer %s"\n' "$INSTALLATION_TOKEN" >"$CURL_CONFIG"
  chmod 600 "$CURL_CONFIG"
  unset INSTALLATION_TOKEN
  ARCHIVE_FILE="$WORK_DIR/quoteops-appliance-$TO_VERSION.tar.gz"
  RESPONSE_HEADERS="$WORK_DIR/release.headers"
  curl \
    --config "$CURL_CONFIG" \
    --proto "=https" \
    --proto-redir "=https" \
    --tlsv1.2 \
    --fail \
    --silent \
    --show-error \
    --output "$ARCHIVE_FILE" \
    --dump-header "$RESPONSE_HEADERS" \
    "$CONTROL_PLANE_URL/api/releases/$TO_VERSION/appliance" ||
    die "release download failed"
  rm -f "$CURL_CONFIG"
  RESPONSE_VERSION="$(
    awk 'tolower($1) == "x-quoteops-version:" { value=$2 } END { gsub("\r","",value); print value }' \
      "$RESPONSE_HEADERS"
  )"
  RESPONSE_SHA="$(
    awk 'tolower($1) == "x-quoteops-sha256:" { value=$2 } END { gsub("\r","",value); print value }' \
      "$RESPONSE_HEADERS"
  )"
  RESPONSE_TYPE="$(
    awk 'tolower($1) == "content-type:" { value=$2 } END { gsub("\r","",value); print value }' \
      "$RESPONSE_HEADERS"
  )"
  [[ "$RESPONSE_VERSION" == "$TO_VERSION" ]] ||
    die "release response version mismatch"
  [[ "$RESPONSE_TYPE" == "application/gzip" ]] ||
    die "release response content type mismatch"
  [[ "$RESPONSE_SHA" =~ ^[a-f0-9]{64}$ &&
     "$(sha256_file "$ARCHIVE_FILE")" == "$RESPONSE_SHA" ]] ||
    die "release response checksum mismatch"
  validate_archive_and_extract "$ARCHIVE_FILE" "$WORK_DIR/payload" "$TO_VERSION"
  if [[ -e "$TARGET_RELEASE" ]]; then
    validate_release_directory "$TARGET_RELEASE" "$TO_VERSION" ||
      die "existing target release is invalid"
    [[ "$(sha256_file "$TARGET_RELEASE/release.json")" == "$(sha256_file "$WORK_DIR/payload/release.json")" ]] ||
      die "existing target release differs from downloaded release"
  else
    mv "$WORK_DIR/payload" "$TARGET_RELEASE"
  fi
else
  validate_release_directory "$TARGET_RELEASE" "$TO_VERSION" ||
    die "rollback target failed local release verification"
fi

if [[ "$TUNNEL_ENABLED" -eq 1 ]]; then
  copy_access_credentials
fi

if [[ "$ROLLBACK" -eq 0 && "$SKIP_BACKUP" -eq 0 ]]; then
  "$CURRENT_RELEASE/backup.sh" \
    --home "$QUOTEOPS_HOME" \
    --env-file "$ENV_FILE" \
    --output "${QUOTEOPS_BACKUP_DIR:-$QUOTEOPS_HOME/backups}" >/dev/null
fi

if [[ "$ROLLBACK" -eq 0 ]]; then
  compose_release "$TARGET_RELEASE" pull
fi
switch_current "$TO_VERSION"
SWITCHED=1

TARGET_OK=1
compose_release "$TARGET_RELEASE" up -d --remove-orphans || TARGET_OK=0
if [[ "$TARGET_OK" -eq 1 ]]; then
  QUOTEOPS_HOME="$QUOTEOPS_HOME" \
    "$TARGET_RELEASE/verify-install.sh" --resume-guided || TARGET_OK=0
fi

if [[ "$TARGET_OK" -ne 1 ]]; then
  switch_current "$ACTIVE_VERSION"
  RESTORED_OK=1
  compose_release "$CURRENT_RELEASE" up -d --remove-orphans || RESTORED_OK=0
  if [[ "$RESTORED_OK" -eq 1 ]]; then
    QUOTEOPS_HOME="$QUOTEOPS_HOME" \
      "$CURRENT_RELEASE/verify-install.sh" --resume-guided || RESTORED_OK=0
  fi
  if [[ "$RESTORED_OK" -eq 1 ]]; then
    rm -f "$ACCESS_ENV_FILE"
    ACCESS_COPIED=0
    die "target $TO_VERSION failed verification; restored and verified $ACTIVE_VERSION"
  fi
  KEEP_ACCESS=1
  die "target $TO_VERSION failed; rollback health for $ACTIVE_VERSION is unresolved; run quoteops onboard --resume"
fi

rm -f "$ACCESS_ENV_FILE"
ACCESS_COPIED=0
write_deployment_state "$TO_VERSION" "$ACTIVE_VERSION"
if [[ "$ROLLBACK" -eq 1 ]]; then
  printf 'QuoteOps appliance rolled back to: %s\n' "$TO_VERSION"
else
  printf 'QuoteOps appliance upgraded to: %s\n' "$TO_VERSION"
fi
