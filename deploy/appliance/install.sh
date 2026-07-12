#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
COMPOSE_FILE="${COMPOSE_FILE:-$SCRIPT_DIR/docker-compose.yml}"
QUOTEOPS_HOME="${QUOTEOPS_HOME:-/opt/quoteops}"
ENV_FILE="${QUOTEOPS_ENV_FILE:-$QUOTEOPS_HOME/.env}"
SECRETS_ENV_FILE="${QUOTEOPS_SECRETS_ENV_FILE:-$QUOTEOPS_HOME/secrets/client.env}"
CLIENT_ID=""
MANIFEST_PATH=""
CONNECTORS_PATH=""
AGENT_CONFIG_PATH=""
TMS_ADAPTER_CONFIG_PATH=""
QUOTEOPS_VERSION="${QUOTEOPS_VERSION:-quoteops-v2.2.3}"
QUOTEOPS_IMAGE_REGISTRY="${QUOTEOPS_IMAGE_REGISTRY:-ghcr.io/alejandroc-bit}"
QUOTEOPS_SITE_ADDRESS="${QUOTEOPS_SITE_ADDRESS:-:80}"
QUOTEOPS_HTTP_PORT="${QUOTEOPS_HTTP_PORT:-80}"
QUOTEOPS_HTTPS_PORT="${QUOTEOPS_HTTPS_PORT:-443}"
QUOTEOPS_SAKBE_LIVE_ENABLED="${QUOTEOPS_SAKBE_LIVE_ENABLED:-true}"
QUOTEOPS_SAKBE_CACHE_MODE="${QUOTEOPS_SAKBE_CACHE_MODE:-cache_first}"
QUOTEOPS_CONTROL_PLANE_URL="${QUOTEOPS_CONTROL_PLANE_URL:-}"
QUOTEOPS_REGISTRATION_TOKEN="${QUOTEOPS_REGISTRATION_TOKEN:-}"
QUOTEOPS_INSTALLATION_ID="${QUOTEOPS_INSTALLATION_ID:-}"
INEGI_SAKBE_KEY="${INEGI_SAKBE_KEY:-}"
GEMINI_API_KEY="${GEMINI_API_KEY:-}"
OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}"
POSTGRES_DB="${POSTGRES_DB:-quoteops}"
POSTGRES_USER="${POSTGRES_USER:-quoteops}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"
FORCE=0
START_STACK=1
ENV_FILE_SET=0
SECRETS_ENV_FILE_SET=0

usage() {
  cat <<USAGE
Usage: $(basename "$0") --client cliente-demo --manifest manifest.yaml [options]

Options:
  --home PATH              Appliance data root (default: /opt/quoteops)
  --env-file PATH          Compose env file (default: <home>/.env)
  --secrets-env-file PATH  Client secrets env file (default: <home>/secrets/client.env)
  --compose-file PATH      Compose file (default: deploy/appliance/docker-compose.yml)
  --connectors PATH        Copy connector pack directory into <home>/connectors
  --connectors-dir PATH    Connector data root (default: <home>/connectors)
  --agent-config PATH      Copy agent config YAML/JSON into connectors/agent
  --tms-adapter-config PATH Copy TMS adapter config YAML/JSON into connectors/tms-adapter.yaml
  --version VERSION        QuoteOps image tag (default: quoteops-v2.2.3)
  --image-registry IMAGE   Image registry/prefix (default: ghcr.io/alejandroc-bit)
  --site-address ADDRESS   Caddy site address (default: :80)
  --http-port PORT         Host HTTP port (default: 80)
  --https-port PORT        Host HTTPS port (default: 443)
  --postgres-db NAME       Postgres database name (default: quoteops)
  --postgres-user NAME     Postgres user (default: quoteops)
  --postgres-password PW   Postgres password (generated if omitted)
  --sakbe-live BOOL        Allow live SAKBE calls after cache miss (default: true)
  --sakbe-cache-mode MODE  SAKBE cache mode: cache_first or live_only (default: cache_first)
  --control-plane-url URL  Inducta control-plane base URL for activation and aggregate sync
  --registration-token TOK Short-lived client installation token (stored in secrets env)
  --installation-id ID     Stable appliance installation id
  --force                  Replace existing env file and manifest copy
  --skip-start             Prepare files without running docker compose up
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
  need_command openssl
  openssl rand -hex 32
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
      die "connector pack file already exists: $target_path (use --force to replace)"
    fi
  done < <(find "$source_dir" -mindepth 1 -print0)
}

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
    --version)
      require_value "$1" "${2:-}"
      QUOTEOPS_VERSION="$2"
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
    --installation-id)
      require_value "$1" "${2:-}"
      QUOTEOPS_INSTALLATION_ID="$2"
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
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ -n "$CLIENT_ID" ]] || die "--client is required"
[[ -n "$MANIFEST_PATH" ]] || die "--manifest is required"
[[ "$CLIENT_ID" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die "--client may only contain letters, numbers, dot, underscore, or dash"
[[ "$QUOTEOPS_VERSION" =~ ^quoteops-v[0-9]+[.][0-9]+[.][0-9]+([-+A-Za-z0-9.]+)?$ ]] || die "--version must look like quoteops-v2.0.1"
[[ "$QUOTEOPS_SAKBE_LIVE_ENABLED" =~ ^(true|false|1|0|yes|no|on|off)$ ]] || die "--sakbe-live must be true or false"
[[ "$QUOTEOPS_SAKBE_CACHE_MODE" =~ ^(cache_first|live_only)$ ]] || die "--sakbe-cache-mode must be cache_first or live_only"
[[ -f "$MANIFEST_PATH" ]] || die "manifest not found: $MANIFEST_PATH"
[[ -r "$MANIFEST_PATH" ]] || die "manifest is not readable: $MANIFEST_PATH"
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
if [[ -z "$AGENT_CONFIG_PATH" ]]; then
  if [[ -z "$CONNECTORS_PATH" || ! -f "$CONNECTORS_PATH/agent/agent-config.yaml" ]]; then
    die "agent config is required: provide --agent-config or --connectors containing agent/agent-config.yaml"
  fi
fi
QUOTEOPS_HOME="$(mkdir -p "$QUOTEOPS_HOME" && cd "$QUOTEOPS_HOME" && pwd -P)"
ENV_FILE="$(absolute_new_path "$ENV_FILE")"
SECRETS_ENV_FILE="$(absolute_new_path "$SECRETS_ENV_FILE")"
QUOTEOPS_MANIFEST_DIR="${QUOTEOPS_MANIFEST_DIR:-$QUOTEOPS_HOME/manifests}"
QUOTEOPS_CRITERIA_DIR="${QUOTEOPS_CRITERIA_DIR:-$QUOTEOPS_HOME/criteria}"
QUOTEOPS_CONNECTORS_DIR="${QUOTEOPS_CONNECTORS_DIR:-$QUOTEOPS_HOME/connectors}"
QUOTEOPS_LOG_DIR="${QUOTEOPS_LOG_DIR:-$QUOTEOPS_HOME/logs}"
QUOTEOPS_BACKUP_DIR="${QUOTEOPS_BACKUP_DIR:-$QUOTEOPS_HOME/backups}"
QUOTEOPS_SECRETS_DIR="$(dirname "$SECRETS_ENV_FILE")"
CADDYFILE_PATH="${CADDYFILE_PATH:-$SCRIPT_DIR/Caddyfile}"
CADDYFILE_PATH="$(absolute_path "$CADDYFILE_PATH")"

[[ -f "$COMPOSE_FILE" ]] || die "compose file not found: $COMPOSE_FILE"
[[ -f "$CADDYFILE_PATH" ]] || die "Caddyfile not found: $CADDYFILE_PATH"

if [[ "$START_STACK" -eq 1 ]]; then
  need_command docker
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required"
fi

guard_target "env file" "$ENV_FILE"
guard_target "secrets env file" "$SECRETS_ENV_FILE"

TARGET_MANIFEST="$QUOTEOPS_MANIFEST_DIR/client-manifest.yaml"
guard_target "manifest copy" "$TARGET_MANIFEST"
TARGET_AGENT_CONFIG="$QUOTEOPS_CONNECTORS_DIR/agent/agent-config.yaml"
TARGET_TMS_ADAPTER_CONFIG="$QUOTEOPS_CONNECTORS_DIR/tms-adapter.yaml"
if [[ -n "$AGENT_CONFIG_PATH" || ( -n "$CONNECTORS_PATH" && -e "$CONNECTORS_PATH/agent/agent-config.yaml" ) ]]; then
  guard_target "agent config copy" "$TARGET_AGENT_CONFIG"
fi
if [[ -n "$TMS_ADAPTER_CONFIG_PATH" || ( -n "$CONNECTORS_PATH" && -e "$CONNECTORS_PATH/tms-adapter.yaml" ) ]]; then
  guard_target "TMS adapter config copy" "$TARGET_TMS_ADAPTER_CONFIG"
fi
if [[ -n "$CONNECTORS_PATH" && "$FORCE" -ne 1 ]]; then
  guard_connector_pack_overwrite "$CONNECTORS_PATH" "$QUOTEOPS_CONNECTORS_DIR"
fi

PROJECT_CLIENT="$(printf "%s" "$CLIENT_ID" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/^-*//; s/-*$//')"
[[ -n "$PROJECT_CLIENT" ]] || die "client id did not produce a valid compose project suffix"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-quoteops-$PROJECT_CLIENT}"
QUOTEOPS_INSTALLATION_ID="${QUOTEOPS_INSTALLATION_ID:-$PROJECT_CLIENT-local-001}"
POSTGRES_PASSWORD="$(generate_secret)"

mkdir -p "$(dirname "$ENV_FILE")" "$QUOTEOPS_SECRETS_DIR" "$QUOTEOPS_MANIFEST_DIR" "$QUOTEOPS_CRITERIA_DIR" "$QUOTEOPS_CONNECTORS_DIR" "$QUOTEOPS_LOG_DIR" "$QUOTEOPS_BACKUP_DIR"
mkdir -p "$QUOTEOPS_CONNECTORS_DIR/agent" "$QUOTEOPS_CONNECTORS_DIR/sakbe" "$QUOTEOPS_CONNECTORS_DIR/tms" "$QUOTEOPS_CONNECTORS_DIR/knowledge"
chmod 700 "$QUOTEOPS_HOME" "$QUOTEOPS_SECRETS_DIR" "$QUOTEOPS_MANIFEST_DIR" "$QUOTEOPS_CRITERIA_DIR" "$QUOTEOPS_CONNECTORS_DIR" "$QUOTEOPS_LOG_DIR" "$QUOTEOPS_BACKUP_DIR"

TMP_ENV="$ENV_FILE.tmp.$$"
TMP_SECRETS_ENV="$SECRETS_ENV_FILE.tmp.$$"
TMP_MANIFEST="$TARGET_MANIFEST.tmp.$$"
cleanup() {
  rm -f "$TMP_ENV" "$TMP_SECRETS_ENV" "$TMP_MANIFEST"
}
trap cleanup EXIT

{
  write_env_line COMPOSE_PROJECT_NAME "$COMPOSE_PROJECT_NAME"
  write_env_line QUOTEOPS_CLIENT_ID "$CLIENT_ID"
  write_env_line QUOTEOPS_VERSION "$QUOTEOPS_VERSION"
  write_env_line QUOTEOPS_IMAGE_REGISTRY "$QUOTEOPS_IMAGE_REGISTRY"
  write_env_line QUOTEOPS_HOME "$QUOTEOPS_HOME"
  write_env_line QUOTEOPS_MANIFEST_DIR "$QUOTEOPS_MANIFEST_DIR"
  write_env_line QUOTEOPS_CRITERIA_DIR "$QUOTEOPS_CRITERIA_DIR"
  write_env_line QUOTEOPS_CONNECTORS_DIR "$QUOTEOPS_CONNECTORS_DIR"
  write_env_line QUOTEOPS_SECRETS_DIR "$QUOTEOPS_SECRETS_DIR"
  write_env_line QUOTEOPS_SECRETS_ENV_FILE "$SECRETS_ENV_FILE"
  write_env_line QUOTEOPS_AGENT_CONFIG_PATH "/opt/quoteops/connectors/agent/agent-config.yaml"
  write_env_line QUOTEOPS_TMS_ADAPTER_CONFIG_PATH "/opt/quoteops/connectors/tms-adapter.yaml"
  write_env_line QUOTEOPS_ROUTE_CACHE_PATH "/opt/quoteops/connectors/sakbe/route-cache.json"
  write_env_line QUOTEOPS_SAKBE_CACHE_MODE "$QUOTEOPS_SAKBE_CACHE_MODE"
  write_env_line QUOTEOPS_SAKBE_LIVE_ENABLED "$QUOTEOPS_SAKBE_LIVE_ENABLED"
  write_env_line QUOTEOPS_TMS_RFQS_PATH "/opt/quoteops/connectors/tms/rfqs.csv"
  write_env_line QUOTEOPS_TMS_HISTORICAL_QUOTES_PATH "/opt/quoteops/connectors/tms/historical-quotes.csv"
  write_env_line QUOTEOPS_TMS_HISTORICAL_SHIPMENTS_PATH "/opt/quoteops/connectors/tms/historical-shipments.csv"
  write_env_line QUOTEOPS_TMS_CUSTOMERS_PATH "/opt/quoteops/connectors/tms/customers.csv"
  write_env_line QUOTEOPS_TMS_AGREEMENTS_PATH "/opt/quoteops/connectors/tms/agreements.csv"
  write_env_line QUOTEOPS_TMS_UNIT_POSITIONS_PATH "/opt/quoteops/connectors/tms/unit-positions.csv"
  write_env_line QUOTEOPS_TMS_UNITS_PATH "/opt/quoteops/connectors/tms/units.csv"
  write_env_line QUOTEOPS_TMS_PERFORMANCE_PATH "/opt/quoteops/connectors/tms/performance.csv"
  write_env_line QUOTEOPS_TMS_AVAILABILITY_ZONES_PATH "/opt/quoteops/connectors/tms/availability-zones.csv"
  write_env_line QUOTEOPS_TMS_QUOTE_WRITEBACKS_PATH "/opt/quoteops/connectors/tms/quote-writebacks.jsonl"
  write_env_line QUOTEOPS_TMS_STATUS_WRITEBACKS_PATH "/opt/quoteops/connectors/tms/status-writebacks.jsonl"
  write_env_line QUOTEOPS_LOG_DIR "$QUOTEOPS_LOG_DIR"
  write_env_line QUOTEOPS_BACKUP_DIR "$QUOTEOPS_BACKUP_DIR"
  write_env_line CADDYFILE_PATH "$CADDYFILE_PATH"
  write_env_line QUOTEOPS_SITE_ADDRESS "$QUOTEOPS_SITE_ADDRESS"
  write_env_line QUOTEOPS_HTTP_PORT "$QUOTEOPS_HTTP_PORT"
  write_env_line QUOTEOPS_HTTPS_PORT "$QUOTEOPS_HTTPS_PORT"
  write_env_line QUOTEOPS_CONTROL_PLANE_URL "$QUOTEOPS_CONTROL_PLANE_URL"
  write_env_line QUOTEOPS_INSTALLATION_ID "$QUOTEOPS_INSTALLATION_ID"
  write_env_line POSTGRES_DB "$POSTGRES_DB"
  write_env_line POSTGRES_USER "$POSTGRES_USER"
  write_env_line POSTGRES_PASSWORD "$POSTGRES_PASSWORD"
} > "$TMP_ENV"
chmod 600 "$TMP_ENV"

{
  write_env_line INEGI_SAKBE_KEY "$INEGI_SAKBE_KEY"
  write_env_line GEMINI_API_KEY "$GEMINI_API_KEY"
  write_env_line OPENROUTER_API_KEY "$OPENROUTER_API_KEY"
  if [[ -n "$QUOTEOPS_REGISTRATION_TOKEN" ]]; then
    write_env_line QUOTEOPS_REGISTRATION_TOKEN "$QUOTEOPS_REGISTRATION_TOKEN"
  fi
} > "$TMP_SECRETS_ENV"
chmod 600 "$TMP_SECRETS_ENV"

cp "$MANIFEST_PATH" "$TMP_MANIFEST"
chmod 600 "$TMP_MANIFEST"
mv "$TMP_ENV" "$ENV_FILE"
mv "$TMP_SECRETS_ENV" "$SECRETS_ENV_FILE"
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

if [[ -n "$AGENT_CONFIG_PATH" ]]; then
  cp "$AGENT_CONFIG_PATH" "$TARGET_AGENT_CONFIG"
fi

if [[ ! -f "$TARGET_AGENT_CONFIG" ]]; then
  die "agent config was not installed: $TARGET_AGENT_CONFIG"
fi
chmod 600 "$TARGET_AGENT_CONFIG"

if [[ "$START_STACK" -eq 1 ]]; then
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config >/dev/null
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d
fi

echo "QuoteOps appliance prepared for client: $CLIENT_ID"
echo "Env file: $ENV_FILE"
echo "Secrets env file: $SECRETS_ENV_FILE"
echo "Manifest: $TARGET_MANIFEST"
echo "Connectors: $QUOTEOPS_CONNECTORS_DIR"
echo "Agent config: $TARGET_AGENT_CONFIG"
echo "TMS adapter config: $TARGET_TMS_ADAPTER_CONFIG"
echo
echo "Next: run the guided TRON onboarding (captures the AI key, secrets, TMS, units and knowledge):"
echo "  docker compose --env-file \"$ENV_FILE\" -f \"$COMPOSE_FILE\" run --rm quoteops-onboard"
echo "Re-run a single step anytime: append --sync-units, --map-tms or --ingest to that command."
