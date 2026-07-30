#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
APPLIANCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
REPO_DIR="$(cd "$APPLIANCE_DIR/../.." && pwd -P)"
SCHEMA_FILE="$REPO_DIR/apps/api/src/storage/schema.ts"
COMPOSE_FILE="$APPLIANCE_DIR/docker-compose.yml"
TEMP_DIRS=()
POSTGRES_CONTAINERS=()

cleanup() {
  if [[ "${#POSTGRES_CONTAINERS[@]}" -gt 0 ]] && command -v docker >/dev/null 2>&1; then
    docker rm -f "${POSTGRES_CONTAINERS[@]}" >/dev/null 2>&1 || true
  fi
  if [[ "${#TEMP_DIRS[@]}" -gt 0 ]]; then
    rm -rf "${TEMP_DIRS[@]}"
  fi
}
trap cleanup EXIT

fail() {
  echo "smoke.sh: $*" >&2
  exit 1
}

docker_daemon_available() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

file_mode() {
  # Node is a runtime prerequisite and reports POSIX mode bits consistently on
  # GNU/Linux and BSD/macOS, unlike the incompatible stat command variants.
  node -e 'const mode = require("node:fs").statSync(process.argv[1]).mode & 0o777; process.stdout.write(mode.toString(8).padStart(3, "0"));' "$1"
}

validate_human_simulator_fixture() {
  local fixture_dir="$APPLIANCE_DIR/examples/human-simulator"
  local required_file
  local fixture_files=(
    "README.md"
    "client-manifest.yaml"
    "connectors/agent/agent-config.yaml"
    "connectors/tms-adapter.yaml"
    "connectors/tms-mapping.json"
    "connectors/knowledge/operating-policy.md"
    "fixtures/rfq-email.txt"
    "verify.sh"
  )

  for required_file in "${fixture_files[@]}"; do
    [[ -f "$fixture_dir/$required_file" ]] || fail "human simulator fixture missing: $required_file"
  done
  [[ -x "$fixture_dir/verify.sh" ]] || fail "human simulator verifier must be executable"

  FIXTURE_DIR="$fixture_dir" node --import tsx --input-type=module -e '
    import { readFile } from "node:fs/promises";
    import { join } from "node:path";
    import { loadApplianceManifest } from "./apps/api/src/runtimeTools.ts";
    import { loadAgentRuntimeConfig } from "./packages/connectors/src/agent/AgentRuntimeConfig.ts";
    import { loadTmsAdapterConfig } from "./packages/connectors/src/tms/TmsAdapterConfig.ts";
    import { tmsMappingConfigSchema } from "./packages/contracts/src/tmsCanonical.ts";

    void (async () => {
      const fixtureDir = process.env.FIXTURE_DIR;
      if (!fixtureDir) throw new Error("fixture directory is required");
      const [manifest, agent, tms, mappingRaw] = await Promise.all([
        loadApplianceManifest(join(fixtureDir, "client-manifest.yaml")),
        loadAgentRuntimeConfig(join(fixtureDir, "connectors/agent/agent-config.yaml")),
        loadTmsAdapterConfig(join(fixtureDir, "connectors/tms-adapter.yaml")),
        readFile(join(fixtureDir, "connectors/tms-mapping.json"), "utf8")
      ]);
      const mapping = tmsMappingConfigSchema.parse(JSON.parse(mappingRaw));
      if (manifest?.client_id !== "RESAUX") throw new Error("fixture manifest must use client_id RESAUX");
      if (!manifest?.business_units.some((unit) => unit.requester_email_domains?.includes("resaux.io"))) {
        throw new Error("fixture manifest must allow requester domain resaux.io");
      }
      if (agent.model.provider !== "openai" || agent.model.model_name !== "nvidia/nemotron-3-ultra-550b-a55b") {
        throw new Error("fixture agent must use the verified NVIDIA NIM OpenAI-compatible model");
      }
      if (agent.model.api_key_env !== "NVIDIA_NIM_API_KEY" || agent.model.base_url !== "https://integrate.api.nvidia.com/v1") {
        throw new Error("fixture agent must name the NVIDIA NIM runtime configuration");
      }
      if (agent.mailbox?.provider !== "resend") throw new Error("fixture mailbox provider must be resend");
      if (tms.provider !== "http" || tms.base_url_env !== "MOCK_TMS_BASE_URL" || tms.headers) {
        throw new Error("fixture mock adapter must send no credential header; mapping API-key fields are schema metadata only");
      }
      if (mapping.client_id !== "RESAUX" || mapping.transport !== "http" || mapping.runtime_ai_calls_allowed !== false) {
        throw new Error("fixture TMS mapping must be strict and bound to RESAUX");
      }
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  '

  if rg -n --hidden --glob '!README.md' --glob '!*.md' \
    '(gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|nvapi-[A-Za-z0-9_-]{20,}|re_[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)' \
    "$fixture_dir" >/dev/null; then
    fail "human simulator fixture appears to contain a committed secret"
  fi
  if rg -n --hidden \
    '(gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|nvapi-[A-Za-z0-9_-]{20,}|re_[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)' \
    "$fixture_dir/README.md" "$fixture_dir/connectors/knowledge/operating-policy.md" >/dev/null; then
    fail "human simulator fixture documentation appears to contain a committed secret"
  fi
}

validate_cloudflare_gate() {
  local gate_root
  local gate_home
  local mock_bin
  local output
  local result

  gate_root="$(mktemp -d "${TMPDIR:-/tmp}/quoteops-cloudflare-gate.XXXXXX")"
  TEMP_DIRS+=("$gate_root")
  gate_home="$gate_root/home"
  mock_bin="$gate_root/bin"
  export QUOTEOPS_VERIFY_TEST_MODE=smoke
  mkdir -p "$gate_home/current" "$gate_home/secrets" "$gate_home/settings" "$mock_bin"
  cp "$APPLIANCE_DIR/docker-compose.yml" "$gate_home/current/docker-compose.yml"
  cat > "$gate_home/current/release.env" <<'EOF'
QUOTEOPS_VERSION=v0.2.0
EOF
  cat > "$gate_home/.env" <<EOF
QUOTEOPS_CLIENT_ID=smoke-client
QUOTEOPS_INSTALLATION_ID=smoke-installation
QUOTEOPS_PUBLIC_HOSTNAME=quote.client.example
EOF
  cat > "$gate_home/settings/cloudflare.json" <<'EOF'
{"public_hostname":"quote.client.example"}
EOF

  cat > "$mock_bin/docker" <<'SH'
#!/usr/bin/env bash
set -u
if [[ " $* " == *" ps --status running --services "* ]]; then
  printf '%s\n' postgres redis quoteops-agent quoteops-api quoteops-web caddy
  exit 0
fi
url="${!#}"
case "$url" in
  http://127.0.0.1/api/health)
    printf '{"ok":true,"product_version":"%s"}\n' "${MOCK_INTERNAL_VERSION:-v0.2.0}"
    ;;
  http://127.0.0.1/api/setup-state)
    printf '{"activation":{"client_id":"smoke-client","installation_id":"smoke-installation"},"required_steps":[]}\n'
    ;;
  http://cloudflared:2000/metrics)
    printf 'cloudflared_tunnel_ha_connections %s\n' "${MOCK_TUNNEL_CONNECTIONS:-1}"
    ;;
  *)
    exit 1
    ;;
esac
SH
  chmod 755 "$mock_bin/docker"

  cat > "$mock_bin/curl" <<'SH'
#!/usr/bin/env bash
set -u
output=""
headers=""
config=""
url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output|--dump-header|--config)
      key="$1"
      value="${2:-}"
      case "$key" in
        --output) output="$value" ;;
        --dump-header) headers="$value" ;;
        --config) config="$value" ;;
      esac
      shift 2
      ;;
    https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
if [[ "${MOCK_CURL_MODE:-}" == "unreachable" ]]; then
  exit 28
fi
if [[ -z "$config" ]]; then
  case "${MOCK_CURL_MODE:-}" in
    public-401-no-evidence|public-403-no-evidence)
      if [[ -n "$headers" ]]; then
        printf 'HTTP/2 %s\nserver: quoteops-origin\n\n' \
          "${MOCK_CURL_MODE#public-}" | sed 's/-no-evidence//' > "$headers"
      fi
      if [[ "${MOCK_CURL_MODE:-}" == "public-401-no-evidence" ]]; then
        printf '401'
      else
        printf '403'
      fi
      exit 0
      ;;
  esac
  if [[ -n "$headers" ]]; then
    cat > "$headers" <<'EOF'
HTTP/2 302
server: cloudflare
cf-ray: smoke-ray
location: https://smoke.cloudflareaccess.com/cdn-cgi/access/login/quote.client.example

EOF
  fi
  if [[ "${MOCK_CURL_MODE:-}" == "public-200" ]]; then
    printf '200'
  else
    printf '302'
  fi
  exit 0
fi
case "$url" in
  */api/health)
    printf '{"ok":true,"product_version":"%s"}\n' "${MOCK_AUTH_VERSION:-v0.2.0}" > "$output"
    ;;
  */api/setup-state)
    if [[ "${MOCK_CURL_MODE:-}" == "setup-timeout" ]]; then
      exec sleep 30
    fi
    printf '{"activation":{"client_id":"%s","installation_id":"%s"},"required_steps":[]}\n' \
      "${MOCK_AUTH_CLIENT_ID:-smoke-client}" \
      "${MOCK_AUTH_INSTALLATION_ID:-smoke-installation}" > "$output"
    ;;
  *)
    exit 1
    ;;
esac
printf '200'
SH
  chmod 755 "$mock_bin/curl"

  reset_access_secret() {
    rm -f "$gate_home/settings/cloudflare-public-validation.json"
    cat > "$gate_home/secrets/cloudflare-access-validation.env" <<'EOF'
CF_ACCESS_CLIENT_ID=smoke-service-id.access
CF_ACCESS_CLIENT_SECRET=smoke-service-secret
EOF
    chmod 600 "$gate_home/secrets/cloudflare-access-validation.env"
  }

  reset_access_secret
  output="$(
    PATH="$mock_bin:$PATH" QUOTEOPS_HOME="$gate_home" \
      bash "$APPLIANCE_DIR/verify-install.sh" --resume-guided
  )" || fail "Cloudflare verifier rejected a matching protected origin"
  jq -e '.status == "ready" and .checks.authenticated_origin == "ok"' <<<"$output" >/dev/null ||
    fail "Cloudflare verifier did not emit the ready JSON contract"
  [[ ! -e "$gate_home/secrets/cloudflare-access-validation.env" ]] ||
    fail "Cloudflare verifier retained Service Auth credentials after success"
  [[ -f "$gate_home/settings/cloudflare-public-validation.json" ]] ||
    fail "Cloudflare verifier did not persist the safe validation receipt"
  if grep -Eq 'smoke-service-id|smoke-service-secret|CF_ACCESS' \
      "$gate_home/settings/cloudflare-public-validation.json" ||
    grep -Eq 'smoke-service-id|smoke-service-secret|CF_ACCESS' <<<"$output"; then
    fail "Cloudflare validation receipt or output contains Service Auth credentials"
  fi

  output="$(
    PATH="$mock_bin:$PATH" QUOTEOPS_HOME="$gate_home" \
      bash "$APPLIANCE_DIR/verify-install.sh" --resume-guided
  )" || fail "Cloudflare verifier could not safely retry after response loss"
  jq -e '.status == "ready"' <<<"$output" >/dev/null ||
    fail "safe validation receipt retry did not remain ready"

  reset_access_secret
  set +e
  output="$(
    PATH="$mock_bin:$PATH" QUOTEOPS_HOME="$gate_home" \
      MOCK_AUTH_CLIENT_ID=wrong-client \
      bash "$APPLIANCE_DIR/verify-install.sh" --resume-guided
  )"
  result=$?
  set -e
  [[ "$result" -eq 18 && -e "$gate_home/secrets/cloudflare-access-validation.env" ]] ||
    fail "wrong authenticated origin did not fail closed and retain resume credentials"

  reset_access_secret
  set +e
  output="$(
    PATH="$mock_bin:$PATH" QUOTEOPS_HOME="$gate_home" \
      MOCK_AUTH_VERSION=v9.9.9 \
      bash "$APPLIANCE_DIR/verify-install.sh" --resume-guided
  )"
  result=$?
  set -e
  [[ "$result" -eq 18 ]] || fail "wrong authenticated public version did not return 18"

  reset_access_secret
  set +e
  output="$(
    PATH="$mock_bin:$PATH" QUOTEOPS_HOME="$gate_home" \
      MOCK_AUTH_INSTALLATION_ID=wrong-installation \
      bash "$APPLIANCE_DIR/verify-install.sh" --resume-guided
  )"
  result=$?
  set -e
  [[ "$result" -eq 18 ]] || fail "wrong authenticated installation did not return 18"

  reset_access_secret
  set +e
  output="$(
    PATH="$mock_bin:$PATH" QUOTEOPS_HOME="$gate_home" \
      QUOTEOPS_VERIFY_TEST_MODE=invalid \
      bash "$APPLIANCE_DIR/verify-install.sh" --resume-guided
  )"
  result=$?
  set -e
  [[ "$result" -eq 18 &&
     ! -e "$gate_home/secrets/cloudflare-access-validation.env" ]] ||
    fail "unbounded Access ownership test exception did not fail closed"

  reset_access_secret
  set +e
  output="$(
    PATH="$mock_bin:$PATH" QUOTEOPS_HOME="$gate_home" \
      MOCK_CURL_MODE=public-200 \
      bash "$APPLIANCE_DIR/verify-install.sh" --resume-guided
  )"
  result=$?
  set -e
  [[ "$result" -eq 15 ]] || fail "anonymous public 200 was not treated as a security failure"

  for anonymous_mode in public-401-no-evidence public-403-no-evidence; do
    reset_access_secret
    set +e
    output="$(
      PATH="$mock_bin:$PATH" QUOTEOPS_HOME="$gate_home" \
        MOCK_CURL_MODE="$anonymous_mode" \
        bash "$APPLIANCE_DIR/verify-install.sh" --resume-guided
    )"
    result=$?
    set -e
    [[ "$result" -eq 15 ]] ||
      fail "anonymous ${anonymous_mode#public-} without Cloudflare evidence did not return 15"
  done

  reset_access_secret
  set +e
  output="$(
    PATH="$mock_bin:$PATH" QUOTEOPS_HOME="$gate_home" \
      MOCK_TUNNEL_CONNECTIONS=0 \
      bash "$APPLIANCE_DIR/verify-install.sh" --resume-guided
  )"
  result=$?
  set -e
  [[ "$result" -eq 13 ]] || fail "zero tunnel connections did not return 13"

  reset_access_secret
  set +e
  output="$(
    PATH="$mock_bin:$PATH" QUOTEOPS_HOME="$gate_home" \
      MOCK_TUNNEL_CONNECTIONS=not-a-number \
      bash "$APPLIANCE_DIR/verify-install.sh" --resume-guided
  )"
  result=$?
  set -e
  [[ "$result" -eq 13 ]] || fail "malformed tunnel metrics did not return 13"

  reset_access_secret
  SECONDS=0
  set +e
  output="$(
    PATH="$mock_bin:$PATH" QUOTEOPS_HOME="$gate_home" \
      MOCK_CURL_MODE=setup-timeout \
      bash "$APPLIANCE_DIR/verify-install.sh" --resume-guided
  )"
  result=$?
  set -e
  [[ "$result" -eq 18 && "$SECONDS" -le 8 ]] ||
    fail "authenticated setup-state timeout was not bounded"

  set +e
  output="$(
    PATH="$mock_bin:$PATH" QUOTEOPS_HOME="$gate_home" \
      MOCK_CURL_MODE=unreachable \
      bash "$APPLIANCE_DIR/verify-install.sh" --resume-guided
  )"
  result=$?
  set -e
  [[ "$result" -eq 14 ]] || fail "never-resolving public probe did not return 14"
  unset QUOTEOPS_VERIFY_TEST_MODE
}

validate_human_simulator_fixture
validate_cloudflare_gate

validate_schema_sql_with_postgres() {
  local schema_test_dir
  local schema_sql_file
  local container_name
  local postgres_db
  local postgres_user
  local postgres_password
  local ready
  local constraint_def

  schema_test_dir="$(mktemp -d "${TMPDIR:-/tmp}/quoteops-schema-smoke.XXXXXX")"
  TEMP_DIRS+=("$schema_test_dir")
  schema_sql_file="$schema_test_dir/schema.sql"

  (
    cd "$REPO_DIR"
    npx --no-install tsx -e 'import { schemaSql } from "./apps/api/src/storage/schema.ts"; process.stdout.write(schemaSql);'
  ) > "$schema_sql_file"

  container_name="quoteops-schema-smoke-$$-${RANDOM}"
  postgres_db="quoteops_schema_smoke"
  postgres_user="quoteops_schema_smoke"
  postgres_password="quoteops-schema-smoke-password"
  docker run \
    --detach \
    --name "$container_name" \
    --network none \
    --env POSTGRES_DB="$postgres_db" \
    --env POSTGRES_USER="$postgres_user" \
    --env POSTGRES_PASSWORD="$postgres_password" \
    postgres:16-alpine >/dev/null
  POSTGRES_CONTAINERS+=("$container_name")

  ready=0
  for _ in {1..30}; do
    # The image entrypoint's temporary bootstrap server can answer pg_isready
    # before POSTGRES_DB exists, then shut down before the next command. It can
    # also create POSTGRES_DB before that shutdown, so require both the final
    # PID 1 postgres process and a query against the requested database.
    if docker exec "$container_name" sh -c '[ "$(cat /proc/1/comm)" = postgres ]' >/dev/null 2>&1 && \
      docker exec "$container_name" psql -X -v ON_ERROR_STOP=1 -qAt \
      -U "$postgres_user" -d "$postgres_db" -c 'select 1' 2>/dev/null | grep -q '^1$'; then
      ready=1
      break
    fi
    sleep 1
  done
  [[ "$ready" == "1" ]] || fail "postgres schema smoke did not accept a SQL query against target database $postgres_db after 30 seconds"

  docker exec -i --env PGOPTIONS='-c client_min_messages=warning' "$container_name" psql -v ON_ERROR_STOP=1 -U "$postgres_user" -d "$postgres_db" < "$schema_sql_file" >/dev/null
  docker exec -i --env PGOPTIONS='-c client_min_messages=warning' "$container_name" psql -v ON_ERROR_STOP=1 -U "$postgres_user" -d "$postgres_db" < "$schema_sql_file" >/dev/null

  constraint_def="$(
    docker exec "$container_name" psql -At -U "$postgres_user" -d "$postgres_db" -c \
      "select pg_get_constraintdef(c.oid)
       from pg_constraint c
       join pg_class t on t.oid = c.conrelid
       join pg_namespace n on n.oid = t.relnamespace
       where n.nspname = 'public'
         and t.relname = 'client_tms_configs'
         and c.contype = 'c'
         and pg_get_constraintdef(c.oid) like '%runtime_ai_calls_allowed = false%';"
  )"
  [[ "$constraint_def" == *"runtime_ai_calls_allowed = false"* ]] || fail "runtime_ai_calls_allowed false check missing in postgres schema"
}

for script in bootstrap.sh install.sh quoteops.sh verify-install.sh upgrade.sh backup.sh restore.sh secrets.sh entrypoint.sh tests/smoke.sh; do
  bash -n "$APPLIANCE_DIR/$script"
done

grep -q 'create table if not exists schema_migrations' "$SCHEMA_FILE" || fail "schema_migrations schema missing"
grep -q 'create table if not exists appliance_license' "$SCHEMA_FILE" || fail "appliance_license schema missing"
grep -q 'create table if not exists client_tms_configs' "$SCHEMA_FILE" || fail "client_tms_configs schema missing"
grep -q 'runtime_ai_calls_allowed boolean not null default false check (runtime_ai_calls_allowed = false),' "$SCHEMA_FILE" || fail "runtime_ai_calls_allowed false schema constraint missing"
grep -q 'create table if not exists tms_schema_drift_events' "$SCHEMA_FILE" || fail "tms_schema_drift_events schema missing"
grep -q 'create table if not exists knowledge_documents' "$SCHEMA_FILE" || fail "knowledge_documents schema missing"
grep -q 'unique (document_id, client_id)' "$SCHEMA_FILE" || fail "knowledge_documents client/document uniqueness missing"
grep -q 'foreign key (document_id, client_id) references knowledge_documents(document_id, client_id) on delete cascade' "$SCHEMA_FILE" || fail "knowledge_chunks client/document foreign key missing"
grep -q 'unique (document_id, chunk_index)' "$SCHEMA_FILE" || fail "knowledge_chunks document/chunk uniqueness missing"
grep -q 'create table if not exists knowledge_chunks' "$SCHEMA_FILE" || fail "knowledge_chunks schema missing"
grep -q 'create table if not exists knowledge_ingestion_jobs' "$SCHEMA_FILE" || fail "knowledge_ingestion_jobs schema missing"
grep -q 'image: ${QUOTEOPS_POSTGRES_IMAGE:?QUOTEOPS_POSTGRES_IMAGE is required}' "$COMPOSE_FILE" || fail "appliance compose must require the pinned PostgreSQL image"
[[ "$(grep -c 'platform: ${QUOTEOPS_PLATFORM:-linux/amd64}' "$COMPOSE_FILE")" == "4" ]] || fail "exactly four application services must pin linux/amd64"
[[ "$(grep -c 'path: ${QUOTEOPS_CLIENT_ENV_FILE:?QUOTEOPS_CLIENT_ENV_FILE is required}' "$COMPOSE_FILE")" == "4" ]] || fail "exactly four services must receive the client secret env"
[[ "$(grep -c 'QUOTEOPS_LICENSE_PATH: /opt/quoteops-v1/secrets/license.json' "$COMPOSE_FILE")" -ge 2 ]] || fail "appliance compose must wire QUOTEOPS_LICENSE_PATH to mounted secrets for agent and api"
[[ "$(grep -c 'QUOTEOPS_LICENSE_PUBLIC_KEY_PATH: /opt/quoteops-v1/secrets/license-public-key.pem' "$COMPOSE_FILE")" -ge 2 ]] || fail "appliance compose must wire QUOTEOPS_LICENSE_PUBLIC_KEY_PATH to mounted secrets for agent and api"
[[ "$(grep -c -- '- quoteops_secrets:/opt/quoteops-v1/secrets' "$COMPOSE_FILE")" -ge 3 ]] || fail "appliance compose must mount quoteops_secrets into agent, api and onboard"
awk '
  /^  quoteops-api:$/ { in_api = 1; next }
  in_api && /^  [A-Za-z0-9_.-]+:$/ { exit }
  in_api { print }
' "$COMPOSE_FILE" | grep -q 'QUOTEOPS_TMS_MAPPING_CONFIG_PATH: ${QUOTEOPS_TMS_MAPPING_CONFIG_PATH:-}' || fail "appliance compose must wire the TMS mapping path into quoteops-api"

if docker_daemon_available; then
  validate_schema_sql_with_postgres
else
  echo "smoke.sh: docker daemon not available; checked schema constraints by grep"
fi

expect_failure_without_required_args() {
  local script="$1"
  if bash "$APPLIANCE_DIR/$script" >/dev/null 2>&1; then
    fail "$script succeeded without required args"
  fi
}

expect_failure_without_required_args install.sh
expect_failure_without_required_args upgrade.sh
expect_failure_without_required_args backup.sh
expect_failure_without_required_args restore.sh

for script in install.sh upgrade.sh backup.sh restore.sh secrets.sh; do
  bash "$APPLIANCE_DIR/$script" --help >/dev/null
done
bash "$APPLIANCE_DIR/install.sh" --help | grep -q -- '--registration-token' || fail "install help missing registration token"
bash "$APPLIANCE_DIR/install.sh" --help | grep -q -- '--control-plane-url' || fail "install help missing control plane url"
bash "$APPLIANCE_DIR/install.sh" --help | grep -q -- '--no-pull' || fail "install help missing no-pull"
bash "$APPLIANCE_DIR/install.sh" --help | grep -q -- '--tms-mapping-config' || fail "install help missing TMS mapping config"

SECRET_TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/quoteops-secrets-smoke.XXXXXX")"
TEMP_DIRS+=("$SECRET_TEST_DIR")
printf '%s\n' "secret-value" | bash "$APPLIANCE_DIR/secrets.sh" \
  --home "$SECRET_TEST_DIR" \
  set INEGI_SAKBE_KEY --stdin >/dev/null
bash "$APPLIANCE_DIR/secrets.sh" --home "$SECRET_TEST_DIR" list | grep -q '^INEGI_SAKBE_KEY=set$' || fail "secrets.sh did not list stored key"
bash "$APPLIANCE_DIR/secrets.sh" --home "$SECRET_TEST_DIR" unset INEGI_SAKBE_KEY >/dev/null

INSTALL_GUARD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/quoteops-install-guard.XXXXXX")"
TEMP_DIRS+=("$INSTALL_GUARD_DIR")
INSTALL_MANIFEST="$INSTALL_GUARD_DIR/client-manifest.yaml"
INSTALL_CONNECTORS_SRC="$INSTALL_GUARD_DIR/connectors-src"
INSTALL_CONNECTORS_TARGET="$INSTALL_GUARD_DIR/connectors-target"
INSTALL_TMS_MAPPING="$INSTALL_GUARD_DIR/tms-mapping.json"
INSTALL_MAPPING_CONNECTORS_TARGET="$INSTALL_GUARD_DIR/mapping-connectors-target"
mkdir -p "$INSTALL_CONNECTORS_SRC/agent" "$INSTALL_CONNECTORS_SRC/tms" "$INSTALL_CONNECTORS_TARGET"
cat > "$INSTALL_MANIFEST" <<'YAML'
client_id: smoke
business_units: []
vehicle_profiles: []
cost_profiles: []
YAML
cat > "$INSTALL_CONNECTORS_SRC/agent/agent-config.yaml" <<'YAML'
model:
  provider: deterministic
  model_name: quote-core-preserver
authorization:
  tools:
    route.resolve:
      effect: read
      mode: allowed
    tms.searchHistorical:
      effect: read
      mode: allowed
    tms.writeQuoteResult:
      effect: write
      mode: allowed
    email.sendQuote:
      effect: send
      mode: approval_required
    approval.decide:
      effect: approve
      mode: approval_required
YAML
printf 'rfq_id,lane_id\nRFQ-1,LANE-1\n' > "$INSTALL_CONNECTORS_SRC/tms/rfqs.csv"
cat > "$INSTALL_TMS_MAPPING" <<'JSON'
{
  "client_id": "smoke",
  "endpoint_url": "https://tms.example.com/api",
  "auth_method": "api_key",
  "api_key_env": "TMS_API_KEY",
  "transport": "http",
  "mapping_engine": "jsonpath",
  "schema_hash": "sha256:smoke-v1",
  "mappings": {
    "routes": "$.routes[*]"
  },
  "mapping_json": {
    "routes": {
      "route_id": "routeId"
    }
  },
  "runtime_ai_calls_allowed": false
}
JSON

FRESH_VOLUME_MOCK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/quoteops-fresh-volume.XXXXXX")"
TEMP_DIRS+=("$FRESH_VOLUME_MOCK_DIR")
cat > "$FRESH_VOLUME_MOCK_DIR/docker" <<'SH'
#!/usr/bin/env bash
if [[ "$1" == "volume" && "${2:-}" == "inspect" ]]; then
  exit 1
fi
if [[ "$1" == "volume" && "${2:-}" == "ls" ]]; then
  exit 0
fi
exit 1
SH
chmod +x "$FRESH_VOLUME_MOCK_DIR/docker"

install_guard_run() {
  local home_dir="$1"
  shift
  PATH="$FRESH_VOLUME_MOCK_DIR:$PATH" bash "$APPLIANCE_DIR/install.sh" \
    --client smoke \
    --manifest "$INSTALL_MANIFEST" \
    --connectors "$INSTALL_CONNECTORS_SRC" \
    --connectors-dir "$INSTALL_CONNECTORS_TARGET" \
    --home "$home_dir" \
    --skip-start \
    --postgres-password test-password \
    "$@"
}

install_mapping_guard_run() {
  local home_dir="$1"
  shift
  PATH="$FRESH_VOLUME_MOCK_DIR:$PATH" bash "$APPLIANCE_DIR/install.sh" \
    --client smoke \
    --manifest "$INSTALL_MANIFEST" \
    --agent-config "$INSTALL_CONNECTORS_SRC/agent/agent-config.yaml" \
    --tms-mapping-config "$INSTALL_TMS_MAPPING" \
    --connectors-dir "$INSTALL_MAPPING_CONNECTORS_TARGET" \
    --home "$home_dir" \
    --skip-start \
    --postgres-password test-password \
    "$@"
}

install_guard_run "$INSTALL_GUARD_DIR/home-one" \
  --control-plane-url "https://quoteops.inducta.example" \
  --registration-token "registration-token-test" \
  --installation-id "smoke-install-001" \
  --tms-mapping-config "$INSTALL_TMS_MAPPING" >/dev/null
grep -q '^QUOTEOPS_CONTROL_PLANE_URL="https://quoteops.inducta.example"$' "$INSTALL_GUARD_DIR/home-one/.env" || fail "install.sh did not write control plane url"
grep -q '^QUOTEOPS_INSTALLATION_ID="smoke-install-001"$' "$INSTALL_GUARD_DIR/home-one/.env" || fail "install.sh did not write installation id"
grep -q '^QUOTEOPS_REGISTRATION_TOKEN="registration-token-test"$' "$INSTALL_GUARD_DIR/home-one/secrets/client.env" || fail "install.sh did not write registration token to secrets"
if grep -q 'registration-token-test' "$INSTALL_GUARD_DIR/home-one/.env"; then
  fail "install.sh wrote registration token to main env"
fi
grep -q '^QUOTEOPS_TMS_MAPPING_CONFIG_PATH="/opt/quoteops-v1/connectors/tms-mapping.json"$' "$INSTALL_GUARD_DIR/home-one/.env" || fail "install.sh did not write TMS mapping config path"
cmp -s "$INSTALL_TMS_MAPPING" "$INSTALL_CONNECTORS_TARGET/tms-mapping.json" || fail "install.sh did not copy TMS mapping config"
[[ "$(file_mode "$INSTALL_CONNECTORS_TARGET/tms-mapping.json")" == "600" ]] || fail "install.sh did not protect TMS mapping config"
install_mapping_guard_run "$INSTALL_GUARD_DIR/home-mapping-one" >/dev/null
rm -f "$INSTALL_MAPPING_CONNECTORS_TARGET/agent/agent-config.yaml"
if install_mapping_guard_run "$INSTALL_GUARD_DIR/home-mapping-two" >"$INSTALL_GUARD_DIR/mapping-guard.log" 2>&1; then
  fail "install.sh overwrote TMS mapping config without --force"
fi
grep -q 'TMS mapping config copy already exists' "$INSTALL_GUARD_DIR/mapping-guard.log" || fail "install.sh did not identify the TMS mapping overwrite guard"
install_mapping_guard_run "$INSTALL_GUARD_DIR/home-mapping-force" --force >/dev/null
rm -f "$INSTALL_CONNECTORS_TARGET/agent/agent-config.yaml"
printf 'rfq_id,lane_id\nRFQ-2,LANE-2\n' > "$INSTALL_CONNECTORS_SRC/tms/rfqs.csv"
if install_guard_run "$INSTALL_GUARD_DIR/home-two" >/dev/null 2>&1; then
  fail "install.sh overwrote connector pack files without --force"
fi
install_guard_run "$INSTALL_GUARD_DIR/home-three" --force >/dev/null
grep -q '^RFQ-2,LANE-2$' "$INSTALL_CONNECTORS_TARGET/tms/rfqs.csv" || fail "install.sh --force did not replace connector pack file"

GUIDED_TOKEN_FILE="$INSTALL_GUARD_DIR/guided-token"
printf '%s' "guided-token-0123456789abcdefghijklmnop" > "$GUIDED_TOKEN_FILE"
chmod 600 "$GUIDED_TOKEN_FILE"
GUIDED_PASSWORD_LOG="$INSTALL_GUARD_DIR/guided-password.log"
if bash "$APPLIANCE_DIR/install.sh" \
  --client smoke \
  --manifest "$INSTALL_MANIFEST" \
  --connectors "$INSTALL_CONNECTORS_SRC" \
  --home "$INSTALL_GUARD_DIR/guided-password-home" \
  --skip-start \
  --version v0.2.0 \
  --registration-token-file "$GUIDED_TOKEN_FILE" \
  --postgres-password guided-password-must-not-enter \
  --guided >"$GUIDED_PASSWORD_LOG" 2>&1; then
  fail "guided install accepted --postgres-password"
fi
grep -q -- '--postgres-password is forbidden with --guided' "$GUIDED_PASSWORD_LOG" ||
  fail "guided install did not identify forbidden password ingress"
if grep -q 'guided-password-must-not-enter' "$GUIDED_PASSWORD_LOG"; then
  fail "guided password value reached log output"
fi

GUIDED_INHERITED_LOG="$INSTALL_GUARD_DIR/guided-inherited-password.log"
if POSTGRES_PASSWORD=inherited-password-must-not-enter \
  bash "$APPLIANCE_DIR/install.sh" \
    --client smoke \
    --manifest "$INSTALL_MANIFEST" \
    --connectors "$INSTALL_CONNECTORS_SRC" \
    --home "$INSTALL_GUARD_DIR/guided-inherited-home" \
    --skip-start \
    --version v0.2.0 \
    --registration-token-file "$GUIDED_TOKEN_FILE" \
    --guided >"$GUIDED_INHERITED_LOG" 2>&1; then
  fail "guided install accepted inherited POSTGRES_PASSWORD"
fi
grep -q 'inherited POSTGRES_PASSWORD is forbidden with --guided' "$GUIDED_INHERITED_LOG" ||
  fail "guided install did not identify inherited password ingress"
if grep -q 'inherited-password-must-not-enter' "$GUIDED_INHERITED_LOG"; then
  fail "inherited guided password value reached log output"
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  LOGICAL_TMPDIR="${TMPDIR:-/tmp}"
  PHYSICAL_TMPDIR="$(cd "$LOGICAL_TMPDIR" && pwd -P)"
  case "$PHYSICAL_TMPDIR" in
    /private/var/*) LOGICAL_TMPDIR="${PHYSICAL_TMPDIR#/private}" ;;
  esac
  E2E_ROOT="$(mktemp -d "$LOGICAL_TMPDIR/quoteops-mac-e2e.XXXXXX")"
  LOGICAL_E2E_ROOT="$E2E_ROOT"
  E2E_ROOT="$(cd "$E2E_ROOT" && pwd -P)"
  TEMP_DIRS+=("$E2E_ROOT")
  TEST_HOME="$E2E_ROOT/quoteops-v1"
  TEST_BIN_DIR="$E2E_ROOT/usr-local-bin"
  TEST_TOKEN_FILE="$E2E_ROOT/registration-token"
  TEST_REGISTRATION_TOKEN="registration-token-test-0123456789abcdef"
  printf '%s' "$TEST_REGISTRATION_TOKEN" > "$TEST_TOKEN_FILE"
  chmod 600 "$TEST_TOKEN_FILE"

  BOOTSTRAP_MOCK_DIR="$E2E_ROOT/bootstrap-mocks"
  mkdir -p "$BOOTSTRAP_MOCK_DIR"
  cat > "$BOOTSTRAP_MOCK_DIR/docker" <<'SH'
#!/usr/bin/env bash
if [[ "$1" == "volume" && "${2:-}" == "inspect" ]]; then
  exit 1
fi
if [[ "$1" == "volume" && "${2:-}" == "ls" ]]; then
  exit 0
fi
exit 0
SH
  cat > "$BOOTSTRAP_MOCK_DIR/curl" <<'SH'
#!/usr/bin/env bash
output=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--output" ]]; then
    output="$2"
    shift 2
  else
    shift
  fi
done
[[ -n "$output" ]] || exit 1
printf '#!/usr/bin/env bash\nexit 0\n' > "$output"
SH
  chmod +x "$BOOTSTRAP_MOCK_DIR/docker" "$BOOTSTRAP_MOCK_DIR/curl"

  BOOTSTRAP_PASS_LOG="$E2E_ROOT/bootstrap-alias-pass.log"
  TMPDIR="$LOGICAL_TMPDIR" PATH="$BOOTSTRAP_MOCK_DIR:$PATH" \
    QUOTEOPS_BOOTSTRAP_TEST_MODE=macbook \
    QUOTEOPS_AUTOMATION_MODE=1 \
    QUOTEOPS_HOME="$LOGICAL_E2E_ROOT/quoteops-v1" \
    QUOTEOPS_REGISTRATION_TOKEN_FILE="$TEST_TOKEN_FILE" \
    QUOTEOPS_CONTROL_PLANE_URL="https://control.quoteops.example" \
    bash "$APPLIANCE_DIR/bootstrap.sh" >"$BOOTSTRAP_PASS_LOG" 2>&1 ||
    fail "bootstrap rejected the /var to /private/var physical alias"
  case "$LOGICAL_E2E_ROOT:$E2E_ROOT" in
    /var/*:/private/var/*) ;;
    *) fail "bootstrap alias fixture did not exercise /var to /private/var" ;;
  esac

  WRONG_PREFIX_ROOT="$LOGICAL_TMPDIR/not-quoteops-mac-e2e.$$"
  mkdir -p "$WRONG_PREFIX_ROOT"
  TEMP_DIRS+=("$WRONG_PREFIX_ROOT")
  WRONG_PREFIX_LOG="$E2E_ROOT/bootstrap-wrong-prefix.log"
  if TMPDIR="$LOGICAL_TMPDIR" PATH="$BOOTSTRAP_MOCK_DIR:$PATH" \
    QUOTEOPS_BOOTSTRAP_TEST_MODE=macbook \
    QUOTEOPS_AUTOMATION_MODE=1 \
    QUOTEOPS_HOME="$WRONG_PREFIX_ROOT/quoteops-v1" \
    QUOTEOPS_REGISTRATION_TOKEN_FILE="$TEST_TOKEN_FILE" \
    QUOTEOPS_CONTROL_PLANE_URL="https://control.quoteops.example" \
    bash "$APPLIANCE_DIR/bootstrap.sh" >"$WRONG_PREFIX_LOG" 2>&1; then
    fail "bootstrap accepted a wrong-prefix Mac test root"
  fi
  grep -q 'bounded temporary QUOTEOPS_HOME' "$WRONG_PREFIX_LOG" ||
    fail "bootstrap wrong-prefix rejection was not deterministic"

  HOME_DIRECTORY_LOG="$E2E_ROOT/bootstrap-home-directory.log"
  if TMPDIR="$LOGICAL_TMPDIR" PATH="$BOOTSTRAP_MOCK_DIR:$PATH" \
    QUOTEOPS_BOOTSTRAP_TEST_MODE=macbook \
    QUOTEOPS_AUTOMATION_MODE=1 \
    QUOTEOPS_HOME="$HOME" \
    QUOTEOPS_REGISTRATION_TOKEN_FILE="$TEST_TOKEN_FILE" \
    QUOTEOPS_CONTROL_PLANE_URL="https://control.quoteops.example" \
    bash "$APPLIANCE_DIR/bootstrap.sh" >"$HOME_DIRECTORY_LOG" 2>&1; then
    fail "bootstrap accepted a home directory as Mac test root"
  fi
  grep -q 'bounded temporary QUOTEOPS_HOME' "$HOME_DIRECTORY_LOG" ||
    fail "bootstrap home-directory rejection was not deterministic"

  SYMLINK_ROOT="$LOGICAL_TMPDIR/quoteops-mac-e2e.symlink.$$"
  ln -s "$E2E_ROOT" "$SYMLINK_ROOT"
  TEMP_DIRS+=("$SYMLINK_ROOT")
  SYMLINK_LOG="$E2E_ROOT/bootstrap-symlink.log"
  if TMPDIR="$LOGICAL_TMPDIR" PATH="$BOOTSTRAP_MOCK_DIR:$PATH" \
    QUOTEOPS_BOOTSTRAP_TEST_MODE=macbook \
    QUOTEOPS_AUTOMATION_MODE=1 \
    QUOTEOPS_HOME="$SYMLINK_ROOT/quoteops-v1" \
    QUOTEOPS_REGISTRATION_TOKEN_FILE="$TEST_TOKEN_FILE" \
    QUOTEOPS_CONTROL_PLANE_URL="https://control.quoteops.example" \
    bash "$APPLIANCE_DIR/bootstrap.sh" >"$SYMLINK_LOG" 2>&1; then
    fail "bootstrap accepted a below-root symlink escape"
  fi
  grep -q 'rejects symlinks below the temporary root' "$SYMLINK_LOG" ||
    fail "bootstrap symlink rejection was not deterministic"

  PATH="$BOOTSTRAP_MOCK_DIR:$PATH" \
    QUOTEOPS_BOOTSTRAP_TEST_MODE=macbook QUOTEOPS_BIN_DIR="$TEST_BIN_DIR" \
    bash "$APPLIANCE_DIR/install.sh" \
      --client smoke \
      --manifest "$INSTALL_MANIFEST" \
      --connectors "$INSTALL_CONNECTORS_SRC" \
      --home "$TEST_HOME" \
      --skip-start \
      --version v0.2.0 \
      --postgres-password stable-postgres-password \
      --control-plane-url "https://quoteops.inducta.example" \
      --registration-token-file "$TEST_TOKEN_FILE" \
      --installation-id smoke-install-001 >/dev/null

  test -d "$TEST_HOME/releases/v0.2.0" || fail "release directory was not installed"
  test -L "$TEST_HOME/current" || fail "current release link was not installed"
  test "$(readlink "$TEST_HOME/current")" = "$TEST_HOME/releases/v0.2.0" || fail "current release link target is not absolute and pinned"
  test -x "$TEST_HOME/current/quoteops.sh" || fail "release-local quoteops dispatcher is missing"
  test -x "$TEST_BIN_DIR/quoteops" || fail "stable quoteops wrapper is missing"
  test -d "$TEST_HOME/manifests" || fail "manifest data directory is missing"
  test -d "$TEST_HOME/connectors" || fail "connector data directory is missing"
  test -d "$TEST_HOME/secrets" || fail "secret data directory is missing"

  CLIENT_ENV_BEFORE="$(cat "$TEST_HOME/secrets/client.env")"
  CURRENT_BEFORE="$(readlink "$TEST_HOME/current")"
  SECOND_TOKEN_FILE="$E2E_ROOT/second-registration-token"
  printf '%s' "replacement-token-that-must-not-win-0123456789" > "$SECOND_TOKEN_FILE"
  chmod 600 "$SECOND_TOKEN_FILE"
  PATH="$BOOTSTRAP_MOCK_DIR:$PATH" \
    QUOTEOPS_BOOTSTRAP_TEST_MODE=macbook QUOTEOPS_BIN_DIR="$TEST_BIN_DIR" \
    bash "$APPLIANCE_DIR/install.sh" \
      --client smoke \
      --manifest "$INSTALL_MANIFEST" \
      --connectors "$INSTALL_CONNECTORS_SRC" \
      --home "$TEST_HOME" \
      --skip-start \
      --version v0.2.0 \
      --postgres-password replacement-password-that-must-not-win \
      --control-plane-url "https://quoteops.inducta.example" \
      --registration-token-file "$SECOND_TOKEN_FILE" \
      --installation-id smoke-install-001 >/dev/null
  test "$(cat "$TEST_HOME/secrets/client.env")" = "$CLIENT_ENV_BEFORE" || fail "idempotent install changed durable secrets"
  grep -q '^POSTGRES_PASSWORD="stable-postgres-password"$' "$TEST_HOME/secrets/client.env" || fail "install did not preserve PostgreSQL password"
  grep -q "^QUOTEOPS_REGISTRATION_TOKEN=\"$TEST_REGISTRATION_TOKEN\"$" "$TEST_HOME/secrets/client.env" || fail "install did not preserve registration token"
  if grep -Eq 'POSTGRES_PASSWORD|QUOTEOPS_REGISTRATION_TOKEN|stable-postgres-password|registration-token-test' "$TEST_HOME/.env"; then
    fail "shared env contains a password or registration token"
  fi

  OTHER_MANIFEST="$E2E_ROOT/other-client-manifest.yaml"
  sed 's/^client_id: smoke$/client_id: other/' "$INSTALL_MANIFEST" > "$OTHER_MANIFEST"
  if QUOTEOPS_BOOTSTRAP_TEST_MODE=macbook QUOTEOPS_BIN_DIR="$TEST_BIN_DIR" \
    bash "$APPLIANCE_DIR/install.sh" \
      --client other \
      --manifest "$OTHER_MANIFEST" \
      --connectors "$INSTALL_CONNECTORS_SRC" \
      --home "$TEST_HOME" \
      --skip-start \
      --version v0.2.0 \
      --postgres-password other-password >/dev/null 2>&1; then
    fail "install accepted a different client id for an existing appliance"
  fi
  test "$(readlink "$TEST_HOME/current")" = "$CURRENT_BEFORE" || fail "client-id rejection modified current"
fi

MOCK_DOCKER_DIR="$(mktemp -d "${TMPDIR:-/tmp}/quoteops-mock-docker.XXXXXX")"
TEMP_DIRS+=("$MOCK_DOCKER_DIR")
MOCK_DOCKER_LOG="$MOCK_DOCKER_DIR/docker.log"
cat > "$MOCK_DOCKER_DIR/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_DOCKER_LOG"
if [[ "$*" == "compose version --short" ]]; then
  printf '%s\n' "2.24.0"
elif [[ "$1" == "volume" && "${2:-}" == "inspect" ]]; then
  if [[ "${MOCK_POSTGRES_VOLUME_STATE:-absent}" == "exists" &&
        "${3:-}" == "${COMPOSE_PROJECT_NAME:-quoteops_v1}_postgres_data" ]]; then
    exit 0
  fi
  exit 1
elif [[ "$1" == "volume" && "${2:-}" == "ls" ]]; then
  if [[ "${MOCK_POSTGRES_VOLUME_STATE:-absent}" == "unknown" ]]; then
    exit 1
  fi
  if [[ "${MOCK_POSTGRES_VOLUME_STATE:-absent}" == "exists" ]]; then
    printf '%s\n' "${COMPOSE_PROJECT_NAME:-quoteops_v1}_postgres_data"
  fi
fi
SH
chmod +x "$MOCK_DOCKER_DIR/docker"

for volume_state in exists unknown; do
  VOLUME_GUARD_HOME="$INSTALL_GUARD_DIR/volume-$volume_state-home"
  VOLUME_GUARD_LOG="$INSTALL_GUARD_DIR/volume-$volume_state.log"
  : > "$MOCK_DOCKER_LOG"
  if PATH="$MOCK_DOCKER_DIR:$PATH" MOCK_DOCKER_LOG="$MOCK_DOCKER_LOG" \
    MOCK_POSTGRES_VOLUME_STATE="$volume_state" \
    bash "$APPLIANCE_DIR/install.sh" \
      --client smoke \
      --manifest "$INSTALL_MANIFEST" \
      --connectors "$INSTALL_CONNECTORS_SRC" \
      --home "$VOLUME_GUARD_HOME" \
      --skip-start \
      --version v0.2.0 >"$VOLUME_GUARD_LOG" 2>&1; then
    fail "install generated a PostgreSQL password with volume state $volume_state"
  fi
  grep -q 'PostgreSQL data volume state' "$VOLUME_GUARD_LOG" ||
    fail "install did not fail closed for PostgreSQL volume state $volume_state"
  grep -q 'volume inspect quoteops_v1_postgres_data' "$MOCK_DOCKER_LOG" ||
    fail "install inspected the wrong Compose PostgreSQL volume name"
  if [[ -f "$VOLUME_GUARD_HOME/secrets/client.env" ]] &&
     grep -q '^POSTGRES_PASSWORD=' "$VOLUME_GUARD_HOME/secrets/client.env"; then
    fail "install generated a PostgreSQL password after unsafe volume state $volume_state"
  fi
done

EXPLICIT_VOLUME_HOME="$INSTALL_GUARD_DIR/volume-existing-explicit-home"
EXPLICIT_VOLUME_LOG="$INSTALL_GUARD_DIR/volume-existing-explicit.log"
: > "$MOCK_DOCKER_LOG"
if PATH="$MOCK_DOCKER_DIR:$PATH" MOCK_DOCKER_LOG="$MOCK_DOCKER_LOG" \
  MOCK_POSTGRES_VOLUME_STATE=exists \
  bash "$APPLIANCE_DIR/install.sh" \
    --client smoke \
    --manifest "$INSTALL_MANIFEST" \
    --connectors "$INSTALL_CONNECTORS_SRC" \
    --home "$EXPLICIT_VOLUME_HOME" \
    --skip-start \
    --version v0.2.0 \
    --postgres-password explicit-password-must-not-enter \
    >"$EXPLICIT_VOLUME_LOG" 2>&1; then
  fail "legacy install accepted an explicit password for an existing PostgreSQL volume"
fi
grep -q 'PostgreSQL data volume state is existing' "$EXPLICIT_VOLUME_LOG" ||
  fail "legacy explicit-password install did not fail closed on existing PostgreSQL volume"
if grep -q 'explicit-password-must-not-enter' "$EXPLICIT_VOLUME_LOG"; then
  fail "legacy explicit PostgreSQL password reached log output"
fi
if [[ -f "$EXPLICIT_VOLUME_HOME/secrets/client.env" ]] &&
   grep -q '^POSTGRES_PASSWORD=' "$EXPLICIT_VOLUME_HOME/secrets/client.env"; then
  fail "legacy explicit password was written despite an existing PostgreSQL volume"
fi

VOLUME_ABSENT_HOME="$INSTALL_GUARD_DIR/volume-absent-home"
VOLUME_ABSENT_LOG="$INSTALL_GUARD_DIR/volume-absent.log"
: > "$MOCK_DOCKER_LOG"
PATH="$MOCK_DOCKER_DIR:$PATH" MOCK_DOCKER_LOG="$MOCK_DOCKER_LOG" \
  MOCK_POSTGRES_VOLUME_STATE=absent \
  bash "$APPLIANCE_DIR/install.sh" \
    --client smoke \
    --manifest "$INSTALL_MANIFEST" \
    --connectors "$INSTALL_CONNECTORS_SRC" \
    --home "$VOLUME_ABSENT_HOME" \
    --skip-start \
    --version v0.2.0 >"$VOLUME_ABSENT_LOG" 2>&1
grep -Eq '^POSTGRES_PASSWORD="[a-f0-9]{64}"$' "$VOLUME_ABSENT_HOME/secrets/client.env" ||
  fail "known-absent PostgreSQL volume did not generate a cryptographic password"
ABSENT_CLIENT_ENV_BEFORE="$(cat "$VOLUME_ABSENT_HOME/secrets/client.env")"
PATH="$MOCK_DOCKER_DIR:$PATH" MOCK_DOCKER_LOG="$MOCK_DOCKER_LOG" \
  MOCK_POSTGRES_VOLUME_STATE=exists \
  bash "$APPLIANCE_DIR/install.sh" \
    --client smoke \
    --manifest "$INSTALL_MANIFEST" \
    --connectors "$INSTALL_CONNECTORS_SRC" \
    --home "$VOLUME_ABSENT_HOME" \
    --skip-start \
    --version v0.2.0 >/dev/null
test "$(cat "$VOLUME_ABSENT_HOME/secrets/client.env")" = "$ABSENT_CLIENT_ENV_BEFORE" ||
  fail "reinstall changed the generated PostgreSQL password"

NO_PULL_HOME="$INSTALL_GUARD_DIR/home-no-pull"
mkdir -p "$NO_PULL_HOME/secrets"
printf '%s\n' 'TUNNEL_TOKEN=smoke-tunnel-token' > "$NO_PULL_HOME/secrets/cloudflare.env"
chmod 600 "$NO_PULL_HOME/secrets/cloudflare.env"
run_no_pull_install() {
  PATH="$MOCK_DOCKER_DIR:$PATH" MOCK_DOCKER_LOG="$MOCK_DOCKER_LOG" \
    bash "$APPLIANCE_DIR/install.sh" \
    --client smoke \
    --manifest "$INSTALL_MANIFEST" \
    --connectors "$INSTALL_CONNECTORS_SRC" \
    --connectors-dir "$INSTALL_CONNECTORS_TARGET" \
    --home "$NO_PULL_HOME" \
    --postgres-password test-password \
    --force \
    --no-pull
}
run_no_pull_install >/dev/null
grep -q '^compose version$' "$MOCK_DOCKER_LOG" || fail "install.sh --no-pull did not validate Compose v2"
grep -q '^compose .* config$' "$MOCK_DOCKER_LOG" || fail "install.sh --no-pull did not validate compose config"
grep -q '^compose .* up -d$' "$MOCK_DOCKER_LOG" || fail "install.sh --no-pull did not start the stack"
if grep -q '^compose .* pull$' "$MOCK_DOCKER_LOG"; then
  fail "install.sh --no-pull unexpectedly pulled images"
fi

assert_tunnel_env_rejected() {
  local label="$1"
  local log="$INSTALL_GUARD_DIR/cloudflare-env-$label.log"
  if run_no_pull_install >"$log" 2>&1; then
    fail "install accepted $label cloudflare.env"
  fi
  grep -q 'cloudflare.env' "$log" ||
    fail "install did not identify rejected $label cloudflare.env"
}

printf '%s\n' \
  'TUNNEL_TOKEN=smoke-tunnel-token' \
  'TUNNEL_TOKEN=duplicate-token' > "$NO_PULL_HOME/secrets/cloudflare.env"
assert_tunnel_env_rejected duplicate
printf '%s\n' 'TUNNEL_TOKEN' > "$NO_PULL_HOME/secrets/cloudflare.env"
assert_tunnel_env_rejected malformed
printf '%s\n' 'TUNNEL_TOKEN=' > "$NO_PULL_HOME/secrets/cloudflare.env"
assert_tunnel_env_rejected empty
printf '%s\n' \
  'TUNNEL_TOKEN=smoke-tunnel-token' \
  'OPENROUTER_API_KEY=must-not-reach-cloudflared' > "$NO_PULL_HOME/secrets/cloudflare.env"
assert_tunnel_env_rejected extra-assignment

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/quoteops-appliance-smoke.XXXXXX")"
  TEMP_DIRS+=("$WORK_DIR")

  TEST_HOME="$WORK_DIR/home"
  mkdir -p "$WORK_DIR/manifests" "$WORK_DIR/criteria" "$WORK_DIR/connectors" "$WORK_DIR/logs" "$WORK_DIR/backups" "$WORK_DIR/secrets"
  mkdir -p \
    "$TEST_HOME/current" \
    "$TEST_HOME/manifests" \
    "$TEST_HOME/criteria" \
    "$TEST_HOME/connectors" \
    "$TEST_HOME/logs" \
    "$TEST_HOME/backups" \
    "$TEST_HOME/settings" \
    "$TEST_HOME/secrets"
  printf '%s\n' 'TUNNEL_TOKEN=dummy-smoke-token' > "$TEST_HOME/secrets/cloudflare.env"
  chmod 600 "$TEST_HOME/secrets/cloudflare.env"
  : > "$WORK_DIR/secrets/client.env"
  : > "$TEST_HOME/secrets/client.env"
  cat > "$WORK_DIR/connectors/tms-adapter.yaml" <<'YAML'
provider: file_import
rfqs_path_env: QUOTEOPS_TMS_RFQS_PATH
historical_quotes_path_env: QUOTEOPS_TMS_HISTORICAL_QUOTES_PATH
historical_shipments_path_env: QUOTEOPS_TMS_HISTORICAL_SHIPMENTS_PATH
customers_path_env: QUOTEOPS_TMS_CUSTOMERS_PATH
agreements_path_env: QUOTEOPS_TMS_AGREEMENTS_PATH
unit_positions_path_env: QUOTEOPS_TMS_UNIT_POSITIONS_PATH
quote_writebacks_path_env: QUOTEOPS_TMS_QUOTE_WRITEBACKS_PATH
status_writebacks_path_env: QUOTEOPS_TMS_STATUS_WRITEBACKS_PATH
YAML
  cp "$WORK_DIR/connectors/tms-adapter.yaml" "$TEST_HOME/connectors/tms-adapter.yaml"
  cat > "$TEST_HOME/.env" <<EOF
COMPOSE_PROJECT_NAME=quoteops_smoke
QUOTEOPS_CLIENT_ID=cliente-demo
QUOTEOPS_INSTALLATION_ID=smoke-installation
QUOTEOPS_CLIENT_ENV_FILE=$TEST_HOME/secrets/client.env
QUOTEOPS_CLOUDFLARE_ENV_FILE=$TEST_HOME/secrets/cloudflare.env
QUOTEOPS_MANIFEST_DIR=$TEST_HOME/manifests
QUOTEOPS_CRITERIA_DIR=$TEST_HOME/criteria
QUOTEOPS_CONNECTORS_DIR=$TEST_HOME/connectors
QUOTEOPS_SECRETS_DIR=$TEST_HOME/secrets
QUOTEOPS_LOG_DIR=$TEST_HOME/logs
QUOTEOPS_BACKUP_DIR=$TEST_HOME/backups
QUOTEOPS_SETTINGS_DIR=$TEST_HOME/settings
CADDYFILE_PATH=$APPLIANCE_DIR/Caddyfile
EOF
  cat > "$TEST_HOME/current/release.env" <<'EOF'
QUOTEOPS_VERSION=v0.2.0
QUOTEOPS_PLATFORM=linux/amd64
QUOTEOPS_AGENT_IMAGE=ghcr.io/alejandroc-bit/quote-ops-agent:v0.2.0@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
QUOTEOPS_API_IMAGE=ghcr.io/alejandroc-bit/quote-ops-api:v0.2.0@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
QUOTEOPS_WEB_IMAGE=ghcr.io/alejandroc-bit/quote-ops-web:v0.2.0@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
QUOTEOPS_POSTGRES_IMAGE=postgres:16-alpine@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
QUOTEOPS_REDIS_IMAGE=redis:7-alpine@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
QUOTEOPS_CADDY_IMAGE=caddy:2-alpine@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
QUOTEOPS_CLOUDFLARED_IMAGE=cloudflare/cloudflared:2026.7.3@sha256:e39ee8da81ad5e05d77f38d2f51c60ca51bf2a8450ac3abab50c17fdb91d91bf
EOF

  rendered="$(
    docker compose \
      --env-file "$TEST_HOME/.env" \
      --env-file "$TEST_HOME/current/release.env" \
      -f "$APPLIANCE_DIR/docker-compose.yml" \
      --profile tunnel \
      config --no-env-resolution
  )"
  grep -q 'cloudflare/cloudflared:2026.7.3@sha256:e39ee8da81ad5e05d77f38d2f51c60ca51bf2a8450ac3abab50c17fdb91d91bf' <<<"$rendered" ||
    fail "production compose is missing the pinned cloudflared image"
  grep -q 'TUNNEL_METRICS: 0.0.0.0:2000' <<<"$rendered" ||
    fail "production compose is missing internal cloudflared metrics"
  ! grep -qE 'published: "(80|443)"' <<<"$rendered" ||
    fail "production compose publishes Caddy ports"
  ! grep -q 'TUNNEL_TOKEN:' <<<"$rendered" ||
    fail "production compose interpolates TUNNEL_TOKEN"
  cloudflared_block="$(sed -n '/^  cloudflared:/,/^  [a-zA-Z0-9_-][a-zA-Z0-9_-]*:/p' <<<"$rendered")"
  ! grep -qE 'OPENROUTER|GEMINI|TMS_API_KEY|RESEND|SAKBE' <<<"$cloudflared_block" ||
    fail "cloudflared receives client application secrets"

  direct_rendered="$(
    docker compose \
      --env-file "$TEST_HOME/.env" \
      --env-file "$TEST_HOME/current/release.env" \
      -f "$APPLIANCE_DIR/docker-compose.yml" \
      -f "$APPLIANCE_DIR/docker-compose.direct.yml" \
      --profile tunnel \
      config --no-env-resolution
  )"
  grep -q 'host_ip: 127.0.0.1' <<<"$direct_rendered" ||
    fail "direct compose override is not loopback-only"
  ! grep -q 'host_ip: 0.0.0.0' <<<"$direct_rendered" ||
    fail "direct compose override publishes on all interfaces"

  compose_config() {
    QUOTEOPS_CLIENT_ID=cliente-demo \
    QUOTEOPS_VERSION=v2.0.0 \
    QUOTEOPS_PLATFORM=linux/amd64 \
    QUOTEOPS_AGENT_IMAGE=ghcr.io/alejandroc-bit/quote-ops-agent:v2.0.0 \
    QUOTEOPS_API_IMAGE=ghcr.io/alejandroc-bit/quote-ops-api:v2.0.0 \
    QUOTEOPS_WEB_IMAGE=ghcr.io/alejandroc-bit/quote-ops-web:v2.0.0 \
    QUOTEOPS_POSTGRES_IMAGE=postgres:16-alpine \
    QUOTEOPS_REDIS_IMAGE=redis:7-alpine \
    QUOTEOPS_CADDY_IMAGE=caddy:2-alpine \
    QUOTEOPS_CLOUDFLARED_IMAGE=cloudflare/cloudflared:2026.7.3 \
    QUOTEOPS_MANIFEST_DIR="$WORK_DIR/manifests" \
    QUOTEOPS_CRITERIA_DIR="$WORK_DIR/criteria" \
    QUOTEOPS_CONNECTORS_DIR="$WORK_DIR/connectors" \
    QUOTEOPS_CLIENT_ENV_FILE="$WORK_DIR/secrets/client.env" \
    QUOTEOPS_TMS_MAPPING_CONFIG_PATH=/opt/quoteops-v1/connectors/tms-mapping.json \
    QUOTEOPS_SAKBE_CACHE_MODE=cache_first \
    QUOTEOPS_LOG_DIR="$WORK_DIR/logs" \
    QUOTEOPS_BACKUP_DIR="$WORK_DIR/backups" \
    CADDYFILE_PATH="$APPLIANCE_DIR/Caddyfile" \
    POSTGRES_DB=quoteops \
    POSTGRES_USER=quoteops \
    POSTGRES_PASSWORD=test-password \
    docker compose "$@" config
  }

  COMPOSE_RENDERED="$(compose_config -f "$APPLIANCE_DIR/docker-compose.yml")"
  printf '%s\n' "$COMPOSE_RENDERED" | grep -q 'image: ghcr.io/alejandroc-bit/quote-ops-agent:v2.0.0' || fail "compose must render quote-ops-agent:v2.0.0"
  printf '%s\n' "$COMPOSE_RENDERED" | awk '
    /^  quoteops-api:$/ { in_api = 1; next }
    in_api && /^  [A-Za-z0-9_.-]+:$/ { exit }
    in_api { print }
  ' | grep -q 'QUOTEOPS_TMS_MAPPING_CONFIG_PATH: /opt/quoteops-v1/connectors/tms-mapping.json' || fail "compose must render the TMS mapping path for quoteops-api"
  compose_config -f "$APPLIANCE_DIR/docker-compose.yml" -f "$APPLIANCE_DIR/docker-compose.local.yml" >/dev/null
else
  echo "smoke.sh: docker compose not available; skipped compose config validation"
fi

echo "smoke.sh: ok"
