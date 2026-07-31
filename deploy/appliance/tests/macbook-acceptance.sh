#!/usr/bin/env bash
# MacBook acceptance harness for the QuoteOps appliance.
#
# Exercises the real customer installation path against a staging control
# plane: fetches the canonical bootstrap, runs the release-pinned installer
# with a bounded Mac acceptance root, drives the AI-first onboarding probe
# through the public Cloudflare-tunnelled origin, asserts the complete public
# workflow, restart-persistence, mock-TMS writeback idempotency, and writes a
# redacted evidence bundle. No secret value is ever printed or persisted; only
# the canonical safe lines are emitted on stdout.
#
# This is the live Mac journey (real Docker, real staging control plane, real
# AI key, real Cloudflare tunnel). It is intentionally separate from the
# disposable Ubuntu 24.04 bootstrap gate (ubuntu-vm-bootstrap-acceptance.sh),
# because Mac test mode skips Ubuntu detection and apt.
set -Eeuo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd -P)"
FIXTURE_DIR="$REPO_ROOT/deploy/appliance/tests/fixtures"

die() { printf 'macbook-acceptance: %s\n' "$*" >&2; exit 1; }

file_mode() {
  local mode
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then mode="$(stat -f '%Lp' "$1")"
  else mode="$(stat -c '%a' "$1")"; fi
  printf '%s\n' "$mode"
}

file_owner_id() {
  if stat -f '%u' "$1" >/dev/null 2>&1; then stat -f '%u' "$1"
  else stat -c '%u' "$1"; fi
}

usage() {
  cat <<USAGE
Usage: $(basename "$0") [options]

Options:
  --keep        Retain the bounded temp root + Compose project after a FAILED
                run for debugging (warns that local client.env still holds
                test credentials).
  --cleanup     Load the deterministic state file and tear down a previously
                retained run. Non-destructive on missing/invalid state.
  -h, --help    Show this help.

Required environment (see docs/runbooks/customer-vm-install.md):
  E2E_CONTROL_PLANE_URL            HTTPS staging control-plane origin
  E2E_EXPECTED_CLIENT_ID           production client-ID (schema-validated)
  E2E_EXPECTED_INSTALLATION_ID     installation-ID (schema-validated)
  E2E_REGISTRATION_TOKEN_FILE      0600 single-use registration token
  E2E_AI_PROVIDER                  openrouter | gemini
  E2E_AI_KEY_FILE                  0600 AI provider key
  E2E_TUNNEL_TOKEN_FILE            0600 Cloudflare named-tunnel token
  E2E_CF_ACCESS_CLIENT_ID_FILE     0600 Access service-token client id
  E2E_CF_ACCESS_CLIENT_SECRET_FILE 0600 Access service-token client secret
  E2E_RESEND_API_KEY_FILE          0600 Resend API key
  E2E_SAKBE_KEY_FILE               0600 INEGI SAKBÉ key
  E2E_EMBEDDING_PROVIDER           gemini | openai_compatible
  E2E_EMBEDDING_MODEL              non-empty model id
  E2E_EMBEDDING_KEY_FILE           0600 embeddings key
  E2E_EMBEDDING_BASE_URL           HTTPS base URL (openai_compatible only)
  E2E_PUBLIC_HOSTNAME              hostname without scheme/path
  E2E_AUTHORIZED_EMAIL             authorized activation email
  E2E_RESEND_INTAKE_ADDRESS        valid mailbox intake email
  E2E_RESEND_FROM_ADDRESS          valid mailbox from email
USAGE
}

# ---------------------------------------------------------------------------
# Mode parsing
# ---------------------------------------------------------------------------
MODE="run"
KEEP=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP=1; shift;;
    --cleanup) MODE="cleanup"; shift;;
    -h|--help) usage; exit 0;;
    *) die "unknown option: $1";;
  esac
done

E2E_STATE_FILE="${TMPDIR:-/tmp}/quoteops-macbook-acceptance-${UID}.json"

# ---------------------------------------------------------------------------
# Cleanup mode: load deterministic 0600 state, revalidate, tear down one project
# ---------------------------------------------------------------------------
if [[ "$MODE" == "cleanup" ]]; then
  if [[ ! -f "$E2E_STATE_FILE" ]]; then
    printf 'no state file at %s (nothing to clean)\n' "$E2E_STATE_FILE"
    exit 0
  fi
  [[ "$(file_mode "$E2E_STATE_FILE")" == "600" ]] || { printf 'state file not 0600 (refusing): %s\n' "$E2E_STATE_FILE" >&2; exit 2; }
  STATE="$(cat "$E2E_STATE_FILE")"
  C_ROOT="$(printf '%s' "$STATE" | jq -r '.root // empty')"
  C_PROJECT="$(printf '%s' "$STATE" | jq -r '.project // empty')"
  C_COMPOSE="$(printf '%s' "$STATE" | jq -r '.compose_file // empty')"
  # Revalidate both bounded prefixes and the canonical compose path.
  [[ "$C_ROOT" == "${TMPDIR:-/tmp}"/quoteops-mac-e2e.* ]] || { printf 'refusing unsafe root: %s\n' "$C_ROOT" >&2; exit 2; }
  [[ "$C_PROJECT" == quoteops_mac_e2e_* ]] || { printf 'refusing unsafe project: %s\n' "$C_PROJECT" >&2; exit 2; }
  [[ "$C_COMPOSE" == "$C_ROOT"/quoteops-v1/current/docker-compose.yml ]] || { printf 'refusing unsafe compose path: %s\n' "$C_COMPOSE" >&2; exit 2; }
  printf 'cleaning root=%s project=%s\n' "$C_ROOT" "$C_PROJECT"
  if [[ -f "$C_ROOT/quoteops-v1/.env" && -f "$C_ROOT/quoteops-v1/current/release.env" && -f "$C_COMPOSE" ]]; then
    docker compose \
      --project-name "$C_PROJECT" \
      --env-file "$C_ROOT/quoteops-v1/.env" \
      --env-file "$C_ROOT/quoteops-v1/current/release.env" \
      -f "$C_COMPOSE" \
      --profile tunnel \
      down --volumes --remove-orphans 2>/dev/null || true
  fi
  rm -rf "$C_ROOT"
  rm -f "$E2E_STATE_FILE"
  printf 'cleanup done\n'
  exit 0
fi

# ---------------------------------------------------------------------------
# Preflight (Step 3): fail closed, print only missing names, never values
# ---------------------------------------------------------------------------
PREFLIGHT_FAIL=()

if [[ "$(uname -m)" != "arm64" ]]; then PREFLIGHT_FAIL+=("uname -m == arm64"); fi
for c in curl jq openssl node tar shasum bash; do
  command -v "$c" >/dev/null 2>&1 || PREFLIGHT_FAIL+=("$c")
done

if ! docker info >/dev/null 2>&1; then PREFLIGHT_FAIL+=("docker info"); fi

DC_VER="$(docker compose version --short 2>/dev/null | sed 's/^v//' || true)"
DC_MAJOR="${DC_VER%%.*}"
DC_REST="${DC_VER#*.}"
DC_MINOR="${DC_REST%%.*}"
[[ "$DC_MAJOR" =~ ^[0-9]+$ ]] || DC_MAJOR=0
[[ "$DC_MINOR" =~ ^[0-9]+$ ]] || DC_MINOR=0
if (( DC_MAJOR < 2 || (DC_MAJOR == 2 && DC_MINOR < 24) )); then
  PREFLIGHT_FAIL+=("docker compose version >= 2.24.0")
fi

CLIENT_ID_RE='^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$'
INSTALLATION_ID_RE='^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$'
HTTPS_RE='^https://[A-Za-z0-9._:-]'
HOSTNAME_RE='^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$'
EMAIL_RE='^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'

check_env_nonempty() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then PREFLIGHT_FAIL+=("$name"); fi
}
check_env_match() {
  local name="$1" re="$2"
  if [[ -z "${!name:-}" ]] || ! [[ "${!name}" =~ $re ]]; then PREFLIGHT_FAIL+=("$name"); fi
}
check_file_0600() {
  local name="$1"
  local path="${!name:-}"
  if [[ -z "$path" ]]; then PREFLIGHT_FAIL+=("$name"); return; fi
  if [[ ! -f "$path" || -L "$path" ]]; then PREFLIGHT_FAIL+=("$name"); return; fi
  local mode
  mode="$(file_mode "$path" 2>/dev/null || true)"
  [[ "$mode" == "600" ]] || PREFLIGHT_FAIL+=("$name")
}

check_env_match E2E_CONTROL_PLANE_URL "$HTTPS_RE"
check_env_match E2E_EXPECTED_CLIENT_ID "$CLIENT_ID_RE"
check_env_match E2E_EXPECTED_INSTALLATION_ID "$INSTALLATION_ID_RE"
check_file_0600 E2E_REGISTRATION_TOKEN_FILE
check_env_match E2E_AI_PROVIDER '^(openrouter|gemini)$'
check_file_0600 E2E_AI_KEY_FILE
check_file_0600 E2E_TUNNEL_TOKEN_FILE
check_file_0600 E2E_CF_ACCESS_CLIENT_ID_FILE
check_file_0600 E2E_CF_ACCESS_CLIENT_SECRET_FILE
check_file_0600 E2E_RESEND_API_KEY_FILE
check_file_0600 E2E_SAKBE_KEY_FILE
check_env_match E2E_EMBEDDING_PROVIDER '^(gemini|openai_compatible)$'
check_env_nonempty E2E_EMBEDDING_MODEL
check_file_0600 E2E_EMBEDDING_KEY_FILE
if [[ "${E2E_EMBEDDING_PROVIDER:-}" == "openai_compatible" ]]; then
  check_env_match E2E_EMBEDDING_BASE_URL "$HTTPS_RE"
fi
check_env_match E2E_PUBLIC_HOSTNAME "$HOSTNAME_RE"
check_env_nonempty E2E_AUTHORIZED_EMAIL
check_env_match E2E_RESEND_INTAKE_ADDRESS "$EMAIL_RE"
check_env_match E2E_RESEND_FROM_ADDRESS "$EMAIL_RE"

if [[ ${#PREFLIGHT_FAIL[@]} -gt 0 ]]; then
  printf 'macbook-acceptance: missing preflight inputs:\n' >&2
  printf '  %s\n' "${PREFLIGHT_FAIL[@]}" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Bounded root + state file (Step 4)
# ---------------------------------------------------------------------------
E2E_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/quoteops-mac-e2e.XXXXXX")"
COMPOSE_PROJECT_NAME="quoteops_mac_e2e_$(date +%s)"
QUOTEOPS_HOME="$E2E_ROOT/quoteops-v1"
QUOTEOPS_BIN_DIR="$E2E_ROOT/bin"
QUOTEOPS_PLATFORM="linux/amd64"
COMPOSE_FILE="$QUOTEOPS_HOME/current/docker-compose.yml"

[[ "$E2E_ROOT" == "${TMPDIR:-/tmp}"/quoteops-mac-e2e.* ]] || die "unsafe root: $E2E_ROOT"
[[ "$COMPOSE_PROJECT_NAME" == quoteops_mac_e2e_* ]] || die "unsafe project: $COMPOSE_PROJECT_NAME"
[[ "$QUOTEOPS_HOME" == "$E2E_ROOT/quoteops-v1" ]] || die "unsafe home: $QUOTEOPS_HOME"
[[ "$QUOTEOPS_BIN_DIR" == "$E2E_ROOT/bin" ]] || die "unsafe bin dir: $QUOTEOPS_BIN_DIR"
[[ "$QUOTEOPS_PLATFORM" == "linux/amd64" ]] || die "unsafe platform: $QUOTEOPS_PLATFORM"

# Refuse a new run while a retained project is still on disk.
if [[ -f "$E2E_STATE_FILE" ]]; then
  PREV_ROOT="$(jq -r '.root // empty' "$E2E_STATE_FILE" 2>/dev/null || true)"
  if [[ "$PREV_ROOT" == "${TMPDIR:-/tmp}"/quoteops-mac-e2e.* && -d "$PREV_ROOT" ]]; then
    die "a previous retained run exists at $PREV_ROOT; clean it first with: bash $0 --cleanup"
  fi
  rm -f "$E2E_STATE_FILE"
fi

MOCK_TMS_PID=""
INPUT_DIR=""
E2E_TMS_CURL_CONFIG=""
E2E_ACCESS_CURL_CONFIG=""
PATTERN_FILE=""
REG_CURL_CONFIG=""

write_state() {
  local tmp_state
  tmp_state="$(mktemp "$E2E_ROOT/state.XXXXXX")"
  jq -n \
    --arg root "$E2E_ROOT" \
    --arg project "$COMPOSE_PROJECT_NAME" \
    --arg compose_file "$COMPOSE_FILE" \
    --arg created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{root:$root, project:$project, compose_file:$compose_file, created_at:$created_at}' \
    > "$tmp_state"
  chmod 0600 "$tmp_state"
  mv "$tmp_state" "$E2E_STATE_FILE"
  chmod 0600 "$E2E_STATE_FILE"
}
write_state

cleanup() {
  local code=$?
  # Always terminate + wait for the recorded mock-TMS child PID.
  if [[ -n "${MOCK_TMS_PID:-}" ]] && kill -0 "$MOCK_TMS_PID" 2>/dev/null; then
    kill "$MOCK_TMS_PID" 2>/dev/null || true
    wait "$MOCK_TMS_PID" 2>/dev/null || true
  fi
  # Always delete transient curl/answer files.
  rm -f "${E2E_TMS_CURL_CONFIG:-}" "${E2E_ACCESS_CURL_CONFIG:-}" "${REG_CURL_CONFIG:-}" "${PATTERN_FILE:-}" 2>/dev/null || true
  rm -rf "${INPUT_DIR:-}" 2>/dev/null || true

  if [[ "$KEEP" == "1" && $code -ne 0 ]]; then
    printf 'macbook-acceptance: retained for debugging: root=%s project=%s\n' "$E2E_ROOT" "$COMPOSE_PROJECT_NAME" >&2
    printf 'macbook-acceptance: WARNING local client.env still contains test credentials\n' >&2
    printf 'macbook-acceptance: to clean: bash %s --cleanup\n' "$0" >&2
    return 0
  fi

  # Revalidate every bounded path before touching Docker, then compose down
  # only when both env files plus the recorded Compose file exist.
  if [[ "${E2E_ROOT:-}" == "${TMPDIR:-/tmp}"/quoteops-mac-e2e.* && \
        "${COMPOSE_PROJECT_NAME:-}" == quoteops_mac_e2e_* && \
        "${QUOTEOPS_HOME:-}" == "$E2E_ROOT/quoteops-v1" && \
        "${QUOTEOPS_BIN_DIR:-}" == "$E2E_ROOT/bin" && \
        -f "$QUOTEOPS_HOME/.env" && -f "$QUOTEOPS_HOME/current/release.env" && -f "$COMPOSE_FILE" ]]; then
    docker compose \
      --project-name "$COMPOSE_PROJECT_NAME" \
      --env-file "$QUOTEOPS_HOME/.env" \
      --env-file "$QUOTEOPS_HOME/current/release.env" \
      -f "$COMPOSE_FILE" \
      --profile tunnel \
      down --volumes --remove-orphans 2>/dev/null || true
  fi
  if [[ "${E2E_ROOT:-}" == "${TMPDIR:-/tmp}"/quoteops-mac-e2e.* ]]; then
    rm -rf "$E2E_ROOT"
  fi
  rm -f "$E2E_STATE_FILE" 2>/dev/null || true
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Single-line-secret curl-config writers (never print values)
# ---------------------------------------------------------------------------
write_curl_bearer_config_from_file() {
  local token_file="$1" out="$2"
  [[ -f "$token_file" && ! -L "$token_file" ]] || die "curl bearer source missing"
  local secret
  secret="$(cat "$token_file")" || die "curl bearer source unreadable"
  secret="${secret%$'\n'}"
  [[ -n "$secret" && "$secret" != *$'\n'* && "$secret" != *$'\r'* ]] ||
    die "curl bearer source must be a single non-empty line"
  printf 'header = "Authorization: Bearer %s"\n' "$secret" > "$out"
}

write_cloudflare_access_config_from_files() {
  local id_file="$1" secret_file="$2" out="$3"
  [[ -f "$id_file" && ! -L "$id_file" ]] || die "access client id source missing"
  [[ -f "$secret_file" && ! -L "$secret_file" ]] || die "access client secret source missing"
  local cid csec
  cid="$(cat "$id_file")"; cid="${cid%$'\n'}"
  csec="$(cat "$secret_file")"; csec="${csec%$'\n'}"
  [[ -n "$cid" && "$cid" != *$'\n'* && "$cid" != *$'\r'* ]] || die "access client id must be a single line"
  [[ -n "$csec" && "$csec" != *$'\n'* && "$csec" != *$'\r'* ]] || die "access client secret must be a single line"
  {
    printf 'header = "CF-Access-Client-Id: %s"\n' "$cid"
    printf 'header = "CF-Access-Client-Secret: %s"\n' "$csec"
  } > "$out"
}

# ---------------------------------------------------------------------------
# Step 5: temporary noninteractive answer file + curl configs + secret patterns
# ---------------------------------------------------------------------------
INPUT_DIR="$E2E_ROOT/onboarding-input"
install -d -m 0700 "$INPUT_DIR"
install -m 0600 "$E2E_AI_KEY_FILE" "$INPUT_DIR/ai-key"
install -m 0600 "$E2E_TUNNEL_TOKEN_FILE" "$INPUT_DIR/tunnel-token"
install -m 0600 "$E2E_CF_ACCESS_CLIENT_ID_FILE" "$INPUT_DIR/access-client-id"
install -m 0600 "$E2E_CF_ACCESS_CLIENT_SECRET_FILE" "$INPUT_DIR/access-client-secret"
install -m 0600 "$E2E_RESEND_API_KEY_FILE" "$INPUT_DIR/resend-key"
install -m 0600 "$E2E_SAKBE_KEY_FILE" "$INPUT_DIR/sakbe-key"
install -m 0600 "$E2E_EMBEDDING_KEY_FILE" "$INPUT_DIR/embedding-key"
install -m 0600 "$FIXTURE_DIR/readiness-knowledge.md" "$INPUT_DIR/readiness-knowledge.md"
openssl rand -hex 32 > "$INPUT_DIR/tms-key"
chmod 0600 "$INPUT_DIR/tms-key"

E2E_TMS_CURL_CONFIG="$E2E_ROOT/tms-curl.conf"
write_curl_bearer_config_from_file "$INPUT_DIR/tms-key" "$E2E_TMS_CURL_CONFIG"
chmod 0600 "$E2E_TMS_CURL_CONFIG"
E2E_ACCESS_CURL_CONFIG="$E2E_ROOT/access-curl.conf"
write_cloudflare_access_config_from_files \
  "$INPUT_DIR/access-client-id" \
  "$INPUT_DIR/access-client-secret" \
  "$E2E_ACCESS_CURL_CONFIG"
chmod 0600 "$E2E_ACCESS_CURL_CONFIG"
REG_CURL_CONFIG="$E2E_ROOT/reg-curl.conf"
write_curl_bearer_config_from_file "$E2E_REGISTRATION_TOKEN_FILE" "$REG_CURL_CONFIG"
chmod 0600 "$REG_CURL_CONFIG"

# Build the literal-secret pattern file from every input credential + the
# registration token, before onboarding deletes the input directory.
PATTERN_FILE="$E2E_ROOT/secret-patterns.txt"
: > "$PATTERN_FILE"
chmod 0600 "$PATTERN_FILE"
for sf in "$INPUT_DIR/ai-key" "$INPUT_DIR/tunnel-token" "$INPUT_DIR/access-client-id" \
          "$INPUT_DIR/access-client-secret" "$INPUT_DIR/resend-key" "$INPUT_DIR/sakbe-key" \
          "$INPUT_DIR/embedding-key" "$INPUT_DIR/tms-key" "$E2E_REGISTRATION_TOKEN_FILE"; do
  [[ -f "$sf" && -s "$sf" ]] || continue
  cat "$sf" >> "$PATTERN_FILE"
  printf '\n' >> "$PATTERN_FILE"
done

E2E_ANSWERS_FILE="$INPUT_DIR/answers.json"
export E2E_ANSWERS_FILE E2E_TMS_CURL_CONFIG E2E_ACCESS_CURL_CONFIG
export E2E_AI_PROVIDER E2E_PUBLIC_HOSTNAME E2E_AUTHORIZED_EMAIL
export E2E_RESEND_INTAKE_ADDRESS E2E_RESEND_FROM_ADDRESS
export E2E_EMBEDDING_PROVIDER E2E_EMBEDDING_MODEL E2E_EMBEDDING_BASE_URL

# Run the checked-in helper logic (no arbitrary JavaScript accepted).
node --input-type=module <<'JS'
import fs from "node:fs";

const inputPath = "/run/quoteops-onboard-input";
const answers = {
  schema_version: 1,
  ai_provider: {
    provider: process.env.E2E_AI_PROVIDER,
    api_key: { file: `${inputPath}/ai-key` }
  },
  cloudflare: {
    public_hostname: process.env.E2E_PUBLIC_HOSTNAME,
    tunnel_token: { file: `${inputPath}/tunnel-token` },
    access_client_id: { file: `${inputPath}/access-client-id` },
    access_client_secret: { file: `${inputPath}/access-client-secret` }
  },
  activation: {
    authorized_email: process.env.E2E_AUTHORIZED_EMAIL
  },
  tms: {
    mode: "quoteops-tms-http-v1",
    base_url: "http://host.docker.internal:19091",
    api_key: { file: `${inputPath}/tms-key` },
    sample_query: {
      request_id: "MAC-E2E-PROBE",
      origin: {
        city: "Guadalajara",
        state: "Jalisco",
        country: "MX"
      },
      destination: {
        city: "Monterrey",
        state: "Nuevo Leon",
        country: "MX"
      },
      vehicle_profile_id: "T3S3_53_DRYVAN",
      cargo: {
        commodity: "general",
        sector: "industrial",
        weight_kg: 18000
      },
      time_window: {
        from: "2026-01-01",
        to: "2026-12-31"
      },
      max_results: 20
    }
  },
  mailbox: {
    provider: "resend",
    api_key: { file: `${inputPath}/resend-key` },
    intake_address: process.env.E2E_RESEND_INTAKE_ADDRESS,
    from_address: process.env.E2E_RESEND_FROM_ADDRESS
  },
  sakbe: {
    api_key: { file: `${inputPath}/sakbe-key` }
  },
  embeddings:
    process.env.E2E_EMBEDDING_PROVIDER === "gemini"
      ? {
          provider: "gemini",
          model: process.env.E2E_EMBEDDING_MODEL,
          api_key: { file: `${inputPath}/embedding-key` }
        }
      : {
          provider: "openai_compatible",
          model: process.env.E2E_EMBEDDING_MODEL,
          base_url: process.env.E2E_EMBEDDING_BASE_URL,
          api_key: { file: `${inputPath}/embedding-key` }
        },
  knowledge: {
    sources: [{ file: `${inputPath}/readiness-knowledge.md` }],
    consent_external_embedding_transfer: true
  },
  accept_generated_profiles: true,
  accept_default_authorization: true,
  accept_sample_prices: true
};

fs.writeFileSync(
  process.env.E2E_ANSWERS_FILE,
  `${JSON.stringify(answers, null, 2)}\n`,
  { mode: 0o600 }
);
JS
chmod 0600 "$E2E_ANSWERS_FILE"

# ---------------------------------------------------------------------------
# Step 6: exercise the real installation path
# ---------------------------------------------------------------------------

# 1. Start the loopback-bound mock TMS as a bounded child process.
MOCK_TMS_HOST=127.0.0.1 PORT=19091 MOCK_TMS_TOKEN_FILE="$INPUT_DIR/tms-key" \
  node "$REPO_ROOT/deploy/appliance/mock-tms/server.mjs" \
  > "$E2E_ROOT/mock-tms.log" 2>&1 &
MOCK_TMS_PID=$!
mock_tms_ready=0
for _ in $(seq 1 30); do
  if curl -fsS --config "$E2E_TMS_CURL_CONFIG" \
    "http://127.0.0.1:19091/quoteops/v1/health" >/dev/null 2>&1; then
    mock_tms_ready=1; break
  fi
  sleep 1
done
[[ "$mock_tms_ready" == "1" ]] || die "mock TMS did not become healthy (see $E2E_ROOT/mock-tms.log)"

# 2. Read the staged release manifest, then run a disposable Caddy container
#    that authenticates against the loopback-bound mock TMS through the host
#    gateway. Fail before onboarding if the container cannot reach it.
RELEASE_MANIFEST="$E2E_ROOT/release-manifest.json"
curl -fsSL --config "$REG_CURL_CONFIG" \
  "$E2E_CONTROL_PLANE_URL/api/install/manifest" -o "$RELEASE_MANIFEST" \
  || die "could not fetch staged release manifest"
CADDY_IMAGE="$(jq -r '.images.caddy // .caddy_image // empty' "$RELEASE_MANIFEST")"
[[ -n "$CADDY_IMAGE" ]] || die "release manifest did not expose a Caddy image ref"
CADDY_PROBE_ENV="$E2E_ROOT/caddy-probe.env"
printf 'TMS_BEARER=%s\n' "$(cat "$INPUT_DIR/tms-key")" > "$CADDY_PROBE_ENV"
chmod 0600 "$CADDY_PROBE_ENV"
if ! docker run --rm --env-file "$CADDY_PROBE_ENV" "$CADDY_IMAGE" \
    sh -c 'wget -qO- -T 5 --header="Authorization: Bearer $TMS_BEARER" http://host.docker.internal:19091/quoteops/v1/health' \
    >/dev/null 2>&1; then
  rm -f "$CADDY_PROBE_ENV"
  die "onboarding container cannot reach loopback-bound mock TMS (docker_desktop_host_gateway_unreachable)"
fi
rm -f "$CADDY_PROBE_ENV"

# 3. Fetch the stable bootstrap from the control plane.
BOOTSTRAP_FILE="$E2E_ROOT/bootstrap.sh"
curl --proto "=https" --proto-redir "=https" --tlsv1.2 -fsSL \
  --config "$REG_CURL_CONFIG" \
  "$E2E_CONTROL_PLANE_URL/install/quoteops" -o "$BOOTSTRAP_FILE" \
  || die "could not fetch stable bootstrap"
chmod 700 "$BOOTSTRAP_FILE"

# 4-5. Invoke the bootstrap with the secure token-file automation branch and
#      the bounded answers directory. Published release images are pulled by
#      the installer; no local image build is allowed.
QUOTEOPS_BOOTSTRAP_TEST_MODE=macbook \
QUOTEOPS_AUTOMATION_MODE=1 \
QUOTEOPS_HOME="$QUOTEOPS_HOME" \
QUOTEOPS_BIN_DIR="$QUOTEOPS_BIN_DIR" \
COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" \
QUOTEOPS_PLATFORM="$QUOTEOPS_PLATFORM" \
QUOTEOPS_REGISTRATION_TOKEN_FILE="$E2E_REGISTRATION_TOKEN_FILE" \
QUOTEOPS_CONTROL_PLANE_URL="$E2E_CONTROL_PLANE_URL" \
  bash "$BOOTSTRAP_FILE" --answers-dir "$INPUT_DIR" \
  > "$E2E_ROOT/install.log" 2>&1 \
  || die "bootstrap/installer failed (see $E2E_ROOT/install.log)"

# Onboarding has copied validated values into the appliance's stable files;
# delete the entire host-owned answers directory immediately.
rm -rf "$INPUT_DIR"
[[ ! -e "$INPUT_DIR" ]] || die "host answer inputs were not removed after onboarding"

# 6. Published release images must have been pulled, not built locally.
PINNED_VERSION="$(jq -r '.version' "$QUOTEOPS_HOME/current/release.env" 2>/dev/null \
  || sed -n 's/^QUOTEOPS_VERSION=//p' "$QUOTEOPS_HOME/current/release.env" | tr -d '"')"
[[ "$PINNED_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "could not read pinned release version"

# 7. Wait for Cloudflare Access to block an unauthenticated public request.
anon_blocked=0
for _ in $(seq 1 30); do
  anon_status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
    "https://$E2E_PUBLIC_HOSTNAME/api/health" 2>/dev/null || true)"
  case "$anon_status" in
    401|403) anon_blocked=1; break;;
    000) sleep 2;;
    *) die "Cloudflare Access let an unauthenticated request through (status $anon_status)";;
  esac
done
[[ "$anon_blocked" == "1" ]] || die "Cloudflare Access never blocked the unauthenticated probe"

# 8. Authenticated public requests use the temporary 0600 Access curl config.
authed_public_get() {
  curl -fsSL --config "$E2E_ACCESS_CURL_CONFIG" --max-time 30 \
    "https://$E2E_PUBLIC_HOSTNAME$1"
}
tms_authed_get() {
  curl -fsSL --config "$E2E_TMS_CURL_CONFIG" --max-time 30 \
    "http://127.0.0.1:19091$1"
}
tms_authed_status() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 30 \
    --config "$E2E_TMS_CURL_CONFIG" "$@"
}

# ---------------------------------------------------------------------------
# Step 7: assert the complete public workflow
# ---------------------------------------------------------------------------

# GET /api/health
HEALTH_JSON="$(authed_public_get /api/health || die "authenticated /api/health unreachable")"
jq -e '.ok == true' <<<"$HEALTH_JSON" >/dev/null || die "/api/health ok is not true"
jq -e --arg v "$PINNED_VERSION" '.product_version == $v' <<<"$HEALTH_JSON" >/dev/null \
  || die "/api/health product_version does not match the release pin"

# GET /api/setup-state
SETUP_JSON="$(authed_public_get /api/setup-state || die "authenticated /api/setup-state unreachable")"
jq -e --arg c "$E2E_EXPECTED_CLIENT_ID" \
      --arg i "$E2E_EXPECTED_INSTALLATION_ID" \
      '.activation.client_id == $c and .activation.installation_id == $i' \
  <<<"$SETUP_JSON" >/dev/null || die "setup-state identity does not match the install pack"
jq -e '.required_steps == []' <<<"$SETUP_JSON" >/dev/null || die "setup-state required_steps is not empty"
jq -e '.tunnel.status == "ready"' <<<"$SETUP_JSON" >/dev/null || die "tunnel is not ready"

# GET /api/rfqs/:runId — the single readiness run created during installation.
TEST_RFQ_FILE="$QUOTEOPS_HOME/settings/test-rfq.json"
[[ -f "$TEST_RFQ_FILE" ]] || die "settings/test-rfq.json was not created during installation"
RUN_ID="$(jq -r '.run_id // .runId // .id // empty' "$TEST_RFQ_FILE")"
[[ -n "$RUN_ID" ]] || die "test-rfq.json did not expose a run id"
RFQ_JSON="$(authed_public_get "/api/rfqs/$RUN_ID" || die "authenticated /api/rfqs/$RUN_ID unreachable")"
jq -e '.state == "priced" or .state == "approval_complete" or .status == "priced" or .status == "approval_complete"' \
  <<<"$RFQ_JSON" >/dev/null || die "readiness RFQ did not reach priced/approval-complete state"
# The original controlled request must be preserved verbatim.
jq -e '.request.origin_city == "Guadalajara" and .request.destination_city == "Monterrey" and .request.vehicle_profile_id == "T3S3_53_DRYVAN"' \
  <<<"$RFQ_JSON" >/dev/null || die "readiness RFQ lost the original controlled request"

# mock TMS: authenticated GET /quote-writebacks returns one row.
WB_JSON="$(tms_authed_get /quote-writebacks || die "mock TMS writebacks unreachable")"
WB_COUNT="$(jq 'if type=="array" then length else 1 end' <<<"$WB_JSON")"
[[ "$WB_COUNT" == "1" ]] || die "mock TMS writebacks did not return exactly one row"

# Authenticated POST /quoteops/v1/quotes with the stored body (excluding
# mock-only received_at, reordered keys) returns the same result and still one row.
ORIG_BODY="$(jq -c '.[0].request_body // .[0].body // .[0]' <<<"$WB_JSON")"
REPLAY_BODY="$(jq -c 'del(.received_at) | to_entries | sort_by(.key) | from_entries' <<<"$ORIG_BODY")"
# The canonical replay is a POST, not a GET; issue it explicitly.
REPLAY_RESP="$(curl -fsSL --config "$E2E_TMS_CURL_CONFIG" --max-time 30 \
  -X POST -H 'Content-Type: application/json' -d "$REPLAY_BODY" \
  "http://127.0.0.1:19091/quoteops/v1/quotes" 2>/dev/null || true)"
[[ -n "$REPLAY_RESP" ]] || die "mock TMS replay POST did not return a result"
WB_JSON_2="$(tms_authed_get /quote-writebacks)"
WB_COUNT_2="$(jq 'if type=="array" then length else 1 end' <<<"$WB_JSON_2")"
[[ "$WB_COUNT_2" == "1" ]] || die "mock TMS replay did not keep exactly one row"

# Authenticated POST with the same quote_id and a changed rate_mxn returns 409.
QUOTE_ID="$(jq -r '.quote_id // .id // empty' <<<"$ORIG_BODY")"
[[ -n "$QUOTE_ID" ]] || die "stored writeback did not expose a quote_id"
CHANGED_BODY="$(jq -c --arg id "$QUOTE_ID" '.quote_id=$id | .rate_mxn=((.rate_mxn // 0)+1)' <<<"$REPLAY_BODY")"
CONFLICT_STATUS="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 \
  --config "$E2E_TMS_CURL_CONFIG" -X POST -H 'Content-Type: application/json' \
  -d "$CHANGED_BODY" "http://127.0.0.1:19091/quoteops/v1/quotes")"
[[ "$CONFLICT_STATUS" == "409" ]] \
  || die "mock TMS did not return 409 for a conflicting rate (got $CONFLICT_STATUS)"

# Restart preserves the run and setup state.
docker compose \
  --project-name "$COMPOSE_PROJECT_NAME" \
  --env-file "$QUOTEOPS_HOME/.env" \
  --env-file "$QUOTEOPS_HOME/current/release.env" \
  -f "$COMPOSE_FILE" \
  --profile tunnel restart >/dev/null 2>&1 \
  || die "tunnel-profile restart failed"
SETUP_AFTER="$(authed_public_get /api/setup-state || die "setup-state unreachable after restart")"
[[ "$(jq -c '.activation' <<<"$SETUP_AFTER")" == "$(jq -c '.activation' <<<"$SETUP_JSON")" ]] \
  || die "restart changed setup-state activation identity"
RFQ_AFTER="$(authed_public_get "/api/rfqs/$RUN_ID" || die "rfq unreachable after restart")"
[[ "$(jq -c '.state // .status' <<<"$RFQ_AFTER")" == "$(jq -c '.state // .status' <<<"$RFQ_JSON")" ]] \
  || die "restart changed the readiness RFQ state"

# operator: quoteops status returns ready and the pinned version.
STATUS_OUTPUT="$("$QUOTEOPS_BIN_DIR/quoteops" status 2>/dev/null || true)"
[[ "$STATUS_OUTPUT" == *"ready"* && "$STATUS_OUTPUT" == *"$PINNED_VERSION"* ]] \
  || die "quoteops status did not report ready + pinned version"

# Install summary must carry the live AI validation, mailbox probe and
# knowledge ingest contracts; a static copilot fallback, skipped/different
# provider, missing mailbox receipt, or zero-doc/zero-chunk result fails.
SUMMARY_FILE="$QUOTEOPS_HOME/settings/install-summary.json"
[[ -f "$SUMMARY_FILE" ]] || die "install-summary.json was not written"
jq -e --arg provider "$E2E_AI_PROVIDER" '
  .ai_validation.provider == $provider and
  .ai_validation.live_request == true and
  .ai_validation.fallback == false and
  .mailbox_probe.provider == "resend" and
  .mailbox_probe.validated == true and
  .mailbox_probe.idempotent == true and
  .knowledge_ingest.document_count == 1 and
  .knowledge_ingest.chunk_count_minimum >= 1 and
  .knowledge_ingest.external_embedding_consent == true
' "$SUMMARY_FILE" >/dev/null || die "install summary did not satisfy the live acceptance contract"

# ---------------------------------------------------------------------------
# Step 8: write redacted evidence
# ---------------------------------------------------------------------------
EVIDENCE_STAGING="$E2E_ROOT/evidence"
mkdir -p "$EVIDENCE_STAGING"

write_evidence() {
  local name="$1" body="$2"
  printf '%s' "$body" > "$EVIDENCE_STAGING/$name"
  chmod 0600 "$EVIDENCE_STAGING/$name"
}

SAFE_ENV_JSON="$(jq -n \
  --arg arch "$(uname -m)" \
  --arg platform "$QUOTEOPS_PLATFORM" \
  --arg project "$COMPOSE_PROJECT_NAME" \
  --arg dc "$DC_VER" \
  --arg node "$(node --version 2>/dev/null || echo unknown)" \
  --arg os "$(uname -s)" \
  --arg started_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{arch:$arch, platform:$platform, compose_project:$project,
    docker_compose_version:$dc, node_version:$node, os:$os, started_at:$started_at}')"
write_evidence 00-environment.json "$SAFE_ENV_JSON"

write_evidence 01-release.json "$(jq -n --arg version "$PINNED_VERSION" '{version:$version}')"
write_evidence 02-install-summary.json "$(cat "$SUMMARY_FILE")"
write_evidence 03-setup-state.json "$SETUP_AFTER"
write_evidence 04-rfq-result.json "$RFQ_AFTER"
write_evidence 05-tms-writeback.json "$WB_JSON_2"
write_evidence 06-restart-persistence.json "$(jq -n \
  --argjson before "$(jq -c '{activation:.activation}' <<<"$SETUP_JSON")" \
  --argjson after  "$(jq -c '{activation:.activation}' <<<"$SETUP_AFTER")" \
  --arg rfq_state "$(jq -r '.state // .status' <<<"$RFQ_AFTER")" \
  '{setup_before:$before, setup_after:$after, rfq_state_preserved:$rfq_state}')"
write_evidence 07-final-status.json "$(jq -R -s 'split("\n") | map(select(length>0))' <<<"$STATUS_OUTPUT")"

# Delete the separate TMS + Access curl configs before evidence scanning.
rm -f "$E2E_TMS_CURL_CONFIG" "$E2E_ACCESS_CURL_CONFIG" "$REG_CURL_CONFIG"
E2E_TMS_CURL_CONFIG=""
E2E_ACCESS_CURL_CONFIG=""
REG_CURL_CONFIG=""

scan_evidence() {
  local f
  for f in "$EVIDENCE_STAGING"/*.json; do
    [[ -f "$f" ]] || continue
    # Regex patterns from the plan.
    if grep -Ea 'Bearer|TUNNEL_TOKEN|API_KEY|registration_token|CF-Access-Client-Secret|sk-|eyJ' "$f" >/dev/null 2>&1; then
      die "evidence file $f matched a secret regex; leaving source in $EVIDENCE_STAGING for manual inspection"
    fi
    # Fixed-string literal-credential scan.
    if [[ -s "$PATTERN_FILE" ]] && grep -Faf "$PATTERN_FILE" "$f" >/dev/null 2>&1; then
      die "evidence file $f matched a literal credential; leaving source in $EVIDENCE_STAGING for manual inspection"
    fi
  done
}
scan_evidence

# Delete the literal pattern file before any move; it never leaves the temp root.
rm -f "$PATTERN_FILE"
PATTERN_FILE=""

EVIDENCE_DIR="$REPO_ROOT/docs/evidence/$(date -u +%Y%m%dT%H%M%SZ)-macbook-appliance"
mkdir -p "$EVIDENCE_DIR"
for f in "$EVIDENCE_STAGING"/*.json; do
  [[ -f "$f" ]] || continue
  mv "$f" "$EVIDENCE_DIR/$(basename "$f")"
done
chmod 0600 "$EVIDENCE_DIR"/*.json

# ---------------------------------------------------------------------------
# Success: emit exactly the four canonical safe lines + pass line
# ---------------------------------------------------------------------------
printf 'MACBOOK APPLIANCE ACCEPTANCE: PASS\n'
printf 'public_url=https://%s\n' "$E2E_PUBLIC_HOSTNAME"
printf 'version=%s\n' "$PINNED_VERSION"
printf 'evidence=%s\n' "$EVIDENCE_DIR"
