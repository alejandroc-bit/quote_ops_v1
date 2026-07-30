#!/usr/bin/env bash
set -u
umask 077

MODE="${1:---summary}"
case "$MODE" in
  --summary|--verbose) KEEP_ACCESS_ENV=0 ;;
  --resume-guided) KEEP_ACCESS_ENV=1 ;;
  *) exit 2 ;;
esac

QUOTEOPS_HOME="${QUOTEOPS_HOME:-/opt/quoteops-v1}"
ENV_FILE="$QUOTEOPS_HOME/.env"
RELEASE_ENV_FILE="$QUOTEOPS_HOME/current/release.env"
COMPOSE_FILE="$QUOTEOPS_HOME/current/docker-compose.yml"
CLOUDFLARE_SETTINGS_FILE="$QUOTEOPS_HOME/settings/cloudflare.json"
VALIDATION_RECEIPT_FILE="$QUOTEOPS_HOME/settings/cloudflare-public-validation.json"
ACCESS_ENV_FILE="$QUOTEOPS_HOME/secrets/cloudflare-access-validation.env"
TMP_DIR=""

VERSION=""
PUBLIC_HOSTNAME=""
CLIENT_ID=""
INSTALLATION_ID=""
CORE_CHECK="failed"
TUNNEL_CHECK="failed"
ACCESS_CHECK="failed"
ORIGIN_CHECK="failed"
SETUP_CHECK="failed"

read_env_value() {
  local key="$1"
  local file="$2"
  local value
  value="$(sed -n "s/^${key}=//p" "$file" 2>/dev/null | head -1)"
  value="${value#\"}"
  value="${value%\"}"
  printf '%s' "$value"
}

file_mode() {
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

file_owner_id() {
  if stat -f '%u' "$1" >/dev/null 2>&1; then
    stat -f '%u' "$1"
  else
    stat -c '%u' "$1"
  fi
}

cloudflare_access_owner_is_valid() {
  local expected_owner=0
  local physical_home
  local physical_tmp
  case "${QUOTEOPS_VERIFY_TEST_MODE:-}" in
    "")
      ;;
    smoke)
      [[ -d "$QUOTEOPS_HOME" && ! -L "$QUOTEOPS_HOME" ]] || return 1
      physical_home="$(cd "$QUOTEOPS_HOME" && pwd -P)" || return 1
      physical_tmp="$(cd "${TMPDIR:-/tmp}" && pwd -P)" || return 1
      case "$physical_home" in
        "$physical_tmp"/quoteops-cloudflare-gate.*/home)
          expected_owner="$(id -u)"
          ;;
        *) return 1 ;;
      esac
      ;;
    *)
      return 1
      ;;
  esac
  [[ "$(file_owner_id "$ACCESS_ENV_FILE")" == "$expected_owner" ]]
}

json_result() {
  local status="$1"
  printf '{\n'
  printf '  "status": "%s",\n' "$status"
  printf '  "version": "%s",\n' "$VERSION"
  printf '  "public_hostname": "%s",\n' "$PUBLIC_HOSTNAME"
  printf '  "checks": {\n'
  printf '    "core": "%s",\n' "$CORE_CHECK"
  printf '    "tunnel_connections": "%s",\n' "$TUNNEL_CHECK"
  printf '    "cloudflare_access": "%s",\n' "$ACCESS_CHECK"
  printf '    "authenticated_origin": "%s",\n' "$ORIGIN_CHECK"
  printf '    "setup": "%s"\n' "$SETUP_CHECK"
  printf '  }\n'
  printf '}\n'
}

finish() {
  local code="$1"
  local status="${2:-failed}"
  json_result "$status"
  exit "$code"
}

cleanup() {
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
  if [[ "$KEEP_ACCESS_ENV" -eq 0 && -e "$ACCESS_ENV_FILE" ]]; then
    rm -f "$ACCESS_ENV_FILE"
  fi
}
trap cleanup EXIT HUP INT TERM

run_bounded() {
  local stdout_file="$1"
  shift
  local command_pid
  local timer_pid
  local result
  "$@" >"$stdout_file" 2>/dev/null &
  command_pid=$!
  (
    sleep 5
    kill -TERM "$command_pid" >/dev/null 2>&1 || true
  ) >/dev/null 2>&1 &
  timer_pid=$!
  wait "$command_pid"
  result=$?
  kill "$timer_pid" >/dev/null 2>&1 || true
  wait "$timer_pid" >/dev/null 2>&1 || true
  return "$result"
}

compose() {
  docker compose \
    --env-file "$ENV_FILE" \
    --env-file "$RELEASE_ENV_FILE" \
    -f "$COMPOSE_FILE" \
    --profile tunnel \
    "$@"
}

fetch_internal() {
  local path="$1"
  local destination="$2"
  run_bounded "$destination" \
    compose exec -T caddy wget -qO- -T 3 "http://127.0.0.1${path}"
}

public_request() {
  local status_file="$1"
  local output_file="$2"
  shift 2
  run_bounded "$status_file" \
    curl --silent --show-error \
      --connect-timeout 3 \
      --max-time 5 \
      --max-filesize 1048576 \
      --proto '=https' \
      --output "$output_file" \
      --write-out '%{http_code}' \
      "$@"
}

[[ -f "$ENV_FILE" && -f "$RELEASE_ENV_FILE" && -f "$COMPOSE_FILE" ]] ||
  finish 10 failed
command -v docker >/dev/null 2>&1 || finish 10 failed
command -v curl >/dev/null 2>&1 || finish 14 failed
command -v jq >/dev/null 2>&1 || finish 11 failed

VERSION="$(read_env_value QUOTEOPS_VERSION "$RELEASE_ENV_FILE")"
CLIENT_ID="$(read_env_value QUOTEOPS_CLIENT_ID "$ENV_FILE")"
INSTALLATION_ID="$(read_env_value QUOTEOPS_INSTALLATION_ID "$ENV_FILE")"
PUBLIC_HOSTNAME="${QUOTEOPS_PUBLIC_HOSTNAME:-$(read_env_value QUOTEOPS_PUBLIC_HOSTNAME "$ENV_FILE")}"
if [[ -f "$CLOUDFLARE_SETTINGS_FILE" && ! -L "$CLOUDFLARE_SETTINGS_FILE" ]]; then
  SETTINGS_HOSTNAME="$(jq -er '.public_hostname | strings' "$CLOUDFLARE_SETTINGS_FILE" 2>/dev/null || true)"
  if [[ -n "$SETTINGS_HOSTNAME" ]]; then
    PUBLIC_HOSTNAME="$SETTINGS_HOSTNAME"
  fi
fi
[[ "$VERSION" =~ ^v[0-9]+[.][0-9]+[.][0-9]+$ &&
   -n "$CLIENT_ID" &&
   -n "$INSTALLATION_ID" ]] || finish 10 failed
[[ "$PUBLIC_HOSTNAME" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] ||
  finish 14 failed

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/quoteops-verify.XXXXXX")" ||
  finish 10 failed
chmod 700 "$TMP_DIR"

RUNNING_SERVICES="$TMP_DIR/running-services"
if ! run_bounded "$RUNNING_SERVICES" compose ps --status running --services; then
  finish 10 failed
fi
for service in postgres redis quoteops-agent quoteops-api quoteops-web caddy; do
  grep -Fxq "$service" "$RUNNING_SERVICES" || finish 10 failed
done
CORE_CHECK="ok"

INTERNAL_HEALTH="$TMP_DIR/internal-health.json"
fetch_internal "/api/health" "$INTERNAL_HEALTH" ||
  finish 11 failed
jq -e '.ok == true' "$INTERNAL_HEALTH" >/dev/null 2>&1 ||
  finish 11 failed

METRICS="$TMP_DIR/cloudflared.metrics"
run_bounded "$METRICS" \
  compose exec -T caddy wget -qO- -T 3 "http://cloudflared:2000/metrics" ||
  finish 12 failed
TUNNEL_CONNECTIONS="$(
  awk '
    /^cloudflared_tunnel_ha_connections({[^}]*})?[[:space:]]+/ {
      value = $NF
      if (value !~ /^[0-9]+([.][0-9]+)?$/) {
        invalid = 1
      } else {
        sum += value
        found = 1
      }
    }
    END {
      if (!found || invalid) exit 1
      printf "%.12g", sum
    }
  ' "$METRICS" 2>/dev/null
)" || finish 13 failed
awk -v value="$TUNNEL_CONNECTIONS" 'BEGIN { exit !(value > 0) }' ||
  finish 13 failed
TUNNEL_CHECK="ok"

ANON_HEADERS="$TMP_DIR/anonymous.headers"
ANON_STATUS_FILE="$TMP_DIR/anonymous.status"
if ! public_request "$ANON_STATUS_FILE" /dev/null \
  --dump-header "$ANON_HEADERS" \
  "https://$PUBLIC_HOSTNAME/api/health"; then
  finish 14 failed
fi
ANON_STATUS="$(cat "$ANON_STATUS_FILE")"
[[ "$ANON_STATUS" =~ ^[0-9]{3}$ && "$ANON_STATUS" != "000" ]] ||
  finish 14 failed
CF_SERVER=0
CF_RAY=0
CF_LOGIN=0
grep -Eqi '^server:[[:space:]]*cloudflare[[:space:]]*$' "$ANON_HEADERS" && CF_SERVER=1
grep -Eqi '^cf-ray:[[:space:]]*[^[:space:]]+' "$ANON_HEADERS" && CF_RAY=1
grep -Eqi '^location:[[:space:]]*https://([A-Za-z0-9-]+[.])*cloudflareaccess[.]com/cdn-cgi/access/login/' "$ANON_HEADERS" && CF_LOGIN=1
case "$ANON_STATUS" in
  301|302|303|307|308)
    [[ "$CF_SERVER" -eq 1 && "$CF_RAY" -eq 1 && "$CF_LOGIN" -eq 1 ]] ||
      finish 15 failed
    ;;
  401|403)
    [[ "$CF_SERVER" -eq 1 && "$CF_RAY" -eq 1 ]] ||
      finish 15 failed
    ;;
  *)
    finish 15 failed
    ;;
esac
ACCESS_CHECK="ok"

RUNNING_VERSION="$(jq -er '.product_version | strings' "$INTERNAL_HEALTH" 2>/dev/null || true)"
[[ "$RUNNING_VERSION" == "$VERSION" ]] || finish 16 failed

INTERNAL_SETUP="$TMP_DIR/internal-setup.json"
fetch_internal "/api/setup-state" "$INTERNAL_SETUP" ||
  finish 17 pending
if ! jq -e '.required_steps | type == "array"' "$INTERNAL_SETUP" >/dev/null 2>&1; then
  finish 17 pending
fi
if [[ "$(jq '.required_steps | length' "$INTERNAL_SETUP" 2>/dev/null)" != "0" ]]; then
  SETUP_CHECK="pending"
  finish 17 pending
fi
SETUP_CHECK="ok"

receipt_matches() {
  [[ -f "$VALIDATION_RECEIPT_FILE" && ! -L "$VALIDATION_RECEIPT_FILE" ]] &&
    jq -e \
      --arg hostname "$PUBLIC_HOSTNAME" \
      --arg version "$VERSION" \
      --arg client "$CLIENT_ID" \
      --arg installation "$INSTALLATION_ID" \
      '.public_hostname == $hostname and
       .version == $version and
       .client_id == $client and
       .installation_id == $installation and
       .authenticated_origin == true' \
      "$VALIDATION_RECEIPT_FILE" >/dev/null 2>&1
}

if [[ -e "$ACCESS_ENV_FILE" || -L "$ACCESS_ENV_FILE" ]]; then
  if [[ ! -f "$ACCESS_ENV_FILE" ||
        -L "$ACCESS_ENV_FILE" ||
        "$(file_mode "$ACCESS_ENV_FILE")" != "600" ]] ||
     ! cloudflare_access_owner_is_valid; then
    KEEP_ACCESS_ENV=0
    finish 18 failed
  fi
fi

if receipt_matches; then
  ORIGIN_CHECK="ok"
  KEEP_ACCESS_ENV=0
  finish 0 ready
fi

if [[ ! -f "$ACCESS_ENV_FILE" ]]; then
  finish 18 failed
fi
ACCESS_CLIENT_ID="$(read_env_value CF_ACCESS_CLIENT_ID "$ACCESS_ENV_FILE")"
ACCESS_CLIENT_SECRET="$(read_env_value CF_ACCESS_CLIENT_SECRET "$ACCESS_ENV_FILE")"
[[ "$ACCESS_CLIENT_ID" =~ ^[A-Za-z0-9._~-]+$ &&
   "$ACCESS_CLIENT_SECRET" =~ ^[A-Za-z0-9._~-]+$ ]] ||
  finish 18 failed

CURL_CONFIG="$TMP_DIR/service-auth.curl"
{
  printf 'header = "CF-Access-Client-Id: %s"\n' "$ACCESS_CLIENT_ID"
  printf 'header = "CF-Access-Client-Secret: %s"\n' "$ACCESS_CLIENT_SECRET"
} >"$CURL_CONFIG"
chmod 600 "$CURL_CONFIG"

AUTH_HEALTH="$TMP_DIR/auth-health.json"
AUTH_HEALTH_STATUS_FILE="$TMP_DIR/auth-health.status"
if ! public_request "$AUTH_HEALTH_STATUS_FILE" "$AUTH_HEALTH" \
  --config "$CURL_CONFIG" \
  "https://$PUBLIC_HOSTNAME/api/health"; then
  finish 18 failed
fi
[[ "$(cat "$AUTH_HEALTH_STATUS_FILE")" == "200" ]] ||
  finish 18 failed
AUTH_VERSION="$(jq -er '.product_version | strings' "$AUTH_HEALTH" 2>/dev/null || true)"
[[ "$AUTH_VERSION" == "$VERSION" ]] || finish 18 failed

AUTH_SETUP="$TMP_DIR/auth-setup.json"
AUTH_SETUP_STATUS_FILE="$TMP_DIR/auth-setup.status"
if ! public_request "$AUTH_SETUP_STATUS_FILE" "$AUTH_SETUP" \
  --config "$CURL_CONFIG" \
  "https://$PUBLIC_HOSTNAME/api/setup-state"; then
  finish 18 failed
fi
[[ "$(cat "$AUTH_SETUP_STATUS_FILE")" == "200" ]] ||
  finish 18 failed
jq -e \
  --arg client "$CLIENT_ID" \
  --arg installation "$INSTALLATION_ID" \
  '.activation.client_id == $client and
   .activation.installation_id == $installation and
   (.required_steps | type == "array" and length == 0)' \
  "$AUTH_SETUP" >/dev/null 2>&1 ||
  finish 18 failed

RECEIPT_TMP="$QUOTEOPS_HOME/settings/.cloudflare-public-validation.json.tmp.$$"
{
  printf '{\n'
  printf '  "public_hostname": "%s",\n' "$PUBLIC_HOSTNAME"
  printf '  "version": "%s",\n' "$VERSION"
  printf '  "client_id": "%s",\n' "$CLIENT_ID"
  printf '  "installation_id": "%s",\n' "$INSTALLATION_ID"
  printf '  "authenticated_origin": true\n'
  printf '}\n'
} >"$RECEIPT_TMP" || finish 18 failed
chmod 600 "$RECEIPT_TMP"
mv "$RECEIPT_TMP" "$VALIDATION_RECEIPT_FILE" || finish 18 failed

rm -f "$CURL_CONFIG" "$ACCESS_ENV_FILE"
KEEP_ACCESS_ENV=0
ORIGIN_CHECK="ok"
finish 0 ready
