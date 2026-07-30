#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

CONTROL_PLANE_URL="${QUOTEOPS_CONTROL_PLANE_URL:-__QUOTEOPS_CONTROL_PLANE_URL__}"
INSTALLER_FILE="$(mktemp "${TMPDIR:-/tmp}/quoteops-installer.XXXXXX")"
CURL_CONFIG_FILE="$(mktemp "${TMPDIR:-/tmp}/quoteops-curl.XXXXXX")"
TOKEN_FILE="$(mktemp "${TMPDIR:-/tmp}/quoteops-token.XXXXXX")"
cleanup() { rm -f "$INSTALLER_FILE" "$CURL_CONFIG_FILE" "$TOKEN_FILE"; }
trap cleanup EXIT

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

file_owner_id() {
  if stat -f '%u' "$1" >/dev/null 2>&1; then
    stat -f '%u' "$1"
  else
    stat -c '%u' "$1"
  fi
}

file_mode() {
  local mode
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then
    mode="$(stat -f '%Lp' "$1")"
  else
    mode="$(stat -c '%a' "$1")"
  fi
  printf '%s\n' "$mode"
}

validate_secret_file() {
  local path="$1"
  [[ -f "$path" && ! -L "$path" ]] || fail "registration token file must be a regular non-symlink file"
  [[ "$(file_owner_id "$path")" == "$(id -u)" ]] || fail "registration token file must be owned by the current user"
  [[ "$(file_mode "$path")" == "600" ]] || fail "registration token file must have mode 0600"
}

physical_new_path() {
  local path="$1"
  local parent
  parent="$(dirname "$path")"
  [[ -d "$parent" ]] || fail "parent directory does not exist: $parent"
  printf '%s/%s\n' "$(cd "$parent" && pwd -P)" "$(basename "$path")"
}

reject_symlinks_below_temp() {
  local logical_tmp="${1%/}"
  local physical_tmp="${2%/}"
  local candidate="$3"
  local relative
  local component
  local cursor="$physical_tmp"

  case "$candidate" in
    "$logical_tmp"/*) relative="${candidate#"$logical_tmp"/}" ;;
    *) fail "macbook test mode requires a bounded temporary QUOTEOPS_HOME" ;;
  esac
  IFS='/' read -r -a components <<<"$relative"
  for component in "${components[@]}"; do
    [[ -n "$component" && "$component" != "." && "$component" != ".." ]] ||
      fail "macbook test mode requires a bounded temporary QUOTEOPS_HOME"
    cursor="$cursor/$component"
    [[ ! -L "$cursor" ]] || fail "macbook test mode rejects symlinks below the temporary root"
  done
}

validate_macbook_test_root() {
  local logical_tmp="${TMPDIR:-/tmp}"
  local physical_tmp
  local physical_home
  logical_tmp="${logical_tmp%/}"
  physical_tmp="$(cd "$logical_tmp" && pwd -P)"
  [[ -n "${QUOTEOPS_HOME:-}" ]] ||
    fail "macbook test mode requires a bounded temporary QUOTEOPS_HOME"
  physical_home="$(physical_new_path "$QUOTEOPS_HOME")"
  case "$physical_home" in
    "$physical_tmp"/quoteops-mac-e2e.*/quoteops-v1) ;;
    *) fail "macbook test mode requires a bounded temporary QUOTEOPS_HOME" ;;
  esac
  reject_symlinks_below_temp "$logical_tmp" "$physical_tmp" "$QUOTEOPS_HOME"
}

install_host_dependencies() {
  [[ "$(id -u)" == "0" ]] || fail "run the Ubuntu bootstrap as root"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates curl gnupg jq
}

install_docker_if_missing() {
  if ! command -v docker >/dev/null 2>&1; then
    [[ "${QUOTEOPS_BOOTSTRAP_TEST_MODE:-}" != "macbook" ]] ||
      fail "Docker is required in macbook test mode"
    install -m 0755 -d /etc/apt/keyrings
    curl --fail --silent --show-error --location \
      --proto "=https" --proto-redir "=https" --tlsv1.2 \
      https://download.docker.com/linux/ubuntu/gpg \
      --output /etc/apt/keyrings/docker.asc
    chmod 0644 /etc/apt/keyrings/docker.asc
    . /etc/os-release
    printf '%s\n' \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
  docker info >/dev/null 2>&1 || fail "a working Docker daemon is required"
  docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"
}

case "$CONTROL_PLANE_URL" in
  https://*) ;;
  *) fail "canonical HTTPS control-plane origin is required" ;;
esac
case "${CONTROL_PLANE_URL#https://}" in
  ""|*/*|*@*|*\?*|*\#*|*" "*|*$'\t'*|*$'\n'*)
    fail "canonical HTTPS control-plane origin is required"
    ;;
esac

if [[ "${QUOTEOPS_BOOTSTRAP_TEST_MODE:-}" == "macbook" ]]; then
  [[ "$(uname -s)" == "Darwin" ]] ||
    fail "macbook test mode requires Darwin"
  validate_macbook_test_root
else
  [[ -z "${QUOTEOPS_BOOTSTRAP_TEST_MODE:-}" ]] ||
    fail "unknown bootstrap test mode"
  [[ -r /etc/os-release ]] || fail "Ubuntu 24.04 is required"
  . /etc/os-release
  [[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "24.04" ]] ||
    fail "Ubuntu 24.04 is required"
  [[ "$(uname -m)" == "x86_64" ]] || fail "linux/amd64 is required"
  install_host_dependencies
fi

if [[ -n "${QUOTEOPS_REGISTRATION_TOKEN_FILE:-}" ]]; then
  [[ "${QUOTEOPS_BOOTSTRAP_TEST_MODE:-}" == "macbook" &&
     -n "${QUOTEOPS_AUTOMATION_MODE:-}" ]] ||
    fail "registration token files are accepted only in bounded acceptance automation"
  validate_secret_file "$QUOTEOPS_REGISTRATION_TOKEN_FILE"
  QUOTEOPS_REGISTRATION_TOKEN="$(<"$QUOTEOPS_REGISTRATION_TOKEN_FILE")"
else
  exec 3</dev/tty
  read -r -s -p "Registration token: " QUOTEOPS_REGISTRATION_TOKEN <&3
  printf "\n" >&2
fi
[[ "${#QUOTEOPS_REGISTRATION_TOKEN}" -ge 32 &&
   "${#QUOTEOPS_REGISTRATION_TOKEN}" -le 512 &&
   ! "$QUOTEOPS_REGISTRATION_TOKEN" =~ [^A-Za-z0-9._~-] ]] ||
  fail "Registration token is required"
printf '%s' "$QUOTEOPS_REGISTRATION_TOKEN" >"$TOKEN_FILE"
printf 'header = "Authorization: Bearer %s"\n' \
  "$QUOTEOPS_REGISTRATION_TOKEN" >"$CURL_CONFIG_FILE"
chmod 600 "$TOKEN_FILE" "$CURL_CONFIG_FILE"
unset QUOTEOPS_REGISTRATION_TOKEN

install_docker_if_missing

curl --fail --silent --show-error --location \
  --proto "=https" --proto-redir "=https" --tlsv1.2 \
  --config "$CURL_CONFIG_FILE" \
  --output "$INSTALLER_FILE" \
  "$CONTROL_PLANE_URL/api/install"
chmod 700 "$INSTALLER_FILE"

export QUOTEOPS_REGISTRATION_TOKEN_FILE="$TOKEN_FILE"
if [[ -n "${QUOTEOPS_AUTOMATION_MODE:-}" ]]; then
  bash "$INSTALLER_FILE" "$@" </dev/null
else
  bash "$INSTALLER_FILE" "$@" </dev/tty
fi
