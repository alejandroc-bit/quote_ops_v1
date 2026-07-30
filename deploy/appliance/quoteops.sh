#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf 'quoteops: %s\n' "$1" >&2
  exit 1
}

version_at_least() {
  local actual="$1"
  local required="$2"
  [[ "$(printf '%s\n%s\n' "$required" "$actual" | sort -V | head -1)" == "$required" ]]
}

require_compose_224() {
  local version
  command -v docker >/dev/null 2>&1 || fail "Docker is required"
  version="$(docker compose version --short 2>/dev/null | sed 's/^v//')" ||
    fail "Docker Compose is required"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] ||
    fail "cannot determine Docker Compose version"
  version_at_least "${BASH_REMATCH[0]}" "2.24.0" ||
    fail "Docker Compose 2.24.0 or newer is required"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
QUOTEOPS_HOME="${QUOTEOPS_HOME:-/opt/quoteops-v1}"
[[ -d "$QUOTEOPS_HOME" && ! -L "$QUOTEOPS_HOME" ]] ||
  fail "QUOTEOPS_HOME must be a physical directory"
QUOTEOPS_HOME="$(cd "$QUOTEOPS_HOME" && pwd -P)"
[[ "$QUOTEOPS_HOME" != "/" ]] || fail "QUOTEOPS_HOME cannot be /"
if [[ -n "${HOME:-}" && -d "$HOME" ]]; then
  PHYSICAL_USER_HOME="$(cd "$HOME" && pwd -P)"
  [[ "$QUOTEOPS_HOME" != "$PHYSICAL_USER_HOME" ]] ||
    fail "QUOTEOPS_HOME cannot be a home directory"
fi
case "$SCRIPT_DIR" in
  "$QUOTEOPS_HOME"/releases/v[0-9]*.[0-9]*.[0-9]*) ;;
  *) fail "release-local command escaped QUOTEOPS_HOME" ;;
esac
[[ -L "$QUOTEOPS_HOME/current" ]] || fail "current release link is missing"
[[ "$(cd "$QUOTEOPS_HOME/current" && pwd -P)" == "$SCRIPT_DIR" ]] ||
  fail "release-local command is not the active release"

case "${1:-}" in
  status)   exec "$SCRIPT_DIR/verify-install.sh" --summary ;;
  doctor)   exec "$SCRIPT_DIR/verify-install.sh" --verbose ;;
  onboard)  shift; require_compose_224
            exec docker compose --env-file "$QUOTEOPS_HOME/.env" \
              --env-file "$QUOTEOPS_HOME/current/release.env" \
              -f "$QUOTEOPS_HOME/current/docker-compose.yml" \
              --profile onboarding run --rm quoteops-onboard "$@" ;;
  update)   shift; exec "$SCRIPT_DIR/upgrade.sh" "$@" ;;
  rollback) shift; exec "$SCRIPT_DIR/upgrade.sh" --rollback "$@" ;;
  backup)   shift; exec "$SCRIPT_DIR/backup.sh" \
              --output "$QUOTEOPS_HOME/backups" "$@" ;;
  restore)  shift
            if [[ $# -eq 1 && "$1" != --* ]]; then set -- --backup "$1"; fi
            exec "$SCRIPT_DIR/restore.sh" "$@" ;;
  logs)     shift; require_compose_224
            exec docker compose --env-file "$QUOTEOPS_HOME/.env" \
              --env-file "$QUOTEOPS_HOME/current/release.env" \
              -f "$QUOTEOPS_HOME/current/docker-compose.yml" logs "$@" ;;
  *) echo "Usage: quoteops status|doctor|onboard|update|rollback|backup|restore|logs" >&2; exit 2 ;;
esac
