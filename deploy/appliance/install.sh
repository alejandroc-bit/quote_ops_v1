#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
COMPOSE_FILE="${COMPOSE_FILE:-$SCRIPT_DIR/docker-compose.yml}"
QUOTEOPS_HOME="${QUOTEOPS_HOME:-/opt/quoteops-v1}"
ENV_FILE="${QUOTEOPS_ENV_FILE:-$QUOTEOPS_HOME/.env}"
SECRETS_ENV_FILE="${QUOTEOPS_SECRETS_ENV_FILE:-$QUOTEOPS_HOME/secrets/client.env}"
CLOUDFLARE_ENV_FILE="$QUOTEOPS_HOME/secrets/cloudflare.env"
CLOUDFLARE_ACCESS_ENV_FILE="$QUOTEOPS_HOME/secrets/cloudflare-access-validation.env"
CLOUDFLARE_SETTINGS_FILE="$QUOTEOPS_HOME/settings/cloudflare.json"
CLOUDFLARE_VALIDATION_RECEIPT_FILE="$QUOTEOPS_HOME/settings/cloudflare-public-validation.json"
CLIENT_ID=""
MANIFEST_PATH=""
CONNECTORS_PATH=""
AGENT_CONFIG_PATH=""
TMS_ADAPTER_CONFIG_PATH=""
TMS_MAPPING_CONFIG_PATH=""
QUOTEOPS_VERSION="${QUOTEOPS_VERSION:-}"
QUOTEOPS_IMAGE_REGISTRY="${QUOTEOPS_IMAGE_REGISTRY:-ghcr.io/alejandroc-bit}"
QUOTEOPS_SITE_ADDRESS="${QUOTEOPS_SITE_ADDRESS:-:80}"
QUOTEOPS_HTTP_PORT="${QUOTEOPS_HTTP_PORT:-80}"
QUOTEOPS_HTTPS_PORT="${QUOTEOPS_HTTPS_PORT:-443}"
QUOTEOPS_SAKBE_LIVE_ENABLED="${QUOTEOPS_SAKBE_LIVE_ENABLED:-true}"
QUOTEOPS_SAKBE_CACHE_MODE="${QUOTEOPS_SAKBE_CACHE_MODE:-cache_first}"
QUOTEOPS_CONTROL_PLANE_URL="${QUOTEOPS_CONTROL_PLANE_URL:-}"
QUOTEOPS_REGISTRATION_TOKEN="${QUOTEOPS_REGISTRATION_TOKEN:-}"
QUOTEOPS_REGISTRATION_TOKEN_FILE=""
QUOTEOPS_INSTALLATION_ID="${QUOTEOPS_INSTALLATION_ID:-}"
QUOTEOPS_PUBLIC_HOSTNAME="${QUOTEOPS_PUBLIC_HOSTNAME:-}"
INEGI_SAKBE_KEY="${INEGI_SAKBE_KEY:-}"
GEMINI_API_KEY="${GEMINI_API_KEY:-}"
OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}"
POSTGRES_DB="${POSTGRES_DB:-quoteops}"
POSTGRES_USER="${POSTGRES_USER:-quoteops}"
POSTGRES_PASSWORD_INHERITED="${POSTGRES_PASSWORD+x}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"
FORCE=0
START_STACK=1
PULL_IMAGES=1
ENV_FILE_SET=0
SECRETS_ENV_FILE_SET=0
VERSION_SET=0
GUIDED=0
RESUME_GUIDED=0
EXISTING_INSTALL=0
POSTGRES_PASSWORD_FLAG_SET=0
ANSWERS_DIR=""
ANSWERS_OVERRIDE_FILE=""
TMP_ENV=""
TMP_MANIFEST=""

usage() {
  cat <<USAGE
Usage: $(basename "$0") --client cliente-demo --manifest manifest.yaml [options]

Options:
  --home PATH              Appliance data root (default: /opt/quoteops-v1)
  --env-file PATH          Compose env file (default: <home>/.env)
  --secrets-env-file PATH  Client secrets env file (default: <home>/secrets/client.env)
  --compose-file PATH      Compose file (default: deploy/appliance/docker-compose.yml)
  --connectors PATH        Copy connector pack directory into <home>/connectors
  --connectors-dir PATH    Connector data root (default: <home>/connectors)
  --agent-config PATH      Copy agent config YAML/JSON into connectors/agent
  --tms-adapter-config PATH Copy TMS adapter config YAML/JSON into connectors/tms-adapter.yaml
  --tms-mapping-config PATH Copy strict TMS mapping JSON into connectors/tms-mapping.json
  --version VERSION        Pinned appliance release (required with --guided)
  --image-registry IMAGE   Image registry/prefix (default: ghcr.io/alejandroc-bit)
  --site-address ADDRESS   Caddy site address (default: :80)
  --http-port PORT         Host HTTP port (default: 80)
  --https-port PORT        Host HTTPS port (default: 443)
  --postgres-db NAME       Postgres database name (default: quoteops)
  --postgres-user NAME     Postgres user (default: quoteops)
  --postgres-password PW   Legacy direct-install password (forbidden with --guided)
  --sakbe-live BOOL        Allow live SAKBE calls after cache miss (default: true)
  --sakbe-cache-mode MODE  SAKBE cache mode: cache_first or live_only (default: cache_first)
  --control-plane-url URL  Inducta control-plane base URL for activation and aggregate sync
  --registration-token TOK Legacy direct-install token (rejected with --guided)
  --registration-token-file PATH Read registration token from a protected 0600 file
  --installation-id ID     Stable appliance installation id
  --guided                 Require checksum-verified release-local runtime assets
  --resume-guided          Resume guided verification using protected local state
  --answers-dir HOST_DIR   Mac acceptance inputs (bounded 0700 directory; guided only)
  --force                  Replace existing env file and manifest copy
  --skip-start             Prepare files without running docker compose up
  --no-pull                Skip docker compose pull; validate config and start pre-loaded images
  -h, --help               Show this help
USAGE
}

die() {
  echo "install.sh: $*" >&2
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

absolute_new_path() {
  local path="$1"
  local dir
  local base
  mkdir -p "$(dirname "$path")"
  dir="$(cd "$(dirname "$path")" && pwd -P)" || die "cannot resolve path: $path"
  base="$(basename "$path")"
  printf "%s/%s\n" "$dir" "$base"
}

env_escape() {
  local value="$1"
  [[ "$value" != *$'\n'* ]] || die "env values cannot contain newlines"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//\$/\\$}"
  value="${value//\`/\\\`}"
  printf '"%s"' "$value"
}

write_env_line() {
  local key="$1"
  local value="$2"
  printf "%s=%s\n" "$key" "$(env_escape "$value")"
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

generate_secret() {
  if [[ -n "$POSTGRES_PASSWORD" ]]; then
    printf "%s\n" "$POSTGRES_PASSWORD"
    return
  fi
  [[ -r /dev/urandom ]] || die "cryptographic random source is unavailable"
  LC_ALL=C od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  printf '\n'
}

file_owner_id() {
  if stat -f '%u' "$1" >/dev/null 2>&1; then
    stat -f '%u' "$1"
  else
    stat -c '%u' "$1"
  fi
}

file_mode() {
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

validate_secret_file() {
  local path="$1"
  [[ -f "$path" && ! -L "$path" ]] || die "secret file must be a regular non-symlink file: $path"
  [[ "$(file_owner_id "$path")" == "$(id -u)" ]] || die "secret file must be owned by the current user: $path"
  [[ "$(file_mode "$path")" == "600" ]] || die "secret file must have mode 0600: $path"
}

validate_cloudflare_access_file() {
  local expected_owner=0
  [[ -f "$CLOUDFLARE_ACCESS_ENV_FILE" && ! -L "$CLOUDFLARE_ACCESS_ENV_FILE" ]] ||
    remove_unsafe_cloudflare_access_file \
      "Cloudflare Access validation file must be a regular non-symlink file"
  [[ "$(file_mode "$CLOUDFLARE_ACCESS_ENV_FILE")" == "600" ]] ||
    remove_unsafe_cloudflare_access_file \
      "Cloudflare Access validation file must have mode 0600"
  if [[ "${QUOTEOPS_BOOTSTRAP_TEST_MODE:-}" == "macbook" ]]; then
    case "$QUOTEOPS_HOME" in
      "$(cd "${TMPDIR:-/tmp}" && pwd -P)"/quoteops-mac-e2e.*/quoteops-v1)
        expected_owner="$(id -u)"
        ;;
      *) remove_unsafe_cloudflare_access_file \
           "Cloudflare Access test ownership exception requires a bounded temporary QUOTEOPS_HOME" ;;
    esac
  fi
  [[ "$(file_owner_id "$CLOUDFLARE_ACCESS_ENV_FILE")" == "$expected_owner" ]] ||
    remove_unsafe_cloudflare_access_file \
      "Cloudflare Access validation file must be owned by root"
}

remove_unsafe_cloudflare_access_file() {
  local message="$1"
  rm -f -- "$CLOUDFLARE_ACCESS_ENV_FILE" >/dev/null 2>&1 || true
  [[ ! -e "$CLOUDFLARE_ACCESS_ENV_FILE" && ! -L "$CLOUDFLARE_ACCESS_ENV_FILE" ]] ||
    die "unsafe Cloudflare Access validation path could not be removed"
  die "$message"
}

validate_cloudflare_tunnel_env() {
  local line
  local assignments=0
  validate_secret_file "$CLOUDFLARE_ENV_FILE"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^TUNNEL_TOKEN=([A-Za-z0-9._~+/=-]+)$ ||
          "$line" =~ ^TUNNEL_TOKEN=\"([A-Za-z0-9._~+/=-]+)\"$ ]]; then
      assignments=$((assignments + 1))
      [[ "$assignments" -eq 1 ]] ||
        die "cloudflare.env must contain exactly one TUNNEL_TOKEN assignment"
      continue
    fi
    die "cloudflare.env may contain only one non-empty TUNNEL_TOKEN assignment"
  done < "$CLOUDFLARE_ENV_FILE"
  [[ "$assignments" -eq 1 ]] ||
    die "cloudflare.env must contain exactly one non-empty TUNNEL_TOKEN assignment"
}

read_env_value() {
  local key="$1"
  local file="$2"
  local value
  value="$(sed -n "s/^${key}=//p" "$file" | head -1)"
  value="${value#\"}"
  value="${value%\"}"
  printf '%s\n' "$value"
}

ensure_secret_key() {
  local file="$1"
  local key="$2"
  local value="$3"
  local existing
  local temporary
  existing="$(read_env_value "$key" "$file")"
  if [[ -n "$existing" ]]; then
    printf '%s\n' "$existing"
    return
  fi
  temporary="$file.tmp.$$"
  cp "$file" "$temporary"
  write_env_line "$key" "$value" >> "$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$file"
  printf '%s\n' "$value"
}

cloudflare_validation_receipt_matches() {
  command -v jq >/dev/null 2>&1 || return 1
  [[ -f "$CLOUDFLARE_VALIDATION_RECEIPT_FILE" &&
     ! -L "$CLOUDFLARE_VALIDATION_RECEIPT_FILE" ]] || return 1
  jq -e \
    --arg hostname "$QUOTEOPS_PUBLIC_HOSTNAME" \
    --arg version "$QUOTEOPS_VERSION" \
    --arg client "$CLIENT_ID" \
    --arg installation "$QUOTEOPS_INSTALLATION_ID" \
    '.public_hostname == $hostname and
     .version == $version and
     .client_id == $client and
     .installation_id == $installation and
     .authenticated_origin == true' \
    "$CLOUDFLARE_VALIDATION_RECEIPT_FILE" >/dev/null 2>&1
}

load_cloudflare_gate_settings() {
  local access_client_id
  local access_client_secret

  need_command jq
  [[ -f "$CLOUDFLARE_SETTINGS_FILE" && ! -L "$CLOUDFLARE_SETTINGS_FILE" ]] ||
    die "guided onboarding must create settings/cloudflare.json"
  QUOTEOPS_PUBLIC_HOSTNAME="$(
    jq -er '.public_hostname | strings' "$CLOUDFLARE_SETTINGS_FILE" 2>/dev/null
  )" || die "Cloudflare settings must contain public_hostname"
  [[ "$QUOTEOPS_PUBLIC_HOSTNAME" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] ||
    die "public hostname is invalid"

  if cloudflare_validation_receipt_matches; then
    return
  fi
  if [[ ! -e "$CLOUDFLARE_ACCESS_ENV_FILE" && "$RESUME_GUIDED" -eq 1 ]]; then
    die "Cloudflare Service Auth credentials must be collected again before resumed verification"
  fi
  validate_cloudflare_access_file
  access_client_id="$(read_env_value CF_ACCESS_CLIENT_ID "$CLOUDFLARE_ACCESS_ENV_FILE")"
  access_client_secret="$(read_env_value CF_ACCESS_CLIENT_SECRET "$CLOUDFLARE_ACCESS_ENV_FILE")"
  [[ -n "$access_client_id" && -n "$access_client_secret" ]] ||
    die "Cloudflare Service Auth credentials are incomplete"
  unset access_client_id access_client_secret
}

validate_release_env() {
  local file="$1"
  local mode="$2"
  local key
  local value
  local count
  local allowed='QUOTEOPS_VERSION QUOTEOPS_PLATFORM QUOTEOPS_AGENT_IMAGE QUOTEOPS_API_IMAGE QUOTEOPS_WEB_IMAGE QUOTEOPS_POSTGRES_IMAGE QUOTEOPS_REDIS_IMAGE QUOTEOPS_CADDY_IMAGE QUOTEOPS_CLOUDFLARED_IMAGE'

  [[ -f "$file" && ! -L "$file" ]] || die "release.env is missing or unsafe"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" ]] && continue
    [[ "$line" =~ ^([A-Z0-9_]+)=([^[:space:]]+)$ ]] || die "release.env contains an invalid line"
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    case " $allowed " in
      *" $key "*) ;;
      *) die "release.env contains a forbidden key: $key" ;;
    esac
    [[ "$value" != *latest* && "$value" != *LATEST* ]] || die "release.env cannot use latest"
  done < "$file"
  for key in $allowed; do
    count="$(grep -c "^${key}=" "$file" || true)"
    [[ "$count" == "1" ]] || die "release.env must contain exactly one $key"
  done
  [[ "$(read_env_value QUOTEOPS_VERSION "$file")" == "$QUOTEOPS_VERSION" ]] ||
    die "release.env version does not match --version"
  [[ "$(read_env_value QUOTEOPS_PLATFORM "$file")" == "linux/amd64" ]] ||
    die "release.env platform must be linux/amd64"
  if [[ "$mode" == "release_pinned" ]]; then
    for key in QUOTEOPS_AGENT_IMAGE QUOTEOPS_API_IMAGE QUOTEOPS_WEB_IMAGE QUOTEOPS_POSTGRES_IMAGE QUOTEOPS_REDIS_IMAGE QUOTEOPS_CADDY_IMAGE QUOTEOPS_CLOUDFLARED_IMAGE; do
      value="$(read_env_value "$key" "$file")"
      [[ "$value" =~ @sha256:[a-f0-9]{64}$ ]] ||
        die "guided release image is not digest-pinned: $key"
    done
  fi
}

write_legacy_release_env() {
  local destination="$1"
  cat > "$destination" <<EOF
QUOTEOPS_VERSION=$QUOTEOPS_VERSION
QUOTEOPS_PLATFORM=linux/amd64
QUOTEOPS_AGENT_IMAGE=$QUOTEOPS_IMAGE_REGISTRY/quote-ops-agent:$QUOTEOPS_VERSION
QUOTEOPS_API_IMAGE=$QUOTEOPS_IMAGE_REGISTRY/quote-ops-api:$QUOTEOPS_VERSION
QUOTEOPS_WEB_IMAGE=$QUOTEOPS_IMAGE_REGISTRY/quote-ops-web:$QUOTEOPS_VERSION
QUOTEOPS_POSTGRES_IMAGE=postgres:16-alpine
QUOTEOPS_REDIS_IMAGE=redis:7-alpine
QUOTEOPS_CADDY_IMAGE=caddy:2-alpine
QUOTEOPS_CLOUDFLARED_IMAGE=cloudflare/cloudflared:2026.7.3
EOF
  chmod 644 "$destination"
}

stage_release() {
  local releases_dir="$QUOTEOPS_HOME/releases"
  local destination="$releases_dir/$QUOTEOPS_VERSION"
  local staging="$destination.tmp"
  local install_mode="$1"
  local asset
  local source
  local required_assets='docker-compose.yml Caddyfile install.sh quoteops.sh verify-install.sh upgrade.sh backup.sh restore.sh secrets.sh'

  mkdir -p "$releases_dir"
  chmod 700 "$releases_dir"
  for asset in $required_assets; do
    source="$SCRIPT_DIR/$asset"
    [[ -f "$source" && ! -L "$source" ]] || die "required runtime asset is missing or unsafe: $asset"
  done
  if [[ "$install_mode" == "release_pinned" ]]; then
    validate_release_env "$SCRIPT_DIR/release.env" "$install_mode"
  fi
  if [[ -e "$destination" || -L "$destination" ]]; then
    [[ -d "$destination" && ! -L "$destination" ]] || die "release destination is unsafe"
    validate_release_env "$destination/release.env" "$install_mode"
    for asset in $required_assets; do
      cmp -s "$SCRIPT_DIR/$asset" "$destination/$asset" ||
        die "installed release differs from immutable source: $asset"
    done
    printf '%s\n' "$destination"
    return
  fi
  [[ ! -e "$staging" && ! -L "$staging" ]] || die "release staging path already exists"
  mkdir "$staging"
  for asset in $required_assets; do
    cp "$SCRIPT_DIR/$asset" "$staging/$asset"
    if [[ "$asset" == *.sh ]]; then chmod 755 "$staging/$asset"; else chmod 644 "$staging/$asset"; fi
  done
  if [[ "$install_mode" == "release_pinned" ]]; then
    cp "$SCRIPT_DIR/release.env" "$staging/release.env"
    chmod 644 "$staging/release.env"
  else
    write_legacy_release_env "$staging/release.env"
  fi
  validate_release_env "$staging/release.env" "$install_mode"
  mv "$staging" "$destination"
  printf '%s\n' "$destination"
}

switch_current_release() {
  local release_dir="$1"
  local releases_dir="$QUOTEOPS_HOME/releases"
  local current="$QUOTEOPS_HOME/current"
  local temporary="$QUOTEOPS_HOME/.current.$$.tmp"
  [[ "$release_dir" == "$releases_dir"/v* && -d "$release_dir" && ! -L "$release_dir" ]] ||
    die "refusing unsafe release target"
  if [[ -e "$current" && ! -L "$current" ]]; then
    die "current must be a symlink"
  fi
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || die "temporary current link already exists"
  ln -s "$release_dir" "$temporary"
  if ! mv -Tf "$temporary" "$current" 2>/dev/null; then
    mv -hf "$temporary" "$current"
  fi
  [[ -L "$current" && "$(readlink "$current")" == "$release_dir" ]] ||
    die "atomic current switch failed"
}

validate_bin_override() {
  local bin_dir="$1"
  local physical_tmp
  local physical_parent
  local e2e_root
  [[ "${QUOTEOPS_BOOTSTRAP_TEST_MODE:-}" == "macbook" && "$(uname -s)" == "Darwin" ]] ||
    die "QUOTEOPS_BIN_DIR override requires bounded macbook test mode"
  physical_tmp="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
  case "$QUOTEOPS_HOME" in
    "$physical_tmp"/quoteops-mac-e2e.*/quoteops-v1) ;;
    *) die "QUOTEOPS_BIN_DIR override requires a bounded temporary QUOTEOPS_HOME" ;;
  esac
  e2e_root="$(dirname "$QUOTEOPS_HOME")"
  mkdir -p "$bin_dir"
  physical_parent="$(cd "$bin_dir" && pwd -P)"
  case "$physical_parent" in
    "$e2e_root"/bin|"$e2e_root"/usr-local-bin) ;;
    *) die "QUOTEOPS_BIN_DIR escaped the bounded test root" ;;
  esac
}

require_compose_224() {
  local version
  local major
  local minor
  local patch
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required"
  version="$(docker compose version --short 2>/dev/null | sed 's/^v//')"
  [[ "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+) ]] ||
    die "cannot determine Docker Compose version"
  major="${BASH_REMATCH[1]}"
  minor="${BASH_REMATCH[2]}"
  patch="${BASH_REMATCH[3]}"
  if (( major < 2 || (major == 2 && minor < 24) )); then
    die "Docker Compose 2.24.0 or newer is required"
  fi
  : "$patch"
}

cleanup_answers_override() {
  if [[ -n "$ANSWERS_OVERRIDE_FILE" ]]; then
    rm -f -- "$ANSWERS_OVERRIDE_FILE"
    ANSWERS_OVERRIDE_FILE=""
  fi
}

cleanup() {
  if [[ -n "$TMP_ENV" ]]; then
    rm -f -- "$TMP_ENV"
  fi
  if [[ -n "$TMP_MANIFEST" ]]; then
    rm -f -- "$TMP_MANIFEST"
  fi
  cleanup_answers_override
}

validate_acceptance_answers_dir() {
  local requested="$1"
  local physical_tmp
  local acceptance_root
  local physical_dir
  local operator_uid
  local owner
  local reference
  local relative_ref
  local host_file

  [[ "${QUOTEOPS_BOOTSTRAP_TEST_MODE:-}" == "macbook" ]] ||
    die "--answers-dir is restricted to Mac acceptance mode"
  [[ "${QUOTEOPS_AUTOMATION_MODE:-}" == "1" ]] ||
    die "--answers-dir requires noninteractive acceptance mode"
  [[ -d "$requested" && ! -L "$requested" ]] ||
    die "acceptance answers directory must be physical"
  physical_dir="$(cd "$requested" && pwd -P)"
  [[ "$(file_mode "$physical_dir")" == "700" ]] ||
    die "acceptance answers directory must have mode 0700"
  physical_tmp="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
  case "$QUOTEOPS_HOME" in
    "$physical_tmp"/quoteops-mac-e2e.*/quoteops-v1) ;;
    *) die "--answers-dir requires a bounded Mac acceptance root" ;;
  esac
  acceptance_root="$(dirname "$QUOTEOPS_HOME")"
  case "$physical_dir" in
    "$acceptance_root"/*) ;;
    *) die "acceptance answers directory escaped the bounded root" ;;
  esac

  operator_uid="${SUDO_UID:-$(id -u)}"
  owner="$(file_owner_id "$physical_dir")"
  [[ "$owner" == "$operator_uid" || "$owner" == "0" ]] ||
    die "acceptance answers directory has the wrong owner"
  [[ -f "$physical_dir/answers.json" && ! -L "$physical_dir/answers.json" ]] ||
    die "acceptance answers file must be regular"
  [[ "$(file_mode "$physical_dir/answers.json")" == "600" ]] ||
    die "acceptance answers file must have mode 0600"
  owner="$(file_owner_id "$physical_dir/answers.json")"
  [[ "$owner" == "$operator_uid" || "$owner" == "0" ]] ||
    die "acceptance answers file has the wrong owner"

  need_command jq
  jq -e 'type == "object"' "$physical_dir/answers.json" >/dev/null 2>&1 ||
    die "acceptance answers JSON is invalid"
  while IFS= read -r reference; do
    case "$reference" in
      /run/quoteops-onboard-input/*)
        relative_ref="${reference#/run/quoteops-onboard-input/}"
        ;;
      *) die "acceptance input reference escaped the fixed container mount" ;;
    esac
    [[ -n "$relative_ref" && "$relative_ref" != "." && "$relative_ref" != ".." &&
       "$relative_ref" != */* ]] ||
      die "acceptance input reference must name a file in the mounted directory"
    host_file="$physical_dir/$relative_ref"
    [[ -f "$host_file" && ! -L "$host_file" ]] ||
      die "acceptance input reference must be a regular non-symlink file"
    [[ "$(file_mode "$host_file")" == "600" ]] ||
      die "acceptance input reference must have mode 0600"
    owner="$(file_owner_id "$host_file")"
    [[ "$owner" == "$operator_uid" || "$owner" == "0" ]] ||
      die "acceptance input reference has the wrong owner"
  done < <(jq -er '.. | objects | select(has("file")) | .file | strings' \
    "$physical_dir/answers.json")

  ANSWERS_DIR="$physical_dir"
}

create_acceptance_override() {
  [[ -n "$ANSWERS_DIR" ]] || return 0
  ANSWERS_OVERRIDE_FILE="$QUOTEOPS_HOME/settings/.onboard-acceptance.$$.json"
  [[ ! -e "$ANSWERS_OVERRIDE_FILE" && ! -L "$ANSWERS_OVERRIDE_FILE" ]] ||
    die "temporary acceptance override already exists"
  jq -n --arg source "$ANSWERS_DIR" '{
    services: {
      "quoteops-onboard": {
        environment: { QUOTEOPS_ACCEPTANCE_MODE: "macbook" },
        volumes: [{
          type: "bind",
          source: $source,
          target: "/run/quoteops-onboard-input",
          read_only: true
        }]
      }
    }
  }' > "$ANSWERS_OVERRIDE_FILE"
  chmod 600 "$ANSWERS_OVERRIDE_FILE"
}

guided_compose() {
  local command=(
    docker compose
    --env-file "$ENV_FILE"
    --env-file "$RELEASE_ENV_FILE"
    -f "$COMPOSE_FILE"
  )
  if [[ -n "$ANSWERS_OVERRIDE_FILE" ]]; then
    command+=(-f "$ANSWERS_OVERRIDE_FILE")
  fi
  "${command[@]}" "$@"
}

guided_pending() {
  printf '%s\n' \
    "Onboarding pendiente. Reanuda con:" \
    "sudo quoteops onboard --resume"
  return 20
}

run_guided_onboarding_container() {
  local selection_flag="$1"
  local selection_phase="$2"
  local command=(
    --profile onboarding run --rm
  )
  if [[ "${QUOTEOPS_AUTOMATION_MODE:-}" == "1" || -n "$ANSWERS_DIR" ]]; then
    command+=(-T)
  fi
  command+=(quoteops-onboard --resume "$selection_flag" "$selection_phase")
  if [[ -n "$ANSWERS_DIR" ]]; then
    command+=(--answers-file /run/quoteops-onboard-input/answers.json)
  fi
  if [[ "${QUOTEOPS_AUTOMATION_MODE:-}" == "1" || -n "$ANSWERS_DIR" ]]; then
    guided_compose "${command[@]}"
  else
    guided_compose "${command[@]}" < /dev/tty
  fi
}

run_guided_sequence() {
  local core_services=(postgres redis quoteops-agent quoteops-api quoteops-web caddy)
  local health=""
  local attempt
  local public_hostname

  guided_compose up -d "${core_services[@]}" || {
    guided_pending
    return 20
  }
  for attempt in $(seq 1 30); do
    if health="$(guided_compose exec -T caddy wget -qO- -T 3 \
      "http://127.0.0.1/api/health" 2>/dev/null)" &&
       printf '%s' "$health" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then
      break
    fi
    health=""
    sleep 2
  done
  [[ -n "$health" ]] || {
    guided_pending
    return 20
  }
  run_guided_onboarding_container --until knowledge || {
    guided_pending
    return 20
  }
  guided_compose up -d "${core_services[@]}" || {
    guided_pending
    return 20
  }
  run_guided_onboarding_container --only test_rfq || {
    guided_pending
    return 20
  }
  guided_compose --profile tunnel up -d cloudflared || {
    guided_pending
    return 20
  }
  QUOTEOPS_HOME="$QUOTEOPS_HOME" \
    bash "$RELEASE_DIR/verify-install.sh" --resume-guided || {
      guided_pending
      return 20
    }

  public_hostname="$(jq -er '.public_hostname | strings | select(length > 0)' \
    "$CLOUDFLARE_SETTINGS_FILE" 2>/dev/null)" || {
      guided_pending
      return 20
    }
  printf 'https://%s\n' "$public_hostname"
}

resume_guided_install() {
  local physical_current
  [[ -d "$QUOTEOPS_HOME" && ! -L "$QUOTEOPS_HOME" ]] ||
    die "guided resume requires a physical QUOTEOPS_HOME"
  QUOTEOPS_HOME="$(cd "$QUOTEOPS_HOME" && pwd -P)"
  [[ "$QUOTEOPS_HOME" != "/" ]] || die "QUOTEOPS_HOME cannot be /"
  ENV_FILE="$QUOTEOPS_HOME/.env"
  [[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] ||
    die "guided resume requires the stored appliance env"
  [[ -L "$QUOTEOPS_HOME/current" ]] ||
    die "guided resume requires an active release"
  physical_current="$(cd "$QUOTEOPS_HOME/current" && pwd -P)"
  [[ "$(dirname "$physical_current")" == "$QUOTEOPS_HOME/releases" &&
     "$(basename "$physical_current")" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
    die "guided resume current release escaped the release store"
  RELEASE_DIR="$physical_current"
  COMPOSE_FILE="$RELEASE_DIR/docker-compose.yml"
  RELEASE_ENV_FILE="$RELEASE_DIR/release.env"
  [[ -f "$COMPOSE_FILE" && ! -L "$COMPOSE_FILE" &&
     -f "$RELEASE_ENV_FILE" && ! -L "$RELEASE_ENV_FILE" ]] ||
    die "guided resume release is incomplete"
  CLIENT_ID="$(read_env_value QUOTEOPS_CLIENT_ID "$ENV_FILE")"
  QUOTEOPS_INSTALLATION_ID="$(read_env_value QUOTEOPS_INSTALLATION_ID "$ENV_FILE")"
  QUOTEOPS_VERSION="$(read_env_value QUOTEOPS_VERSION "$RELEASE_ENV_FILE")"
  [[ -n "$CLIENT_ID" && -n "$QUOTEOPS_INSTALLATION_ID" ]] ||
    die "guided resume requires stored client and installation identity"
  [[ -n "$QUOTEOPS_VERSION" ]] ||
    die "guided resume requires a pinned release version"
  CLOUDFLARE_SETTINGS_FILE="$QUOTEOPS_HOME/settings/cloudflare.json"
  need_command docker
  require_compose_224
  trap cleanup_answers_override EXIT
  if [[ -n "$ANSWERS_DIR" ]]; then
    validate_acceptance_answers_dir "$ANSWERS_DIR"
    create_acceptance_override
  fi
  local status
  if run_guided_sequence; then
    cleanup_answers_override
    trap - EXIT
    return 0
  else
    status=$?
  fi
  cleanup_answers_override
  trap - EXIT
  return "$status"
}

postgres_volume_state() {
  local volume_name="${COMPOSE_PROJECT_NAME}_postgres_data"
  local volumes
  command -v docker >/dev/null 2>&1 ||
    die "PostgreSQL data volume state cannot be determined safely: Docker is unavailable"
  if docker volume inspect "$volume_name" >/dev/null 2>&1; then
    printf '%s\n' "exists"
    return
  fi
  if ! volumes="$(docker volume ls --format '{{.Name}}' 2>/dev/null)"; then
    die "PostgreSQL data volume state cannot be determined safely"
  fi
  if printf '%s\n' "$volumes" | grep -Fxq "$volume_name"; then
    printf '%s\n' "exists"
  else
    printf '%s\n' "absent"
  fi
}

validate_identifier() {
  local label="$1"
  local value="$2"
  [[ "$value" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "$label must be a PostgreSQL-safe identifier"
}

guard_target() {
  local label="$1"
  local path="$2"
  if [[ -e "$path" && "$FORCE" -ne 1 ]]; then
    die "$label already exists: $path (use --force to replace)"
  fi
}

guard_connector_pack_overwrite() {
  local source_dir="$1"
  local target_dir="$2"
  local source_path
  local relative_path
  local target_path

  while IFS= read -r -d '' source_path; do
    relative_path="${source_path#"$source_dir"/}"
    target_path="$target_dir/$relative_path"

    if [[ -d "$source_path" && ! -L "$source_path" ]]; then
      if [[ -e "$target_path" && ! -d "$target_path" ]]; then
        die "connector pack path conflicts with existing non-directory: $target_path (use --force to replace)"
      fi
      continue
    fi

    if [[ -e "$target_path" || -L "$target_path" ]]; then
      if [[ "$EXISTING_INSTALL" -eq 1 &&
            -f "$source_path" && ! -L "$source_path" &&
            -f "$target_path" && ! -L "$target_path" ]] &&
         cmp -s "$source_path" "$target_path"; then
        continue
      fi
      die "connector pack file already exists: $target_path (use --force to replace)"
    fi
  done < <(find "$source_dir" -mindepth 1 -print0)
}

GUIDED_REQUESTED=0
POSTGRES_PASSWORD_FLAG_REQUESTED=0
for argument in "$@"; do
  case "$argument" in
    --guided) GUIDED_REQUESTED=1 ;;
    --postgres-password) POSTGRES_PASSWORD_FLAG_REQUESTED=1 ;;
  esac
done
if [[ "$GUIDED_REQUESTED" -eq 1 && "$POSTGRES_PASSWORD_FLAG_REQUESTED" -eq 1 ]]; then
  unset POSTGRES_PASSWORD
  die "--postgres-password is forbidden with --guided"
fi
if [[ "$GUIDED_REQUESTED" -eq 1 && -n "$POSTGRES_PASSWORD_INHERITED" ]]; then
  unset POSTGRES_PASSWORD
  die "inherited POSTGRES_PASSWORD is forbidden with --guided"
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --client)
      require_value "$1" "${2:-}"
      CLIENT_ID="$2"
      shift 2
      ;;
    --manifest)
      require_value "$1" "${2:-}"
      MANIFEST_PATH="$2"
      shift 2
      ;;
    --home)
      require_value "$1" "${2:-}"
      QUOTEOPS_HOME="$2"
      if [[ "$ENV_FILE_SET" -eq 0 ]]; then
        ENV_FILE="$QUOTEOPS_HOME/.env"
      fi
      if [[ "$SECRETS_ENV_FILE_SET" -eq 0 ]]; then
        SECRETS_ENV_FILE="$QUOTEOPS_HOME/secrets/client.env"
      fi
      CLOUDFLARE_ENV_FILE="$QUOTEOPS_HOME/secrets/cloudflare.env"
      CLOUDFLARE_ACCESS_ENV_FILE="$QUOTEOPS_HOME/secrets/cloudflare-access-validation.env"
      CLOUDFLARE_SETTINGS_FILE="$QUOTEOPS_HOME/settings/cloudflare.json"
      CLOUDFLARE_VALIDATION_RECEIPT_FILE="$QUOTEOPS_HOME/settings/cloudflare-public-validation.json"
      shift 2
      ;;
    --env-file)
      require_value "$1" "${2:-}"
      ENV_FILE="$2"
      ENV_FILE_SET=1
      shift 2
      ;;
    --secrets-env-file)
      require_value "$1" "${2:-}"
      SECRETS_ENV_FILE="$2"
      SECRETS_ENV_FILE_SET=1
      shift 2
      ;;
    --compose-file)
      require_value "$1" "${2:-}"
      COMPOSE_FILE="$2"
      shift 2
      ;;
    --connectors)
      require_value "$1" "${2:-}"
      CONNECTORS_PATH="$2"
      shift 2
      ;;
    --connectors-dir)
      require_value "$1" "${2:-}"
      QUOTEOPS_CONNECTORS_DIR="$2"
      shift 2
      ;;
    --agent-config)
      require_value "$1" "${2:-}"
      AGENT_CONFIG_PATH="$2"
      shift 2
      ;;
    --tms-adapter-config)
      require_value "$1" "${2:-}"
      TMS_ADAPTER_CONFIG_PATH="$2"
      shift 2
      ;;
    --tms-mapping-config)
      require_value "$1" "${2:-}"
      TMS_MAPPING_CONFIG_PATH="$2"
      shift 2
      ;;
    --version)
      require_value "$1" "${2:-}"
      QUOTEOPS_VERSION="$2"
      VERSION_SET=1
      shift 2
      ;;
    --image-registry)
      require_value "$1" "${2:-}"
      QUOTEOPS_IMAGE_REGISTRY="$2"
      shift 2
      ;;
    --site-address)
      require_value "$1" "${2:-}"
      QUOTEOPS_SITE_ADDRESS="$2"
      shift 2
      ;;
    --http-port)
      require_value "$1" "${2:-}"
      QUOTEOPS_HTTP_PORT="$2"
      shift 2
      ;;
    --https-port)
      require_value "$1" "${2:-}"
      QUOTEOPS_HTTPS_PORT="$2"
      shift 2
      ;;
    --postgres-db)
      require_value "$1" "${2:-}"
      POSTGRES_DB="$2"
      shift 2
      ;;
    --postgres-user)
      require_value "$1" "${2:-}"
      POSTGRES_USER="$2"
      shift 2
      ;;
    --postgres-password)
      require_value "$1" "${2:-}"
      POSTGRES_PASSWORD="$2"
      POSTGRES_PASSWORD_FLAG_SET=1
      shift 2
      ;;
    --sakbe-live)
      require_value "$1" "${2:-}"
      QUOTEOPS_SAKBE_LIVE_ENABLED="$2"
      shift 2
      ;;
    --sakbe-cache-mode)
      require_value "$1" "${2:-}"
      QUOTEOPS_SAKBE_CACHE_MODE="$2"
      shift 2
      ;;
    --control-plane-url)
      require_value "$1" "${2:-}"
      QUOTEOPS_CONTROL_PLANE_URL="$2"
      shift 2
      ;;
    --registration-token)
      require_value "$1" "${2:-}"
      QUOTEOPS_REGISTRATION_TOKEN="$2"
      shift 2
      ;;
    --registration-token-file)
      require_value "$1" "${2:-}"
      QUOTEOPS_REGISTRATION_TOKEN_FILE="$2"
      shift 2
      ;;
    --installation-id)
      require_value "$1" "${2:-}"
      QUOTEOPS_INSTALLATION_ID="$2"
      shift 2
      ;;
    --answers-dir)
      require_value "$1" "${2:-}"
      ANSWERS_DIR="$2"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --skip-start)
      START_STACK=0
      shift
      ;;
    --no-pull)
      PULL_IMAGES=0
      shift
      ;;
    --guided)
      GUIDED=1
      shift
      ;;
    --resume-guided)
      GUIDED=1
      RESUME_GUIDED=1
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

if [[ "$RESUME_GUIDED" -eq 1 ]]; then
  [[ -z "$CLIENT_ID" && -z "$MANIFEST_PATH" && -z "$QUOTEOPS_REGISTRATION_TOKEN_FILE" ]] ||
    die "--resume-guided uses only protected local appliance state"
  resume_guided_install
  exit $?
fi

[[ -n "$CLIENT_ID" ]] || die "--client is required"
[[ -n "$MANIFEST_PATH" ]] || die "--manifest is required"
if [[ -n "$ANSWERS_DIR" && "$GUIDED" -ne 1 ]]; then
  die "--answers-dir requires --guided"
fi
if [[ "$GUIDED" -eq 1 ]]; then
  [[ "$VERSION_SET" -eq 1 ]] || die "--version is required with --guided"
  [[ "$POSTGRES_PASSWORD_FLAG_SET" -eq 0 ]] ||
    die "--postgres-password is forbidden with --guided"
  [[ -z "$POSTGRES_PASSWORD_INHERITED" ]] ||
    die "inherited POSTGRES_PASSWORD is forbidden with --guided"
  POSTGRES_PASSWORD=""
  [[ -z "$QUOTEOPS_REGISTRATION_TOKEN" ]] ||
    die "--registration-token is forbidden with --guided; use --registration-token-file"
  [[ -n "$QUOTEOPS_REGISTRATION_TOKEN_FILE" ]] ||
    die "--registration-token-file is required with --guided"
  INSTALL_MODE="release_pinned"
else
  INSTALL_MODE="legacy_direct"
  if [[ "$VERSION_SET" -eq 0 && -z "$QUOTEOPS_VERSION" ]]; then
    QUOTEOPS_VERSION="v0.1.0"
    printf '%s\n' "install.sh: warning: implicit v0.1.0 direct install is deprecated; pass --version" >&2
  fi
fi
[[ -n "$QUOTEOPS_VERSION" ]] || die "--version is required"
[[ "$CLIENT_ID" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die "--client may only contain letters, numbers, dot, underscore, or dash"
[[ "$QUOTEOPS_VERSION" =~ ^v[0-9]+[.][0-9]+[.][0-9]+$ ]] || die "--version must look like v0.1.0"
[[ "$QUOTEOPS_SAKBE_LIVE_ENABLED" =~ ^(true|false|1|0|yes|no|on|off)$ ]] || die "--sakbe-live must be true or false"
[[ "$QUOTEOPS_SAKBE_CACHE_MODE" =~ ^(cache_first|live_only)$ ]] || die "--sakbe-cache-mode must be cache_first or live_only"
[[ -f "$MANIFEST_PATH" ]] || die "manifest not found: $MANIFEST_PATH"
[[ -r "$MANIFEST_PATH" ]] || die "manifest is not readable: $MANIFEST_PATH"
if [[ -n "$QUOTEOPS_REGISTRATION_TOKEN_FILE" ]]; then
  QUOTEOPS_REGISTRATION_TOKEN_FILE="$(absolute_path "$QUOTEOPS_REGISTRATION_TOKEN_FILE")"
  validate_secret_file "$QUOTEOPS_REGISTRATION_TOKEN_FILE"
  QUOTEOPS_REGISTRATION_TOKEN="$(<"$QUOTEOPS_REGISTRATION_TOKEN_FILE")"
  [[ "${#QUOTEOPS_REGISTRATION_TOKEN}" -ge 32 &&
     "${#QUOTEOPS_REGISTRATION_TOKEN}" -le 512 &&
     ! "$QUOTEOPS_REGISTRATION_TOKEN" =~ [^A-Za-z0-9._~-] ]] ||
    die "registration token file contains an invalid token"
fi
MANIFEST_CLIENT_ID="$(sed -n 's/^client_id:[[:space:]]*//p' "$MANIFEST_PATH" | head -1 | tr -d '"' | tr -d "'")"
[[ -z "$MANIFEST_CLIENT_ID" || "$MANIFEST_CLIENT_ID" == "$CLIENT_ID" ]] \
  || die "manifest client_id ($MANIFEST_CLIENT_ID) does not match --client ($CLIENT_ID); activation would target the wrong tenant"
if [[ -n "$CONNECTORS_PATH" ]]; then
  [[ -d "$CONNECTORS_PATH" ]] || die "connectors directory not found: $CONNECTORS_PATH"
fi
if [[ -n "$AGENT_CONFIG_PATH" ]]; then
  [[ -f "$AGENT_CONFIG_PATH" ]] || die "agent config not found: $AGENT_CONFIG_PATH"
  [[ -r "$AGENT_CONFIG_PATH" ]] || die "agent config is not readable: $AGENT_CONFIG_PATH"
fi
if [[ -n "$TMS_ADAPTER_CONFIG_PATH" ]]; then
  [[ -f "$TMS_ADAPTER_CONFIG_PATH" ]] || die "TMS adapter config not found: $TMS_ADAPTER_CONFIG_PATH"
  [[ -r "$TMS_ADAPTER_CONFIG_PATH" ]] || die "TMS adapter config is not readable: $TMS_ADAPTER_CONFIG_PATH"
fi
if [[ -n "$TMS_MAPPING_CONFIG_PATH" ]]; then
  [[ -f "$TMS_MAPPING_CONFIG_PATH" ]] || die "TMS mapping config not found: $TMS_MAPPING_CONFIG_PATH"
  [[ -r "$TMS_MAPPING_CONFIG_PATH" ]] || die "TMS mapping config is not readable: $TMS_MAPPING_CONFIG_PATH"
fi
validate_identifier "--postgres-db" "$POSTGRES_DB"
validate_identifier "--postgres-user" "$POSTGRES_USER"

COMPOSE_FILE="$(absolute_path "$COMPOSE_FILE")"
MANIFEST_PATH="$(absolute_path "$MANIFEST_PATH")"
if [[ -n "$CONNECTORS_PATH" ]]; then
  CONNECTORS_PATH="$(absolute_path "$CONNECTORS_PATH")"
fi
if [[ -n "$AGENT_CONFIG_PATH" ]]; then
  AGENT_CONFIG_PATH="$(absolute_path "$AGENT_CONFIG_PATH")"
fi
if [[ -n "$TMS_ADAPTER_CONFIG_PATH" ]]; then
  TMS_ADAPTER_CONFIG_PATH="$(absolute_path "$TMS_ADAPTER_CONFIG_PATH")"
fi
if [[ -n "$TMS_MAPPING_CONFIG_PATH" ]]; then
  TMS_MAPPING_CONFIG_PATH="$(absolute_path "$TMS_MAPPING_CONFIG_PATH")"
fi
if [[ -z "$AGENT_CONFIG_PATH" ]]; then
  if [[ -z "$CONNECTORS_PATH" || ! -f "$CONNECTORS_PATH/agent/agent-config.yaml" ]]; then
    die "agent config is required: provide --agent-config or --connectors containing agent/agent-config.yaml"
  fi
fi
QUOTEOPS_HOME="$(mkdir -p "$QUOTEOPS_HOME" && cd "$QUOTEOPS_HOME" && pwd -P)"
[[ "$QUOTEOPS_HOME" != "/" ]] || die "QUOTEOPS_HOME cannot be /"
if [[ -n "${HOME:-}" && -d "$HOME" ]]; then
  PHYSICAL_USER_HOME="$(cd "$HOME" && pwd -P)"
  [[ "$QUOTEOPS_HOME" != "$PHYSICAL_USER_HOME" ]] ||
    die "QUOTEOPS_HOME cannot be a home directory"
fi
if [[ "${QUOTEOPS_BOOTSTRAP_TEST_MODE:-}" == "macbook" ]]; then
  [[ "$(uname -s)" == "Darwin" ]] || die "macbook test mode requires Darwin"
  PHYSICAL_TMPDIR="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
  case "$QUOTEOPS_HOME" in
    "$PHYSICAL_TMPDIR"/quoteops-mac-e2e.*/quoteops-v1) ;;
    *) die "macbook test mode requires a bounded temporary QUOTEOPS_HOME" ;;
  esac
elif [[ -n "${QUOTEOPS_BOOTSTRAP_TEST_MODE:-}" ]]; then
  die "unknown bootstrap test mode"
fi
if [[ -n "$ANSWERS_DIR" ]]; then
  validate_acceptance_answers_dir "$ANSWERS_DIR"
fi
ENV_FILE="$(absolute_new_path "$ENV_FILE")"
SECRETS_ENV_FILE="$(absolute_new_path "$SECRETS_ENV_FILE")"
CLOUDFLARE_ENV_FILE="$(absolute_new_path "$CLOUDFLARE_ENV_FILE")"
CLOUDFLARE_ACCESS_ENV_FILE="$QUOTEOPS_HOME/secrets/cloudflare-access-validation.env"
CLOUDFLARE_SETTINGS_FILE="$QUOTEOPS_HOME/settings/cloudflare.json"
CLOUDFLARE_VALIDATION_RECEIPT_FILE="$QUOTEOPS_HOME/settings/cloudflare-public-validation.json"
if [[ "$GUIDED" -eq 1 ]]; then
  [[ "$ENV_FILE" == "$QUOTEOPS_HOME/.env" ]] ||
    die "guided install requires the shared env under QUOTEOPS_HOME"
  [[ "$SECRETS_ENV_FILE" == "$QUOTEOPS_HOME/secrets/client.env" ]] ||
    die "guided install requires client secrets under QUOTEOPS_HOME"
fi
QUOTEOPS_MANIFEST_DIR="${QUOTEOPS_MANIFEST_DIR:-$QUOTEOPS_HOME/manifests}"
QUOTEOPS_CRITERIA_DIR="${QUOTEOPS_CRITERIA_DIR:-$QUOTEOPS_HOME/criteria}"
QUOTEOPS_CONNECTORS_DIR="${QUOTEOPS_CONNECTORS_DIR:-$QUOTEOPS_HOME/connectors}"
QUOTEOPS_LOG_DIR="${QUOTEOPS_LOG_DIR:-$QUOTEOPS_HOME/logs}"
QUOTEOPS_BACKUP_DIR="${QUOTEOPS_BACKUP_DIR:-$QUOTEOPS_HOME/backups}"
QUOTEOPS_SETTINGS_DIR="${QUOTEOPS_SETTINGS_DIR:-$QUOTEOPS_HOME/settings}"
QUOTEOPS_SECRETS_DIR="$(dirname "$SECRETS_ENV_FILE")"
CADDYFILE_PATH="${CADDYFILE_PATH:-$SCRIPT_DIR/Caddyfile}"
CADDYFILE_PATH="$(absolute_path "$CADDYFILE_PATH")"

[[ -f "$COMPOSE_FILE" ]] || die "compose file not found: $COMPOSE_FILE"
[[ -f "$CADDYFILE_PATH" ]] || die "Caddyfile not found: $CADDYFILE_PATH"

if [[ "$START_STACK" -eq 1 ]]; then
  need_command docker
  require_compose_224
fi

if [[ -f "$ENV_FILE" ]]; then
  EXISTING_INSTALL=1
  EXISTING_CLIENT_ID="$(read_env_value QUOTEOPS_CLIENT_ID "$ENV_FILE")"
  [[ -z "$EXISTING_CLIENT_ID" || "$EXISTING_CLIENT_ID" == "$CLIENT_ID" ]] ||
    die "existing appliance belongs to client $EXISTING_CLIENT_ID"
fi

TARGET_MANIFEST="$QUOTEOPS_MANIFEST_DIR/client-manifest.yaml"
if [[ -e "$TARGET_MANIFEST" ]] && ! cmp -s "$MANIFEST_PATH" "$TARGET_MANIFEST" && [[ "$FORCE" -ne 1 ]]; then
  die "manifest copy already exists: $TARGET_MANIFEST (use --force to replace)"
fi
TARGET_AGENT_CONFIG="$QUOTEOPS_CONNECTORS_DIR/agent/agent-config.yaml"
TARGET_TMS_ADAPTER_CONFIG="$QUOTEOPS_CONNECTORS_DIR/tms-adapter.yaml"
TARGET_TMS_MAPPING_CONFIG="$QUOTEOPS_CONNECTORS_DIR/tms-mapping.json"
if [[ -n "$AGENT_CONFIG_PATH" || ( -n "$CONNECTORS_PATH" && -e "$CONNECTORS_PATH/agent/agent-config.yaml" ) ]]; then
  if [[ "$EXISTING_INSTALL" -eq 1 && -e "$TARGET_AGENT_CONFIG" ]] &&
     cmp -s "${AGENT_CONFIG_PATH:-$CONNECTORS_PATH/agent/agent-config.yaml}" "$TARGET_AGENT_CONFIG"; then
    :
  else
  guard_target "agent config copy" "$TARGET_AGENT_CONFIG"
  fi
fi
if [[ -n "$TMS_ADAPTER_CONFIG_PATH" || ( -n "$CONNECTORS_PATH" && -e "$CONNECTORS_PATH/tms-adapter.yaml" ) ]]; then
  TMS_ADAPTER_SOURCE="${TMS_ADAPTER_CONFIG_PATH:-$CONNECTORS_PATH/tms-adapter.yaml}"
  if [[ "$EXISTING_INSTALL" -ne 1 || ! -e "$TARGET_TMS_ADAPTER_CONFIG" ]] ||
     ! cmp -s "$TMS_ADAPTER_SOURCE" "$TARGET_TMS_ADAPTER_CONFIG"; then
    guard_target "TMS adapter config copy" "$TARGET_TMS_ADAPTER_CONFIG"
  fi
fi
if [[ -n "$TMS_MAPPING_CONFIG_PATH" || ( -n "$CONNECTORS_PATH" && -e "$CONNECTORS_PATH/tms-mapping.json" ) ]]; then
  TMS_MAPPING_SOURCE="${TMS_MAPPING_CONFIG_PATH:-$CONNECTORS_PATH/tms-mapping.json}"
  if [[ "$EXISTING_INSTALL" -ne 1 || ! -e "$TARGET_TMS_MAPPING_CONFIG" ]] ||
     ! cmp -s "$TMS_MAPPING_SOURCE" "$TARGET_TMS_MAPPING_CONFIG"; then
    guard_target "TMS mapping config copy" "$TARGET_TMS_MAPPING_CONFIG"
  fi
fi
if [[ -n "$CONNECTORS_PATH" && "$FORCE" -ne 1 ]]; then
  guard_connector_pack_overwrite "$CONNECTORS_PATH" "$QUOTEOPS_CONNECTORS_DIR"
fi

PROJECT_CLIENT="$(printf "%s" "$CLIENT_ID" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/^-*//; s/-*$//')"
[[ -n "$PROJECT_CLIENT" ]] || die "client id did not produce a valid compose project suffix"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-quoteops_v1}"
[[ "$COMPOSE_PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]*$ ]] ||
  die "COMPOSE_PROJECT_NAME must use lowercase letters, numbers, underscores, or dashes"
QUOTEOPS_INSTALLATION_ID="${QUOTEOPS_INSTALLATION_ID:-$PROJECT_CLIENT-local-001}"
RELEASE_DIR="$(stage_release "$INSTALL_MODE")"

mkdir -p "$QUOTEOPS_MANIFEST_DIR" "$QUOTEOPS_CRITERIA_DIR" "$QUOTEOPS_CONNECTORS_DIR" \
  "$QUOTEOPS_SECRETS_DIR" "$QUOTEOPS_SETTINGS_DIR" "$QUOTEOPS_HOME/state" \
  "$QUOTEOPS_LOG_DIR" "$QUOTEOPS_BACKUP_DIR"
mkdir -p "$QUOTEOPS_CONNECTORS_DIR/agent" "$QUOTEOPS_CONNECTORS_DIR/sakbe" "$QUOTEOPS_CONNECTORS_DIR/tms" "$QUOTEOPS_CONNECTORS_DIR/knowledge"
chmod 700 "$QUOTEOPS_HOME" "$QUOTEOPS_SECRETS_DIR" "$QUOTEOPS_MANIFEST_DIR" \
  "$QUOTEOPS_CRITERIA_DIR" "$QUOTEOPS_CONNECTORS_DIR" "$QUOTEOPS_LOG_DIR" \
  "$QUOTEOPS_BACKUP_DIR" "$QUOTEOPS_SETTINGS_DIR" "$QUOTEOPS_HOME/state"
trap cleanup EXIT
if [[ -n "$ANSWERS_DIR" ]]; then
  create_acceptance_override
fi

if [[ ! -e "$SECRETS_ENV_FILE" ]]; then
  : > "$SECRETS_ENV_FILE"
  chmod 600 "$SECRETS_ENV_FILE"
fi
if [[ ! -e "$CLOUDFLARE_ENV_FILE" ]]; then
  : > "$CLOUDFLARE_ENV_FILE"
  chmod 600 "$CLOUDFLARE_ENV_FILE"
fi
validate_secret_file "$SECRETS_ENV_FILE"
validate_secret_file "$CLOUDFLARE_ENV_FILE"
if [[ "$START_STACK" -eq 1 ]]; then
  if [[ -e "$CLOUDFLARE_ACCESS_ENV_FILE" || -L "$CLOUDFLARE_ACCESS_ENV_FILE" ]]; then
    validate_cloudflare_access_file
  fi
  validate_cloudflare_tunnel_env
  if [[ "$GUIDED" -eq 1 ]]; then
    load_cloudflare_gate_settings
  fi
fi

EXISTING_POSTGRES_PASSWORD="$(read_env_value POSTGRES_PASSWORD "$SECRETS_ENV_FILE")"
if [[ -n "$EXISTING_POSTGRES_PASSWORD" ]]; then
  POSTGRES_PASSWORD="$EXISTING_POSTGRES_PASSWORD"
else
  POSTGRES_VOLUME_STATE="$(postgres_volume_state)"
  [[ "$POSTGRES_VOLUME_STATE" == "absent" ]] ||
    die "PostgreSQL data volume state is existing but client.env has no password; recovery is required"
  if [[ -z "$POSTGRES_PASSWORD" ]]; then
    POSTGRES_PASSWORD="$(generate_secret)"
  fi
  POSTGRES_PASSWORD="$(ensure_secret_key "$SECRETS_ENV_FILE" POSTGRES_PASSWORD "$POSTGRES_PASSWORD")"
fi
ensure_secret_key "$SECRETS_ENV_FILE" DATABASE_URL \
  "postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@postgres:5432/$POSTGRES_DB" >/dev/null
if [[ -n "$INEGI_SAKBE_KEY" ]]; then
  ensure_secret_key "$SECRETS_ENV_FILE" INEGI_SAKBE_KEY "$INEGI_SAKBE_KEY" >/dev/null
fi
if [[ -n "$GEMINI_API_KEY" ]]; then
  ensure_secret_key "$SECRETS_ENV_FILE" GEMINI_API_KEY "$GEMINI_API_KEY" >/dev/null
fi
if [[ -n "$OPENROUTER_API_KEY" ]]; then
  ensure_secret_key "$SECRETS_ENV_FILE" OPENROUTER_API_KEY "$OPENROUTER_API_KEY" >/dev/null
fi
if [[ -n "$QUOTEOPS_REGISTRATION_TOKEN" ]]; then
  QUOTEOPS_REGISTRATION_TOKEN="$(
    ensure_secret_key "$SECRETS_ENV_FILE" QUOTEOPS_REGISTRATION_TOKEN "$QUOTEOPS_REGISTRATION_TOKEN"
  )"
fi
validate_secret_file "$SECRETS_ENV_FILE"
if [[ -n "$QUOTEOPS_REGISTRATION_TOKEN_FILE" ]]; then
  [[ "$QUOTEOPS_REGISTRATION_TOKEN_FILE" != "$SECRETS_ENV_FILE" ]] ||
    die "transient registration token file cannot be the durable client env"
  rm -f "$QUOTEOPS_REGISTRATION_TOKEN_FILE"
  QUOTEOPS_REGISTRATION_TOKEN_FILE=""
fi

TMP_ENV="$ENV_FILE.tmp.$$"
TMP_MANIFEST="$TARGET_MANIFEST.tmp.$$"

{
  write_env_line COMPOSE_PROJECT_NAME "$COMPOSE_PROJECT_NAME"
  write_env_line QUOTEOPS_CLIENT_ID "$CLIENT_ID"
  write_env_line QUOTEOPS_INSTALL_MODE "$INSTALL_MODE"
  write_env_line QUOTEOPS_HOME "$QUOTEOPS_HOME"
  write_env_line QUOTEOPS_MANIFEST_DIR "$QUOTEOPS_MANIFEST_DIR"
  write_env_line QUOTEOPS_CRITERIA_DIR "$QUOTEOPS_CRITERIA_DIR"
  write_env_line QUOTEOPS_CONNECTORS_DIR "$QUOTEOPS_CONNECTORS_DIR"
  write_env_line QUOTEOPS_SECRETS_DIR "$QUOTEOPS_SECRETS_DIR"
  write_env_line QUOTEOPS_CLIENT_ENV_FILE "$SECRETS_ENV_FILE"
  write_env_line QUOTEOPS_CLOUDFLARE_ENV_FILE "$CLOUDFLARE_ENV_FILE"
  if [[ -n "$QUOTEOPS_PUBLIC_HOSTNAME" ]]; then
    write_env_line QUOTEOPS_PUBLIC_HOSTNAME "$QUOTEOPS_PUBLIC_HOSTNAME"
  fi
  write_env_line QUOTEOPS_AGENT_CONFIG_PATH "/opt/quoteops-v1/connectors/agent/agent-config.yaml"
  write_env_line QUOTEOPS_TMS_ADAPTER_CONFIG_PATH "/opt/quoteops-v1/connectors/tms-adapter.yaml"
  if [[ -n "$TMS_MAPPING_CONFIG_PATH" || ( -n "$CONNECTORS_PATH" && -e "$CONNECTORS_PATH/tms-mapping.json" ) ]]; then
    write_env_line QUOTEOPS_TMS_MAPPING_CONFIG_PATH "/opt/quoteops-v1/connectors/tms-mapping.json"
  fi
  write_env_line QUOTEOPS_ROUTE_CACHE_PATH "/opt/quoteops-v1/connectors/sakbe/route-cache.json"
  write_env_line QUOTEOPS_SAKBE_CACHE_MODE "$QUOTEOPS_SAKBE_CACHE_MODE"
  write_env_line QUOTEOPS_SAKBE_LIVE_ENABLED "$QUOTEOPS_SAKBE_LIVE_ENABLED"
  write_env_line QUOTEOPS_TMS_RFQS_PATH "/opt/quoteops-v1/connectors/tms/rfqs.csv"
  write_env_line QUOTEOPS_TMS_HISTORICAL_QUOTES_PATH "/opt/quoteops-v1/connectors/tms/historical-quotes.csv"
  write_env_line QUOTEOPS_TMS_HISTORICAL_SHIPMENTS_PATH "/opt/quoteops-v1/connectors/tms/historical-shipments.csv"
  write_env_line QUOTEOPS_TMS_CUSTOMERS_PATH "/opt/quoteops-v1/connectors/tms/customers.csv"
  write_env_line QUOTEOPS_TMS_AGREEMENTS_PATH "/opt/quoteops-v1/connectors/tms/agreements.csv"
  write_env_line QUOTEOPS_TMS_UNIT_POSITIONS_PATH "/opt/quoteops-v1/connectors/tms/unit-positions.csv"
  write_env_line QUOTEOPS_TMS_UNITS_PATH "/opt/quoteops-v1/connectors/tms/units.csv"
  write_env_line QUOTEOPS_TMS_PERFORMANCE_PATH "/opt/quoteops-v1/connectors/tms/performance.csv"
  write_env_line QUOTEOPS_TMS_AVAILABILITY_ZONES_PATH "/opt/quoteops-v1/connectors/tms/availability-zones.csv"
  write_env_line QUOTEOPS_TMS_QUOTE_WRITEBACKS_PATH "/opt/quoteops-v1/connectors/tms/quote-writebacks.jsonl"
  write_env_line QUOTEOPS_TMS_STATUS_WRITEBACKS_PATH "/opt/quoteops-v1/connectors/tms/status-writebacks.jsonl"
  write_env_line QUOTEOPS_LOG_DIR "$QUOTEOPS_LOG_DIR"
  write_env_line QUOTEOPS_BACKUP_DIR "$QUOTEOPS_BACKUP_DIR"
  write_env_line QUOTEOPS_SETTINGS_DIR "$QUOTEOPS_SETTINGS_DIR"
  write_env_line CADDYFILE_PATH "$QUOTEOPS_HOME/current/Caddyfile"
  write_env_line QUOTEOPS_SITE_ADDRESS "$QUOTEOPS_SITE_ADDRESS"
  write_env_line QUOTEOPS_HTTP_PORT "$QUOTEOPS_HTTP_PORT"
  write_env_line QUOTEOPS_HTTPS_PORT "$QUOTEOPS_HTTPS_PORT"
  write_env_line QUOTEOPS_CONTROL_PLANE_URL "$QUOTEOPS_CONTROL_PLANE_URL"
  write_env_line QUOTEOPS_INSTALLATION_ID "$QUOTEOPS_INSTALLATION_ID"
  write_env_line POSTGRES_DB "$POSTGRES_DB"
  write_env_line POSTGRES_USER "$POSTGRES_USER"
} > "$TMP_ENV"
chmod 600 "$TMP_ENV"

cp "$MANIFEST_PATH" "$TMP_MANIFEST"
chmod 600 "$TMP_MANIFEST"
mv "$TMP_ENV" "$ENV_FILE"
mv "$TMP_MANIFEST" "$TARGET_MANIFEST"

if [[ -n "$CONNECTORS_PATH" ]]; then
  cp -R "$CONNECTORS_PATH/." "$QUOTEOPS_CONNECTORS_DIR/"
fi

if [[ -n "$TMS_ADAPTER_CONFIG_PATH" ]]; then
  cp "$TMS_ADAPTER_CONFIG_PATH" "$TARGET_TMS_ADAPTER_CONFIG"
elif [[ ! -f "$TARGET_TMS_ADAPTER_CONFIG" ]]; then
  cat > "$TARGET_TMS_ADAPTER_CONFIG" <<'YAML'
provider: file_import
rfqs_path_env: QUOTEOPS_TMS_RFQS_PATH
historical_quotes_path_env: QUOTEOPS_TMS_HISTORICAL_QUOTES_PATH
historical_shipments_path_env: QUOTEOPS_TMS_HISTORICAL_SHIPMENTS_PATH
customers_path_env: QUOTEOPS_TMS_CUSTOMERS_PATH
agreements_path_env: QUOTEOPS_TMS_AGREEMENTS_PATH
unit_positions_path_env: QUOTEOPS_TMS_UNIT_POSITIONS_PATH
units_path_env: QUOTEOPS_TMS_UNITS_PATH
performance_path_env: QUOTEOPS_TMS_PERFORMANCE_PATH
availability_zones_path_env: QUOTEOPS_TMS_AVAILABILITY_ZONES_PATH
quote_writebacks_path_env: QUOTEOPS_TMS_QUOTE_WRITEBACKS_PATH
status_writebacks_path_env: QUOTEOPS_TMS_STATUS_WRITEBACKS_PATH
YAML
fi
chmod 600 "$TARGET_TMS_ADAPTER_CONFIG"

if [[ -n "$TMS_MAPPING_CONFIG_PATH" ]]; then
  cp "$TMS_MAPPING_CONFIG_PATH" "$TARGET_TMS_MAPPING_CONFIG"
fi
if [[ -f "$TARGET_TMS_MAPPING_CONFIG" ]]; then
  chmod 600 "$TARGET_TMS_MAPPING_CONFIG"
fi

if [[ -n "$AGENT_CONFIG_PATH" ]]; then
  cp "$AGENT_CONFIG_PATH" "$TARGET_AGENT_CONFIG"
fi

if [[ ! -f "$TARGET_AGENT_CONFIG" ]]; then
  die "agent config was not installed: $TARGET_AGENT_CONFIG"
fi
chmod 600 "$TARGET_AGENT_CONFIG"

switch_current_release "$RELEASE_DIR"

WRITE_WRAPPER=0
if [[ -n "${QUOTEOPS_BIN_DIR:-}" ]]; then
  validate_bin_override "$QUOTEOPS_BIN_DIR"
  WRITE_WRAPPER=1
elif [[ "$GUIDED" -eq 1 || "$QUOTEOPS_HOME" == "/opt/quoteops-v1" ]]; then
  QUOTEOPS_BIN_DIR="/usr/local/bin"
  WRITE_WRAPPER=1
fi
if [[ "$WRITE_WRAPPER" -eq 1 ]]; then
  mkdir -p "$QUOTEOPS_BIN_DIR"
  WRAPPER_FILE="$QUOTEOPS_BIN_DIR/quoteops"
  TMP_WRAPPER="$WRAPPER_FILE.tmp.$$"
  cat > "$TMP_WRAPPER" <<EOF
#!/usr/bin/env bash
exec "$QUOTEOPS_HOME/current/quoteops.sh" "\$@"
EOF
  chmod 755 "$TMP_WRAPPER"
  mv "$TMP_WRAPPER" "$WRAPPER_FILE"
fi

COMPOSE_FILE="$RELEASE_DIR/docker-compose.yml"
RELEASE_ENV_FILE="$RELEASE_DIR/release.env"
unset POSTGRES_PASSWORD QUOTEOPS_REGISTRATION_TOKEN INEGI_SAKBE_KEY GEMINI_API_KEY OPENROUTER_API_KEY
if [[ "$START_STACK" -eq 1 ]]; then
  docker compose --env-file "$ENV_FILE" --env-file "$RELEASE_ENV_FILE" \
    -f "$COMPOSE_FILE" --profile tunnel config >/dev/null
  if [[ "$PULL_IMAGES" -eq 1 ]]; then
    docker compose --env-file "$ENV_FILE" --env-file "$RELEASE_ENV_FILE" \
      -f "$COMPOSE_FILE" --profile tunnel pull
  fi
  if [[ "$GUIDED" -eq 1 ]]; then
    if run_guided_sequence; then
      :
    else
      guided_status=$?
      exit "$guided_status"
    fi
  else
    docker compose --env-file "$ENV_FILE" --env-file "$RELEASE_ENV_FILE" \
      -f "$COMPOSE_FILE" --profile tunnel up -d
  fi
fi

echo "QuoteOps appliance prepared for client: $CLIENT_ID"
echo "Env file: $ENV_FILE"
echo "Secrets env file: $SECRETS_ENV_FILE"
echo "Manifest: $TARGET_MANIFEST"
echo "Connectors: $QUOTEOPS_CONNECTORS_DIR"
echo "Agent config: $TARGET_AGENT_CONFIG"
echo "TMS adapter config: $TARGET_TMS_ADAPTER_CONFIG"
if [[ -f "$TARGET_TMS_MAPPING_CONFIG" ]]; then
  echo "TMS mapping config: $TARGET_TMS_MAPPING_CONFIG"
fi
echo
if [[ "$GUIDED" -ne 1 ]]; then
  echo "Next: run the guided TRON onboarding (captures the AI key, secrets, TMS, units and knowledge):"
  echo "  quoteops onboard"
  echo "Re-run a single step anytime: append --sync-units, --map-tms or --ingest to that command."
fi
