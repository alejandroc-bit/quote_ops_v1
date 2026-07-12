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
    if docker exec "$container_name" pg_isready -U "$postgres_user" -d "$postgres_db" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  [[ "$ready" == "1" ]] || fail "postgres schema smoke did not become ready"

  docker exec "$container_name" psql -At -U "$postgres_user" -d postgres -c \
    "select 1 from pg_database where datname = '$postgres_db';" | grep -q '^1$' ||
    docker exec "$container_name" createdb -U "$postgres_user" "$postgres_db"

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

for script in install.sh upgrade.sh backup.sh restore.sh secrets.sh entrypoint.sh tests/smoke.sh; do
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
grep -q 'image: postgres:16-alpine' "$COMPOSE_FILE" || fail "appliance compose must use postgres:16-alpine"
[[ "$(grep -c 'QUOTEOPS_LICENSE_PATH: /opt/quoteops-v1/secrets/license.json' "$COMPOSE_FILE")" -ge 2 ]] || fail "appliance compose must wire QUOTEOPS_LICENSE_PATH to mounted secrets for agent and api"
[[ "$(grep -c 'QUOTEOPS_LICENSE_PUBLIC_KEY_PATH: /opt/quoteops-v1/secrets/license-public-key.pem' "$COMPOSE_FILE")" -ge 2 ]] || fail "appliance compose must wire QUOTEOPS_LICENSE_PUBLIC_KEY_PATH to mounted secrets for agent and api"
[[ "$(grep -c -- '- quoteops_secrets:/opt/quoteops-v1/secrets' "$COMPOSE_FILE")" -ge 3 ]] || fail "appliance compose must mount quoteops_secrets into agent, api and onboard"

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
mkdir -p "$INSTALL_CONNECTORS_SRC/agent" "$INSTALL_CONNECTORS_SRC/tms" "$INSTALL_CONNECTORS_TARGET"
cat > "$INSTALL_MANIFEST" <<'YAML'
client_id: SMOKE
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

install_guard_run() {
  local home_dir="$1"
  shift
  bash "$APPLIANCE_DIR/install.sh" \
    --client smoke \
    --manifest "$INSTALL_MANIFEST" \
    --connectors "$INSTALL_CONNECTORS_SRC" \
    --connectors-dir "$INSTALL_CONNECTORS_TARGET" \
    --home "$home_dir" \
    --skip-start \
    --postgres-password test-password \
    "$@"
}

install_guard_run "$INSTALL_GUARD_DIR/home-one" \
  --control-plane-url "https://quoteops.inducta.example" \
  --registration-token "registration-token-test" \
  --installation-id "smoke-install-001" >/dev/null
grep -q '^QUOTEOPS_CONTROL_PLANE_URL="https://quoteops.inducta.example"$' "$INSTALL_GUARD_DIR/home-one/.env" || fail "install.sh did not write control plane url"
grep -q '^QUOTEOPS_INSTALLATION_ID="smoke-install-001"$' "$INSTALL_GUARD_DIR/home-one/.env" || fail "install.sh did not write installation id"
grep -q '^QUOTEOPS_REGISTRATION_TOKEN="registration-token-test"$' "$INSTALL_GUARD_DIR/home-one/secrets/client.env" || fail "install.sh did not write registration token to secrets"
if grep -q 'registration-token-test' "$INSTALL_GUARD_DIR/home-one/.env"; then
  fail "install.sh wrote registration token to main env"
fi
rm -f "$INSTALL_CONNECTORS_TARGET/agent/agent-config.yaml"
printf 'rfq_id,lane_id\nRFQ-2,LANE-2\n' > "$INSTALL_CONNECTORS_SRC/tms/rfqs.csv"
if install_guard_run "$INSTALL_GUARD_DIR/home-two" >/dev/null 2>&1; then
  fail "install.sh overwrote connector pack files without --force"
fi
install_guard_run "$INSTALL_GUARD_DIR/home-three" --force >/dev/null
grep -q '^RFQ-2,LANE-2$' "$INSTALL_CONNECTORS_TARGET/tms/rfqs.csv" || fail "install.sh --force did not replace connector pack file"

MOCK_DOCKER_DIR="$(mktemp -d "${TMPDIR:-/tmp}/quoteops-mock-docker.XXXXXX")"
TEMP_DIRS+=("$MOCK_DOCKER_DIR")
MOCK_DOCKER_LOG="$MOCK_DOCKER_DIR/docker.log"
cat > "$MOCK_DOCKER_DIR/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_DOCKER_LOG"
SH
chmod +x "$MOCK_DOCKER_DIR/docker"
PATH="$MOCK_DOCKER_DIR:$PATH" MOCK_DOCKER_LOG="$MOCK_DOCKER_LOG" \
  bash "$APPLIANCE_DIR/install.sh" \
    --client smoke-no-pull \
    --manifest "$INSTALL_MANIFEST" \
    --connectors "$INSTALL_CONNECTORS_SRC" \
    --connectors-dir "$INSTALL_CONNECTORS_TARGET" \
    --home "$INSTALL_GUARD_DIR/home-no-pull" \
    --postgres-password test-password \
    --force \
    --no-pull >/dev/null
grep -q '^compose version$' "$MOCK_DOCKER_LOG" || fail "install.sh --no-pull did not validate Compose v2"
grep -q '^compose .* config$' "$MOCK_DOCKER_LOG" || fail "install.sh --no-pull did not validate compose config"
grep -q '^compose .* up -d$' "$MOCK_DOCKER_LOG" || fail "install.sh --no-pull did not start the stack"
if grep -q '^compose .* pull$' "$MOCK_DOCKER_LOG"; then
  fail "install.sh --no-pull unexpectedly pulled images"
fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/quoteops-appliance-smoke.XXXXXX")"
  TEMP_DIRS+=("$WORK_DIR")

  mkdir -p "$WORK_DIR/manifests" "$WORK_DIR/criteria" "$WORK_DIR/connectors" "$WORK_DIR/logs" "$WORK_DIR/backups" "$WORK_DIR/secrets"
  : > "$WORK_DIR/secrets/client.env"
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
  compose_config() {
    QUOTEOPS_CLIENT_ID=cliente-demo \
    QUOTEOPS_VERSION=v2.0.0 \
    QUOTEOPS_IMAGE_REGISTRY=ghcr.io/alejandroc-bit \
    QUOTEOPS_MANIFEST_DIR="$WORK_DIR/manifests" \
    QUOTEOPS_CRITERIA_DIR="$WORK_DIR/criteria" \
    QUOTEOPS_CONNECTORS_DIR="$WORK_DIR/connectors" \
    QUOTEOPS_SECRETS_ENV_FILE="$WORK_DIR/secrets/client.env" \
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
  compose_config -f "$APPLIANCE_DIR/docker-compose.yml" -f "$APPLIANCE_DIR/docker-compose.local.yml" >/dev/null
else
  echo "smoke.sh: docker compose not available; skipped compose config validation"
fi

echo "smoke.sh: ok"
