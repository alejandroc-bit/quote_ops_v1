#!/usr/bin/env bash
set -Eeuo pipefail

PREVIOUS_MANIFEST=""
CURRENT_MANIFEST=""
RUN_ID="quoteops-nminusone-$$-${RANDOM:-0}"
NETWORK="${RUN_ID}-network"
VOLUME="${RUN_ID}-postgres"
POSTGRES_CONTAINER="${RUN_ID}-postgres"
PREVIOUS_CONTAINER="${RUN_ID}-previous"
CURRENT_CONTAINER="${RUN_ID}-current"
DATABASE_PASSWORD="nminusone-${RANDOM:-0}-database-password"

fail() {
  printf 'n-minus-one-schema: failed\n' >&2
  exit 1
}

require_value() {
  [[ -n "${2:-}" && "${2:-}" != --* ]] || fail
}

cleanup() {
  case "$RUN_ID" in
    quoteops-nminusone-[0-9]*-*) ;;
    *) return ;;
  esac
  docker rm -f "$PREVIOUS_CONTAINER" "$CURRENT_CONTAINER" "$POSTGRES_CONTAINER" \
    >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --previous-manifest)
      require_value "$1" "${2:-}"
      PREVIOUS_MANIFEST="$2"
      shift 2
      ;;
    --current-manifest)
      require_value "$1" "${2:-}"
      CURRENT_MANIFEST="$2"
      shift 2
      ;;
    *)
      fail
      ;;
  esac
done

command -v docker >/dev/null 2>&1 || fail
command -v jq >/dev/null 2>&1 || fail
[[ -f "$PREVIOUS_MANIFEST" && ! -L "$PREVIOUS_MANIFEST" &&
   -f "$CURRENT_MANIFEST" && ! -L "$CURRENT_MANIFEST" ]] || fail

validate_manifest() {
  jq -e '
    type == "object" and
    keys == ["created_at","files_sha256","git_sha","images","platform","schema_version","version"] and
    .schema_version == 1 and
    (.version | type == "string" and test("^v[0-9]+[.][0-9]+[.][0-9]+$")) and
    (.git_sha | type == "string" and test("^[a-f0-9]{40}$")) and
    .platform == "linux/amd64" and
    (.created_at | type == "string") and
    (.images | type == "object" and
      keys == ["agent","api","caddy","cloudflared","postgres","redis","web"] and
      all(.[]; type == "string" and test("@sha256:[a-f0-9]{64}$"))) and
    (.files_sha256 | type == "object" and
      all(to_entries[]; (.key | type == "string") and
        (.value | type == "string" and test("^[a-f0-9]{64}$"))))
  ' "$1" >/dev/null
}
validate_manifest "$PREVIOUS_MANIFEST" || fail
validate_manifest "$CURRENT_MANIFEST" || fail

PREVIOUS_VERSION="$(jq -er '.version' "$PREVIOUS_MANIFEST")"
CURRENT_VERSION="$(jq -er '.version' "$CURRENT_MANIFEST")"
PREVIOUS_IMAGE="$(jq -er '.images.api' "$PREVIOUS_MANIFEST")"
CURRENT_IMAGE="$(jq -er '.images.api' "$CURRENT_MANIFEST")"
POSTGRES_IMAGE="$(jq -er '.images.postgres' "$CURRENT_MANIFEST")"
[[ "$PREVIOUS_IMAGE" == *":$PREVIOUS_VERSION@sha256:"* &&
   "$CURRENT_IMAGE" == *":$CURRENT_VERSION@sha256:"* &&
   "$POSTGRES_IMAGE" == *"postgres:16"* &&
   "$POSTGRES_IMAGE" == *"@sha256:"* ]] || fail
[[ "$PREVIOUS_VERSION" != "$CURRENT_VERSION" ]] || fail

docker network create "$NETWORK" >/dev/null
docker volume create "$VOLUME" >/dev/null
docker run -d \
  --name "$POSTGRES_CONTAINER" \
  --network "$NETWORK" \
  --network-alias postgres \
  -e POSTGRES_DB=quoteops \
  -e POSTGRES_USER=quoteops \
  -e "POSTGRES_PASSWORD=$DATABASE_PASSWORD" \
  -v "$VOLUME:/var/lib/postgresql/data" \
  "$POSTGRES_IMAGE" >/dev/null

for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
  if docker exec "$POSTGRES_CONTAINER" \
    pg_isready -U quoteops -d quoteops >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
docker exec "$POSTGRES_CONTAINER" \
  pg_isready -U quoteops -d quoteops >/dev/null 2>&1 || fail

start_api() {
  local container="$1"
  local image="$2"
  local version="$3"
  docker run -d \
    --name "$container" \
    --network "$NETWORK" \
    -e QUOTEOPS_SERVICE=api \
    -e "QUOTEOPS_VERSION=$version" \
    -e PORT=8080 \
    -e "DATABASE_URL=postgresql://quoteops:$DATABASE_PASSWORD@postgres:5432/quoteops" \
    "$image" >/dev/null
}

wait_for_api() {
  local container="$1"
  local version="$2"
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
    if docker exec "$container" node -e '
      const expected = process.argv[1];
      fetch("http://127.0.0.1:8080/api/health")
        .then(async (response) => {
          const body = await response.json();
          process.exit(response.status === 200 && body.ok === true &&
            body.product_version === expected ? 0 : 1);
        })
        .catch(() => process.exit(1));
    ' "$version" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

verify_application_seed_rows() {
  local container="$1"
  docker exec "$container" node -e '
    const { Pool } = require("pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    Promise.all([
      fetch("http://127.0.0.1:8080/api/rfqs").then((response) => response.json()),
      fetch("http://127.0.0.1:8080/api/runs").then((response) => response.json()),
      fetch("http://127.0.0.1:8080/api/health").then((response) => response.json()),
      import("./apps/api/dist/storage/PostgresKnowledgeRepository.js").then(
        ({ PostgresKnowledgeRepository }) =>
          new PostgresKnowledgeRepository({
            databaseUrl: process.env.DATABASE_URL
          }).countStatus("N1")
      ),
      pool.query(
        "select installation_id, client_id, license_payload, signature, status " +
        "from appliance_license where installation_id=$1",
        ["n1-installation"]
      )
    ]).then(([rfqs, runs, health, knowledge, licenseResult]) => {
      const workflow = rfqs.items?.some((item) => item.run_id === "n1-workflow");
      const quote = runs.runs?.some((item) => item.run_id === "n1-quote");
      const heartbeat = health.heartbeats === 1;
      const knowledgeRead =
        knowledge.knowledge_documents_count === 1 &&
        knowledge.knowledge_chunks_count === 0;
      const license = licenseResult.rows[0];
      const licenseRead =
        license?.installation_id === "n1-installation" &&
        license?.client_id === "N1" &&
        license?.license_payload?.client_id === "N1" &&
        license?.signature === "n1-signature" &&
        license?.status === "active";
      process.exit(
        workflow && quote && heartbeat && knowledgeRead && licenseRead ? 0 : 1
      );
    }).catch(() => process.exit(1)).finally(() => pool.end());
  ' >/dev/null 2>&1
}

verify_database_rows() {
  [[ "$(
    docker exec "$POSTGRES_CONTAINER" psql -At -U quoteops -d quoteops -c "
      select
        (select count(*) from workflow_runs where run_id='n1-workflow') +
        (select count(*) from quote_runs where run_id='n1-quote') +
        (select count(*) from heartbeats where installation_id='n1-installation') +
        (select count(*) from knowledge_documents where document_id='n1-knowledge') +
        (select count(*) from appliance_license where installation_id='n1-installation');
    "
  )" == 5 ]]
}

start_api "$PREVIOUS_CONTAINER" "$PREVIOUS_IMAGE" "$PREVIOUS_VERSION"
wait_for_api "$PREVIOUS_CONTAINER" "$PREVIOUS_VERSION" || fail
docker exec -i "$POSTGRES_CONTAINER" psql -v ON_ERROR_STOP=1 -U quoteops -d quoteops \
  >/dev/null <<'SQL'
insert into workflow_runs
  (run_id, client_id, rfq_id, status, approval_required, payload)
values
  ('n1-workflow','N1','n1-rfq','done',false,'{"run_id":"n1-workflow"}'::jsonb);
insert into quote_runs (run_id, channel, status, summary)
values ('n1-quote','email','done','N-1 representative quote');
insert into heartbeats
  (client_id, installation_id, version, payload, received_at)
values
  ('N1','n1-installation','v0.0.0','{"status":"ok"}'::jsonb,now());
insert into knowledge_documents
  (document_id, client_id, filename, content_type, checksum)
values
  ('n1-knowledge','N1','policy.md','text/markdown',repeat('a',64));
insert into appliance_license
  (installation_id, client_id, license_payload, signature, status)
values
  ('n1-installation','N1','{"client_id":"N1"}'::jsonb,'n1-signature','active');
SQL
verify_application_seed_rows "$PREVIOUS_CONTAINER" || fail
verify_database_rows || fail

docker rm -f "$PREVIOUS_CONTAINER" >/dev/null
start_api "$CURRENT_CONTAINER" "$CURRENT_IMAGE" "$CURRENT_VERSION"
wait_for_api "$CURRENT_CONTAINER" "$CURRENT_VERSION" || fail
verify_application_seed_rows "$CURRENT_CONTAINER" || fail
verify_database_rows || fail

docker rm -f "$CURRENT_CONTAINER" >/dev/null
start_api "$PREVIOUS_CONTAINER" "$PREVIOUS_IMAGE" "$PREVIOUS_VERSION"
wait_for_api "$PREVIOUS_CONTAINER" "$PREVIOUS_VERSION" || fail
verify_application_seed_rows "$PREVIOUS_CONTAINER" || fail
verify_database_rows || fail

printf 'n-minus-one-schema: %s -> %s compatible\n' \
  "$PREVIOUS_VERSION" "$CURRENT_VERSION"
