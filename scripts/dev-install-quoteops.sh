#!/usr/bin/env bash
# Dev local-install orchestrator for QuoteOps.
#
# Brings up a throwaway control plane (file store, no Postgres), packages a
# local appliance release from already-loaded images, issues an install pack,
# and invokes deploy/appliance/install.sh --no-pull into a bounded QUOTEOPS_HOME.
#
# What it proves: the full stack runs locally and onboarding can start.
# What it does NOT prove: real Cloudflare tunnel, real Ubuntu apt bootstrap,
# real public hostname. Use deploy/appliance/tests/macbook-acceptance.sh for that.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKTREE="${QUOTEOPS_DEV_REPO:-$REPO_ROOT}"
RELEASE_VERSION="${QUOTEOPS_DEV_VERSION:-v0.1.2}"
HTTP_PORT="${QUOTEOPS_DEV_HTTP_PORT:-8080}"
CLIENT_ID="${QUOTEOPS_DEV_CLIENT_ID:-DEV}"
LEGAL_NAME="${QUOTEOPS_DEV_LEGAL_NAME:-QuoteOps Dev}"
AUTHORIZED_EMAIL="${QUOTEOPS_DEV_EMAIL:-dev@quoteops.example}"
INSTALLATION_ID="${QUOTEOPS_DEV_INSTALLATION_ID:-dev-prod-001}"
SECRETS_DIR="${QUOTEOPS_DEV_SECRETS_DIR:-$HOME/.quoteops-secrets}"
KEEP="${KEEP:-0}"

usage() {
  cat <<USAGE
Usage: $(basename "$0") [options]

Options:
  --keep              Retain the temp root + Compose project after a failed run for debugging.
  --cleanup          Load the state file and tear down a previously retained run.
  --help, -h         Show this help.

Required environment (0600 files under \$QUOTEOPS_DEV_SECRETS_DIR, default ~/.quoteops-secrets):
  openrouter-key      OpenRouter API key (validates the AI-first onboarding step)
  resend-key          Resend API key (mailbox intake)
  sakbe-key           INEGI SAKBÉ key (routes)
  embedding-key       Gemini API key (embeddings, model text-embedding-004)

Optional environment overrides:
  QUOTEOPS_DEV_VERSION (v0.1.2)  QUOTEOPS_DEV_HTTP_PORT (8080)
  QUOTEOPS_DEV_CLIENT_ID (DEV)   QUOTEOPS_DEV_EMAIL (dev@quoteops.example)
  QUOTEOPS_DEV_INSTALLATION_ID   QUOTEOPS_DEV_REPO (worktree root)
USAGE
}

MODE="run"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP=1; shift;;
    --cleanup) MODE="cleanup"; shift;;
    -h|--help) usage; exit 0;;
    *) echo "unknown option: $1" >&2; usage; exit 2;;
  esac
done

STATE_FILE="${TMPDIR:-/tmp}/quoteops-dev-install-${UID}.json"

if [[ "$MODE" == "cleanup" ]]; then
  [[ -f "$STATE_FILE" ]] || { echo "no state file at $STATE_FILE (nothing to clean)"; exit 0; }
  STATE="$(cat "$STATE_FILE")"
  ROOT="$(printf '%s' "$STATE" | jq -r '.root')"
  PROJECT="$(printf '%s' "$STATE" | jq -r '.project')"
  CP_PID="$(printf '%s' "$STATE" | jq -r '.cp_pid // 0')"
  PG_CONTAINER="$(printf '%s' "$STATE" | jq -r '.pg_container // ""')"
  [[ "$ROOT" == "${TMPDIR:-/tmp}"/quoteops-dev.* ]] || { echo "refusing unsafe root: $ROOT"; exit 2; }
  [[ "$PROJECT" == quoteops_dev_* ]] || { echo "refusing unsafe project: $PROJECT"; exit 2; }
  echo "cleaning root=$ROOT project=$PROJECT"
  if [[ -n "$PG_CONTAINER" ]]; then docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true; fi
  if [[ "$CP_PID" != "0" ]] && kill -0 "$CP_PID" 2>/dev/null; then kill "$CP_PID" 2>/dev/null || true; fi
  if [[ -f "$ROOT/quoteops-v1/current/docker-compose.yml" ]]; then
    docker compose --project-name "$PROJECT" \
      --env-file "$ROOT/quoteops-v1/.env" \
      --env-file "$ROOT/quoteops-v1/current/release.env" \
      -f "$ROOT/quoteops-v1/current/docker-compose.yml" \
      down --volumes --remove-orphans 2>/dev/null || true
  fi
  rm -rf "$ROOT"
  rm -f "$STATE_FILE"
  echo "cleanup done"
  exit 0
fi

# --- preflight ---
die() { echo "error: $*" >&2; exit 1; }
require_secret() {
  local name="$1"
  local path="$SECRETS_DIR/$name"
  [[ -f "$path" ]] || die "missing secret file: $path (see --help)"
  [[ "$(stat -f '%Lp' "$path" 2>/dev/null || stat -c '%a' "$path" 2>/dev/null)" == "600" ]] || \
    die "secret file must be mode 0600: $path"
  [[ -s "$path" ]] || die "secret file is empty: $path"
}
require_secret openrouter-key
require_secret resend-key
require_secret sakbe-key
require_secret embedding-key

command -v jq >/dev/null || die "jq is required"
command -v docker >/dev/null || die "docker is required"
docker info >/dev/null 2>&1 || die "docker daemon is not running"
DC_VER="$(docker compose version --short 2>/dev/null | sed 's/^v//')"
[[ -n "$DC_VER" ]] || die "docker compose v2 is required"

# --- bounded root ---
E2E_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/quoteops-dev.XXXXXX")"
QUOTEOPS_HOME="$E2E_ROOT/quoteops-v1"
COMPOSE_PROJECT_NAME="quoteops_dev_$(date +%s)"
[[ "$E2E_ROOT" == "${TMPDIR:-/tmp}"/quoteops-dev.* ]] || die "unsafe root: $E2E_ROOT"

cleanup() {
  local code=$?
  if [[ "$KEEP" == "1" && $code -ne 0 ]]; then
    cat > "$STATE_FILE" <<JSON
{"root":"$E2E_ROOT","project":"$COMPOSE_PROJECT_NAME","cp_pid":"${CP_PID:-0}","created_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
JSON
    chmod 600 "$STATE_FILE"
    echo "retained for debugging: root=$E2E_ROOT project=$COMPOSE_PROJECT_NAME" >&2
    echo "to clean: bash $0 --cleanup" >&2
    return
  fi
  [[ -n "${CP_PID:-}" ]] && kill "$CP_PID" 2>/dev/null || true
  if [[ -f "$QUOTEOPS_HOME/current/docker-compose.yml" ]]; then
    docker compose --project-name "$COMPOSE_PROJECT_NAME" \
      --env-file "$QUOTEOPS_HOME/.env" \
      --env-file "$QUOTEOPS_HOME/current/release.env" \
      -f "$QUOTEOPS_HOME/current/docker-compose.yml" \
      down --volumes --remove-orphans 2>/dev/null || true
  fi
  rm -rf "$E2E_ROOT"
  rm -f "$STATE_FILE"
}
trap cleanup EXIT

# --- ensure images loaded (side-load v0.1.2 tarballs if missing) ---
ensure_image() {
  local ref="$1"
  docker image inspect "$ref" >/dev/null 2>&1
}
APP_IMAGES=(
  "ghcr.io/alejandroc-bit/quote-ops-api:$RELEASE_VERSION"
  "ghcr.io/alejandroc-bit/quote-ops-agent:$RELEASE_VERSION"
  "ghcr.io/alejandroc-bit/quote-ops-web:$RELEASE_VERSION"
)
missing=0
for img in "${APP_IMAGES[@]}"; do ensure_image "$img" || missing=1; done
if [[ "$missing" == "1" ]] && [[ "$RELEASE_VERSION" == "v0.1.2" ]]; then
  echo "loading side-load v0.1.2 image tarballs from GitHub release..."
  for img in agent api web; do
    curl -fsSL -o "$E2E_ROOT/$img.tar.gz" \
      "https://github.com/alejandroc-bit/quote_ops_v1/releases/download/v0.1.2/$img.tar.gz"
    docker load -i "$E2E_ROOT/$img.tar.gz" >/dev/null
    loaded="$(docker images --format '{{.Repository}}:{{.Tag}}' | grep "^quote-ops-$img:v012-amd64$" | head -1)"
    docker tag "$loaded" "ghcr.io/alejandroc-bit/quote-ops-$img:$RELEASE_VERSION"
    rm -f "$E2E_ROOT/$img.tar.gz"
  done
elif [[ "$missing" == "1" ]]; then
  die "images for $RELEASE_VERSION not found locally; load them first or use v0.1.2"
fi
for base in postgres:16-alpine redis:7-alpine caddy:2-alpine; do
  ensure_image "$base" || docker pull "$base" >/dev/null
done

# --- throwaway control plane (file store) ---
echo "starting throwaway control plane..."
CP_DATA="$E2E_ROOT/cp-data"
mkdir -p "$CP_DATA"
SYNC_TOKEN="$(openssl rand -hex 24)"
printf '%s' "$SYNC_TOKEN" > "$E2E_ROOT/sync-token"; chmod 600 "$E2E_ROOT/sync-token"

# stage the appliance bundle the CP will serve
STAGING_ASSETS="$E2E_ROOT/assets"
mkdir -p "$STAGING_ASSETS"
for f in docker-compose.yml Caddyfile install.sh quoteops.sh verify-install.sh \
         upgrade.sh backup.sh restore.sh secrets.sh bootstrap.sh; do
  cp "$WORKTREE/deploy/appliance/$f" "$STAGING_ASSETS/$f"
done

export QUOTEOPS_CONTROL_PLANE_STORE_PATH="$CP_DATA/store.json"
export QUOTEOPS_APPLIANCE_RELEASE_VERSION="$RELEASE_VERSION"
export QUOTEOPS_RELEASE_SYNC_TOKEN="$SYNC_TOKEN"
export QUOTEOPS_CONTROL_PLANE_URL="http://127.0.0.1:19083"
export QUOTEOPS_ALLOW_LOCAL_ORIGIN=1
cp_url() { printf 'http://127.0.0.1:19083'; }

( cd "$WORKTREE" && npm run dev:control-plane-api >"$E2E_ROOT/cp.log" 2>&1 ) &
CP_PID=$!
for _ in {1..30}; do
  curl -fsS http://127.0.0.1:19083/api/health >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS http://127.0.0.1:19083/api/health >/dev/null || die "control plane did not start (see $E2E_ROOT/cp.log)"

# inspect image digests and package the release bundle
inspect_digest() {
  local ref="$1"
  docker image inspect "$ref" --format '{{index .RepoDigests 0}}' 2>/dev/null | sed 's/.*@//'
}
API_DIGEST="$(inspect_digest "${APP_IMAGES[0]}")"
AGENT_DIGEST="$(inspect_digest "${APP_IMAGES[1]}")"
WEB_DIGEST="$(inspect_digest "${APP_IMAGES[2]}")"
PG_DIGEST="$(inspect_digest postgres:16-alpine | sed 's/.*@//')"
RD_DIGEST="$(inspect_digest redis:7-alpine | sed 's/.*@//')"
CD_DIGEST="$(inspect_digest caddy:2-alpine | sed 's/.*@//')"
CF_DIGEST="$(docker image inspect cloudflare/cloudflared:2024.12.1 --format '{{index .RepoDigests 0}}' 2>/dev/null | sed 's/.*@//' || true)"
[[ -n "$CF_DIGEST" ]] || { docker pull cloudflare/cloudflared:2024.12.1 >/dev/null 2>&1; CF_DIGEST="$(docker image inspect cloudflare/cloudflared:2024.12.1 --format '{{index .RepoDigests 0}}' | sed 's/.*@//')"; }

BUNDLE_DIR="$WORKTREE/dist/appliance/$RELEASE_VERSION"
mkdir -p "$BUNDLE_DIR"
rm -f "$BUNDLE_DIR"/*
( cd "$WORKTREE" && SOURCE_DATE_EPOCH="$(git show -s --format=%ct HEAD)" npm run package:appliance -- \
  --version "$RELEASE_VERSION" \
  --git-sha "$(git -C "$WORKTREE" rev-parse HEAD)" \
  --assets-dir "$STAGING_ASSETS" \
  --agent-digest "$AGENT_DIGEST" \
  --api-digest "$API_DIGEST" \
  --web-digest "$WEB_DIGEST" \
  --postgres-image "docker.io/library/postgres@$PG_DIGEST" \
  --redis-image "docker.io/library/redis@$RD_DIGEST" \
  --caddy-image "docker.io/library/caddy@$CD_DIGEST" \
  --cloudflared-image "docker.io/cloudflare/cloudflared@$CF_DIGEST" \
  --output-dir "$BUNDLE_DIR" ) >/dev/null

# register the release
curl -fsS -X POST http://127.0.0.1:19083/api/internal/releases/sync-bundled \
  -H "authorization: Bearer $SYNC_TOKEN" >/dev/null \
  || die "sync-bundled failed (see $E2E_ROOT/cp.log)"

# create client + issue install pack
( cd "$WORKTREE" && \
  npm run admin -- create-client "$CLIENT_ID" "$LEGAL_NAME" "$AUTHORIZED_EMAIL" >/dev/null 2>&1 )
REGISTRATION_TOKEN="$( cd "$WORKTREE" && \
  QUOTEOPS_ALLOW_LOCAL_ORIGIN=1 \
  npm run admin -- install-pack "$CLIENT_ID" --url http://127.0.0.1:19083 2>/dev/null \
  | grep '^Registration token:' | sed 's/Registration token: //')"
[[ -n "$REGISTRATION_TOKEN" ]] || die "install-pack failed (see $E2E_ROOT/cp.log)"
TOKEN_FILE="$E2E_ROOT/registration-token"
printf '%s' "$REGISTRATION_TOKEN" > "$TOKEN_FILE"; chmod 600 "$TOKEN_FILE"

# build a minimal client manifest for install.sh
MANIFEST_FILE="$E2E_ROOT/client-manifest.yaml"
cat > "$MANIFEST_FILE" <<YAML
client_id: $CLIENT_ID
legal_name: "$LEGAL_NAME"
installation_id: $INSTALLATION_ID
business_units:
  - business_unit_id: general
    requester_email_domains: []
    keywords: []
    default: true
vehicle_profiles:
  - vehicle_profile_id: T3S3_53_DRYVAN
    business_unit_id: general
    keywords: []
YAML

# stage secrets into client.env (file references, not values — install.sh reads them)
SECRETS_ENV="$QUOTEOPS_HOME/secrets/client.env"
mkdir -p "$QUOTEOPS_HOME/secrets"
cat > "$SECRETS_ENV" <<ENV
OPENROUTER_API_KEY=$(cat "$SECRETS_DIR/openrouter-key")
RESEND_API_KEY=$(cat "$SECRETS_DIR/resend-key")
SAKBE_API_KEY=$(cat "$SECRETS_DIR/sakbe-key")
GEMINI_API_KEY=$(cat "$SECRETS_DIR/embedding-key")
QUOTEOPS_EMBEDDING_API_KEY=$(cat "$SECRETS_DIR/embedding-key")
ENV
chmod 600 "$SECRETS_ENV"

# invoke the real installer
echo "running install.sh --no-pull into $QUOTEOPS_HOME ..."
bash "$WORKTREE/deploy/appliance/install.sh" \
  --home "$QUOTEOPS_HOME" \
  --client "$CLIENT_ID" \
  --manifest "$MANIFEST_FILE" \
  --compose-file "$WORKTREE/deploy/appliance/docker-compose.yml" \
  --control-plane-url "http://127.0.0.1:19083" \
  --registration-token-file "$TOKEN_FILE" \
  --installation-id "$INSTALLATION_ID" \
  --image-registry "ghcr.io/alejandroc-bit" \
  --site-address ":$HTTP_PORT" \
  --http-port "$HTTP_PORT" \
  --postgres-db quoteops \
  --postgres-user quoteops \
  --postgres-password "dev-local-$(openssl rand -hex 8)" \
  --no-pull \
  --force

# expose the loopback Caddy port via the direct compose overlay
echo ""
echo "=== QuoteOps dev install ready ==="
echo "web_url=http://127.0.0.1:$HTTP_PORT"
echo "api_health=http://127.0.0.1:$HTTP_PORT/api/health"
echo "control_plane=http://127.0.0.1:19083"
echo "quoteops_home=$QUOTEOPS_HOME"
echo "resume: docker compose --project-name $COMPOSE_PROJECT_NAME -f $QUOTEOPS_HOME/current/docker-compose.yml --env-file $QUOTEOPS_HOME/.env --env-file $QUOTEOPS_HOME/current/release.env up -d"
echo "cleanup: bash $0 --cleanup"
