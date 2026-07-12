#!/usr/bin/env bash
set -euo pipefail

QUOTEOPS_HOME="${QUOTEOPS_HOME:-/opt/quoteops-v1}"
SECRETS_ENV_FILE="${QUOTEOPS_SECRETS_ENV_FILE:-$QUOTEOPS_HOME/secrets/client.env}"
SECRETS_ENV_FILE_SET=0

usage() {
  cat <<USAGE
Usage: $(basename "$0") [options] <command>

Commands:
  set KEY VALUE        Set or replace a secret value
  set KEY --stdin     Read the secret value from stdin
  unset KEY           Remove a secret value
  list                List configured secret keys without values

Options:
  --home PATH              Appliance data root (default: /opt/quoteops-v1)
  --secrets-env-file PATH  Client secrets env file (default: <home>/secrets/client.env)
  -h, --help               Show this help
USAGE
}

die() {
  echo "secrets.sh: $*" >&2
  exit 1
}

require_value() {
  local flag="$1"
  local value="${2:-}"
  [[ -n "$value" && "$value" != --* ]] || die "$flag requires a value"
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
  [[ "$value" != *$'\n'* ]] || die "secret values cannot contain newlines"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//\$/\\$}"
  value="${value//\`/\\\`}"
  printf '"%s"' "$value"
}

validate_key() {
  local key="$1"
  [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || die "secret key must look like INEGI_SAKBE_KEY"
}

ensure_secret_file() {
  SECRETS_ENV_FILE="$(absolute_new_path "$SECRETS_ENV_FILE")"
  mkdir -p "$(dirname "$SECRETS_ENV_FILE")"
  chmod 700 "$(dirname "$SECRETS_ENV_FILE")"
  if [[ ! -f "$SECRETS_ENV_FILE" ]]; then
    : > "$SECRETS_ENV_FILE"
  fi
  chmod 600 "$SECRETS_ENV_FILE"
}

set_secret() {
  local key="$1"
  local value="$2"
  local tmp="$SECRETS_ENV_FILE.tmp.$$"
  validate_key "$key"
  awk -v key="$key" -F= '$1 != key { print }' "$SECRETS_ENV_FILE" > "$tmp"
  printf "%s=%s\n" "$key" "$(env_escape "$value")" >> "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$SECRETS_ENV_FILE"
}

unset_secret() {
  local key="$1"
  local tmp="$SECRETS_ENV_FILE.tmp.$$"
  validate_key "$key"
  awk -v key="$key" -F= '$1 != key { print }' "$SECRETS_ENV_FILE" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$SECRETS_ENV_FILE"
}

list_secrets() {
  awk -F= '/^[A-Z_][A-Z0-9_]*=/ { print $1"=set" }' "$SECRETS_ENV_FILE" | sort
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --home)
      require_value "$1" "${2:-}"
      QUOTEOPS_HOME="$2"
      if [[ "$SECRETS_ENV_FILE_SET" -eq 0 ]]; then
        SECRETS_ENV_FILE="$QUOTEOPS_HOME/secrets/client.env"
      fi
      shift 2
      ;;
    --secrets-env-file)
      require_value "$1" "${2:-}"
      SECRETS_ENV_FILE="$2"
      SECRETS_ENV_FILE_SET=1
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    set|unset|list)
      break
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

COMMAND="${1:-}"
[[ -n "$COMMAND" ]] || die "command is required"
shift || true

ensure_secret_file

case "$COMMAND" in
  set)
    KEY="${1:-}"
    VALUE="${2:-}"
    [[ -n "$KEY" ]] || die "set requires KEY"
    if [[ "$VALUE" == "--stdin" ]]; then
      IFS= read -r VALUE
    else
      [[ -n "$VALUE" ]] || die "set requires VALUE or --stdin"
    fi
    set_secret "$KEY" "$VALUE"
    echo "$KEY=set"
    ;;
  unset)
    KEY="${1:-}"
    [[ -n "$KEY" ]] || die "unset requires KEY"
    unset_secret "$KEY"
    echo "$KEY=unset"
    ;;
  list)
    list_secrets
    ;;
  *)
    die "unknown command: $COMMAND"
    ;;
esac
