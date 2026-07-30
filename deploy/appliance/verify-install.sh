#!/usr/bin/env bash
set -u

MODE="${1:---summary}"
case "$MODE" in
  --summary|--verbose) ;;
  *) printf 'Usage: %s --summary|--verbose\n' "$(basename "$0")" >&2; exit 2 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
QUOTEOPS_HOME="${QUOTEOPS_HOME:-/opt/quoteops-v1}"
ERRORS=0

ok() {
  [[ "$MODE" == "--verbose" ]] && printf 'ok: %s\n' "$1"
}

bad() {
  printf 'error: %s\n' "$1" >&2
  ERRORS=$((ERRORS + 1))
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

read_safe_env_value() {
  local key="$1"
  local file="$2"
  sed -n "s/^${key}=//p" "$file" | head -1 | sed 's/^"//; s/"$//'
}

if [[ ! -d "$QUOTEOPS_HOME" || -L "$QUOTEOPS_HOME" ]]; then
  bad "QUOTEOPS_HOME is missing or is a symlink"
else
  QUOTEOPS_HOME="$(cd "$QUOTEOPS_HOME" && pwd -P)"
  ok "physical QUOTEOPS_HOME"
fi

CURRENT_TARGET=""
if [[ -L "$QUOTEOPS_HOME/current" ]]; then
  CURRENT_TARGET="$(readlink "$QUOTEOPS_HOME/current")"
  case "$CURRENT_TARGET" in
    "$QUOTEOPS_HOME"/releases/v[0-9]*.[0-9]*.[0-9]*) ok "current release link" ;;
    *) bad "current release target is outside releases" ;;
  esac
else
  bad "current release link is missing"
fi

for asset in docker-compose.yml Caddyfile install.sh quoteops.sh verify-install.sh upgrade.sh backup.sh restore.sh secrets.sh release.env; do
  if [[ -f "$SCRIPT_DIR/$asset" && ! -L "$SCRIPT_DIR/$asset" ]]; then
    ok "runtime asset $asset"
  else
    bad "runtime asset missing or unsafe: $asset"
  fi
done

if [[ -f "$QUOTEOPS_HOME/.env" ]]; then
  if grep -Eq '(^|_)(PASSWORD|TOKEN|SECRET|API_KEY)=' "$QUOTEOPS_HOME/.env"; then
    bad "shared env contains secret-like keys"
  else
    ok "shared env contains safe settings only"
  fi
else
  bad "shared env is missing"
fi

for secret_file in "$QUOTEOPS_HOME/secrets/client.env" "$QUOTEOPS_HOME/secrets/cloudflare.env"; do
  if [[ ! -f "$secret_file" || -L "$secret_file" ]]; then
    bad "secret file missing or unsafe: $secret_file"
  elif [[ "$(file_mode "$secret_file")" != "600" ]]; then
    bad "secret file mode is not 0600: $secret_file"
  elif [[ "$(file_owner_id "$secret_file")" != "$(id -u)" ]]; then
    bad "secret file owner is invalid: $secret_file"
  else
    ok "protected secret file $(basename "$secret_file")"
  fi
done

VERSION=""
if [[ -f "$SCRIPT_DIR/release.env" ]]; then
  VERSION="$(read_safe_env_value QUOTEOPS_VERSION "$SCRIPT_DIR/release.env")"
fi
INSTALL_MODE=""
if [[ -f "$QUOTEOPS_HOME/.env" ]]; then
  INSTALL_MODE="$(read_safe_env_value QUOTEOPS_INSTALL_MODE "$QUOTEOPS_HOME/.env")"
fi

if command -v docker >/dev/null 2>&1 &&
   docker compose version >/dev/null 2>&1 &&
   docker info >/dev/null 2>&1; then
  ok "Docker daemon and Compose"
  DOCKER_STATUS="ready"
else
  bad "Docker daemon or Compose is unavailable"
  DOCKER_STATUS="unavailable"
fi

if [[ "$ERRORS" -eq 0 ]]; then
  printf 'status=ok\nversion=%s\ninstall_mode=%s\ndocker=%s\n' \
    "$VERSION" "$INSTALL_MODE" "$DOCKER_STATUS"
  exit 0
fi
printf 'status=error\nversion=%s\ninstall_mode=%s\ndocker=%s\nerrors=%s\n' \
  "$VERSION" "$INSTALL_MODE" "$DOCKER_STATUS" "$ERRORS"
exit 1
