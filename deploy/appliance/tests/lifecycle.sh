#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
APPLIANCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/quoteops-lifecycle.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

fail() {
  printf 'lifecycle.sh: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

mode_of() {
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

need jq
need tar
need awk

MOCK_BIN="$WORK_DIR/bin"
APPLIANCE_HOME="$WORK_DIR/quoteops-v1"
CALLER_ACCESS_FILE="$WORK_DIR/caller-cloudflare-access.env"
COMMAND_LOG="$WORK_DIR/commands.log"
mkdir -p \
  "$MOCK_BIN" \
  "$APPLIANCE_HOME/releases/v0.2.0" \
  "$APPLIANCE_HOME/backups" \
  "$APPLIANCE_HOME/manifests" \
  "$APPLIANCE_HOME/criteria" \
  "$APPLIANCE_HOME/connectors" \
  "$APPLIANCE_HOME/settings" \
  "$APPLIANCE_HOME/state" \
  "$APPLIANCE_HOME/secrets" \
  "$APPLIANCE_HOME/evidence" \
  "$APPLIANCE_HOME/onboard-input"

cat >"$MOCK_BIN/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == compose && " $* " != *" compose version "* ]]; then
  [[ " $* " == *" --env-file $QUOTEOPS_HOME/.env "* ]] || exit 31
  [[ " $* " == *" --env-file $QUOTEOPS_HOME/releases/"*"/release.env "* ]] || exit 32
fi
case " $* " in
  *" compose version "*) printf '%s\n' compose-version >>"$LIFECYCLE_LOG"; printf '%s\n' '2.24.0' ;;
  *" config "*) printf '%s\n' compose-config >>"$LIFECYCLE_LOG" ;;
  *" pg_dump "*) printf '%s\n' backup >>"$LIFECYCLE_LOG"; printf '%s\n' '-- ORIGINAL_DATABASE' ;;
  *" pull "*) printf '%s\n' pull >>"$LIFECYCLE_LOG" ;;
  *" up "*)
    [[ " $* " == *" --profile tunnel "* ]] || exit 33
    printf '%s\n' up >>"$LIFECYCLE_LOG"
    ;;
  *" stop "*) printf '%s\n' stop >>"$LIFECYCLE_LOG" ;;
  *" psql "*)
    input="$(cat)"
    if [[ "$input" == *RESTORE_TARGET* && "${LIFECYCLE_FAIL_RESTORE_IMPORT:-0}" == 1 ]]; then
      printf '%s\n' partial >"$LIFECYCLE_DB_STATE"
      printf '%s\n' partial-import >>"$LIFECYCLE_LOG"
      exit 1
    fi
    if [[ "$input" == *ORIGINAL_DATABASE* ]]; then
      printf '%s\n' original >"$LIFECYCLE_DB_STATE"
    fi
    printf '%s\n' psql >>"$LIFECYCLE_LOG"
    ;;
  *" pg_isready "*) exit 0 ;;
esac
SH

cat >"$MOCK_BIN/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
config=""
output=""
headers=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) config="$2"; shift 2 ;;
    --output) output="$2"; shift 2 ;;
    --dump-header) headers="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[[ -f "$config" && "$(stat -f '%Lp' "$config" 2>/dev/null || stat -c '%a' "$config")" == 600 ]] ||
  exit 41
grep -Fq "Authorization: Bearer $LIFECYCLE_INSTALLATION_TOKEN" "$config" || exit 42
printf '%s\n' release-curl-config download >>"$LIFECYCLE_LOG"
cp "$LIFECYCLE_ARCHIVE" "$output"
cat >"$headers" <<EOF
HTTP/2 200
content-type: application/gzip
x-quoteops-version: $LIFECYCLE_VERSION
x-quoteops-sha256: $LIFECYCLE_RESPONSE_SHA

EOF
SH
chmod +x "$MOCK_BIN/docker" "$MOCK_BIN/curl"

cat >"$APPLIANCE_HOME/.env" <<EOF
COMPOSE_PROJECT_NAME=quoteops_lifecycle
QUOTEOPS_CLIENT_ID=LIFECYCLE
QUOTEOPS_INSTALLATION_ID=lifecycle-prod-001
QUOTEOPS_CONTROL_PLANE_URL=https://control.quoteops.example
QUOTEOPS_CLIENT_ENV_FILE=$APPLIANCE_HOME/secrets/client.env
QUOTEOPS_CLOUDFLARE_ENV_FILE=$APPLIANCE_HOME/secrets/cloudflare.env
QUOTEOPS_MANIFEST_DIR=$APPLIANCE_HOME/manifests
QUOTEOPS_CRITERIA_DIR=$APPLIANCE_HOME/criteria
QUOTEOPS_CONNECTORS_DIR=$APPLIANCE_HOME/connectors
QUOTEOPS_SETTINGS_DIR=$APPLIANCE_HOME/settings
QUOTEOPS_BACKUP_DIR=$APPLIANCE_HOME/backups
POSTGRES_DB=quoteops
POSTGRES_USER=quoteops
EOF
chmod 600 "$APPLIANCE_HOME/.env"

LIFECYCLE_INSTALLATION_TOKEN="installation-token-0123456789abcdef"
cat >"$APPLIANCE_HOME/secrets/client.env" <<EOF
POSTGRES_PASSWORD=postgres-lifecycle-secret
QUOTEOPS_REGISTRATION_TOKEN=$LIFECYCLE_INSTALLATION_TOKEN
OPENROUTER_API_KEY=openrouter-lifecycle-secret
TMS_API_KEY=tms-lifecycle-secret
EOF
printf '%s\n' 'TUNNEL_TOKEN=tunnel-lifecycle-secret' >"$APPLIANCE_HOME/secrets/cloudflare.env"
chmod 600 "$APPLIANCE_HOME/secrets/client.env" "$APPLIANCE_HOME/secrets/cloudflare.env"

cat >"$CALLER_ACCESS_FILE" <<'EOF'
CF_ACCESS_CLIENT_ID=lifecycle-client.access
CF_ACCESS_CLIENT_SECRET=lifecycle-service-auth-secret
EOF
chmod 600 "$CALLER_ACCESS_FILE"
cat >"$APPLIANCE_HOME/settings/cloudflare.json" <<'JSON'
{
  "provider": "cloudflare",
  "public_hostname": "quotes.lifecycle.example",
  "origin_url": "http://caddy:80"
}
JSON
printf '%s\n' '{"safe":"state"}' >"$APPLIANCE_HOME/state/runtime.json"
printf '%s\n' 'secret evidence' >"$APPLIANCE_HOME/evidence/probe.txt"
printf '%s\n' 'secret answers' >"$APPLIANCE_HOME/onboard-input/answers.json"
printf '%s\n' 'manifest fixture' >"$APPLIANCE_HOME/manifests/client.yaml"
printf '%s\n' 'criteria fixture' >"$APPLIANCE_HOME/criteria/rules.yaml"
printf '%s\n' 'connector fixture' >"$APPLIANCE_HOME/connectors/tms.yaml"

write_release_env() {
  local path="$1"
  local version="$2"
  cat >"$path" <<EOF
QUOTEOPS_VERSION=$version
QUOTEOPS_PLATFORM=linux/amd64
QUOTEOPS_AGENT_IMAGE=ghcr.io/example/agent:$version@sha256:$(printf '1%.0s' {1..64})
QUOTEOPS_API_IMAGE=ghcr.io/example/api:$version@sha256:$(printf '2%.0s' {1..64})
QUOTEOPS_WEB_IMAGE=ghcr.io/example/web:$version@sha256:$(printf '3%.0s' {1..64})
QUOTEOPS_POSTGRES_IMAGE=postgres:16-alpine@sha256:$(printf '4%.0s' {1..64})
QUOTEOPS_REDIS_IMAGE=redis:7-alpine@sha256:$(printf '5%.0s' {1..64})
QUOTEOPS_CADDY_IMAGE=caddy:2-alpine@sha256:$(printf '6%.0s' {1..64})
QUOTEOPS_CLOUDFLARED_IMAGE=cloudflare/cloudflared:2026.7.3@sha256:$(printf '7%.0s' {1..64})
EOF
}

cat >"$APPLIANCE_HOME/releases/v0.2.0/docker-compose.yml" <<'YAML'
services: {}
YAML
write_release_env "$APPLIANCE_HOME/releases/v0.2.0/release.env" v0.2.0
cp "$APPLIANCE_DIR/upgrade.sh" "$APPLIANCE_HOME/releases/v0.2.0/upgrade.sh"
cp "$APPLIANCE_DIR/backup.sh" "$APPLIANCE_HOME/releases/v0.2.0/backup.sh"
cp "$APPLIANCE_DIR/restore.sh" "$APPLIANCE_HOME/releases/v0.2.0/restore.sh"
cp "$APPLIANCE_DIR/quoteops.sh" "$APPLIANCE_HOME/releases/v0.2.0/quoteops.sh"

write_verifier() {
  local path="$1"
  cat >"$path" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
version="$(sed -n 's/^QUOTEOPS_VERSION=//p' "$QUOTEOPS_HOME/current/release.env")"
printf 'verify:%s\n' "$version" >>"$LIFECYCLE_LOG"
[[ "$version" != "${LIFECYCLE_FAIL_VERSION:-}" ]]
SH
  chmod +x "$path"
}
write_verifier "$APPLIANCE_HOME/releases/v0.2.0/verify-install.sh"
chmod +x "$APPLIANCE_HOME/releases/v0.2.0/"*.sh
ln -s "releases/v0.2.0" "$APPLIANCE_HOME/current"

make_release() {
  local version="$1"
  local root="$WORK_DIR/package-$version"
  local archive="$WORK_DIR/quoteops-appliance-$version.tar.gz"
  local files_json
  rm -rf "$root"
  mkdir -p "$root"
  cp "$APPLIANCE_DIR/upgrade.sh" "$root/upgrade.sh"
  cp "$APPLIANCE_DIR/backup.sh" "$root/backup.sh"
  cp "$APPLIANCE_DIR/restore.sh" "$root/restore.sh"
  cp "$APPLIANCE_DIR/quoteops.sh" "$root/quoteops.sh"
  cp "$APPLIANCE_HOME/releases/v0.2.0/docker-compose.yml" "$root/docker-compose.yml"
  write_verifier "$root/verify-install.sh"
  write_release_env "$root/release.env" "$version"
  chmod +x "$root/"*.sh
  files_json="$(
    (
      cd "$root"
      for file in backup.sh docker-compose.yml quoteops.sh release.env restore.sh upgrade.sh verify-install.sh; do
        jq -nc --arg key "$file" --arg value "$(sha256_file "$file")" '{key:$key,value:$value}'
      done
    ) | jq -s 'from_entries'
  )"
  jq -n \
    --arg version "$version" \
    --argjson files "$files_json" \
    '{
      schema_version: 1,
      version: $version,
      git_sha: ("a" * 40),
      platform: "linux/amd64",
      images: {
        agent: ("ghcr.io/example/agent:" + $version + "@sha256:" + ("1" * 64)),
        api: ("ghcr.io/example/api:" + $version + "@sha256:" + ("2" * 64)),
        web: ("ghcr.io/example/web:" + $version + "@sha256:" + ("3" * 64)),
        postgres: ("postgres:16-alpine@sha256:" + ("4" * 64)),
        redis: ("redis:7-alpine@sha256:" + ("5" * 64)),
        caddy: ("caddy:2-alpine@sha256:" + ("6" * 64)),
        cloudflared: ("cloudflare/cloudflared:2026.7.3@sha256:" + ("7" * 64))
      },
      files_sha256: $files,
      created_at: "2026-07-29T18:00:00.000Z"
    }' >"$root/release.json"
  (
    cd "$root"
    for file in backup.sh docker-compose.yml quoteops.sh release.env release.json restore.sh upgrade.sh verify-install.sh; do
      printf '%s  %s\n' "$(sha256_file "$file")" "$file"
    done >PAYLOAD_SHA256SUMS
    tar -czf "$archive" \
      PAYLOAD_SHA256SUMS backup.sh docker-compose.yml quoteops.sh release.env \
      release.json restore.sh upgrade.sh verify-install.sh
  )
  printf '%s\n' "$archive"
}

run_update() {
  local version="$1"
  local archive="$2"
  local response_sha="${3:-$(sha256_file "$archive")}"
  PATH="$MOCK_BIN:/usr/bin:/bin" \
    QUOTEOPS_HOME="$APPLIANCE_HOME" \
    LIFECYCLE_LOG="$COMMAND_LOG" \
    LIFECYCLE_ARCHIVE="$archive" \
    LIFECYCLE_VERSION="$version" \
    LIFECYCLE_RESPONSE_SHA="$response_sha" \
    LIFECYCLE_INSTALLATION_TOKEN="$LIFECYCLE_INSTALLATION_TOKEN" \
    bash "$APPLIANCE_HOME/current/upgrade.sh" \
      --to "$version" \
      --cloudflare-access-file "$CALLER_ACCESS_FILE"
}

ARCHIVE_021="$(make_release v0.2.1)"
tar -xzf "$(make_release v0.2.0)" -C "$APPLIANCE_HOME/releases/v0.2.0"
: >"$COMMAND_LOG"
if PATH="$MOCK_BIN:/usr/bin:/bin" \
  QUOTEOPS_HOME="$APPLIANCE_HOME" \
  LIFECYCLE_LOG="$COMMAND_LOG" \
  LIFECYCLE_ARCHIVE="$ARCHIVE_021" \
  LIFECYCLE_VERSION=v0.2.1 \
  LIFECYCLE_RESPONSE_SHA="$(sha256_file "$ARCHIVE_021")" \
  LIFECYCLE_INSTALLATION_TOKEN="$LIFECYCLE_INSTALLATION_TOKEN" \
  bash "$APPLIANCE_HOME/current/upgrade.sh" --to v0.2.1 \
    >"$WORK_DIR/missing-access.log" 2>&1; then
  fail "non-interactive tunnel update accepted missing Access input"
fi
grep -Fq -- '--cloudflare-access-file' "$WORK_DIR/missing-access.log" ||
  fail "missing Access input did not print a safe resume command"
if grep -Eq 'backup|pull|up|verify' "$COMMAND_LOG"; then
  fail "missing Access input reached backup or switch"
fi

chmod 644 "$CALLER_ACCESS_FILE"
: >"$COMMAND_LOG"
if run_update v0.2.1 "$ARCHIVE_021" >/dev/null 2>&1; then
  fail "update accepted a non-0600 Access source"
fi
if grep -Eq 'backup|pull|up|verify' "$COMMAND_LOG"; then
  fail "unsafe Access input reached backup or switch"
fi
chmod 600 "$CALLER_ACCESS_FILE"

: >"$COMMAND_LOG"
run_update v0.2.1 "$ARCHIVE_021" >/dev/null
[[ "$(readlink "$APPLIANCE_HOME/current")" == "releases/v0.2.1" ]] ||
  fail "successful update did not switch current"
jq -e '. == {active_version:"v0.2.1",previous_version:"v0.2.0"}' \
  "$APPLIANCE_HOME/state/deployment.json" >/dev/null ||
  fail "successful update wrote unsafe deployment state"
SUCCESS_EVENTS="$(tr '\n' ' ' <"$COMMAND_LOG")"
EXPECTED_EVENTS="release-curl-config download compose-version compose-config backup pull up verify:v0.2.1 "
[[ "$SUCCESS_EVENTS" == "$EXPECTED_EVENTS" ]] ||
  fail "successful update command order differed: $SUCCESS_EVENTS"
[[ ! -e "$APPLIANCE_HOME/secrets/cloudflare-access-validation.env" ]] ||
  fail "successful update retained transient Access credentials"
[[ -f "$CALLER_ACCESS_FILE" && "$(mode_of "$CALLER_ACCESS_FILE")" == 600 ]] ||
  fail "successful update mutated the caller-owned Access file"
if find "$APPLIANCE_HOME/releases" -name '*.curl' -o -name '*curl-config*' | grep -q .; then
  fail "successful update retained a release curl config"
fi
grep '^compose-' "$COMMAND_LOG" >/dev/null

: >"$COMMAND_LOG"
if run_update v0.2.2 "$(make_release v0.2.2)" "$(printf '0%.0s' {1..64})" >/dev/null 2>&1; then
  fail "checksum mismatch was accepted"
fi
[[ ! -e "$APPLIANCE_HOME/releases/v0.2.2" ]] ||
  fail "checksum mismatch staged a release"
if grep -Eq 'backup|pull|up|verify' "$COMMAND_LOG"; then
  fail "checksum mismatch reached backup or switch"
fi

ARCHIVE_022="$(make_release v0.2.2)"
: >"$COMMAND_LOG"
if LIFECYCLE_FAIL_VERSION=v0.2.2 run_update v0.2.2 "$ARCHIVE_022" >/dev/null 2>&1; then
  fail "failed target health returned success"
fi
[[ "$(readlink "$APPLIANCE_HOME/current")" == "releases/v0.2.1" ]] ||
  fail "failed target health did not restore previous symlink"
grep -Fxq 'verify:v0.2.2' "$COMMAND_LOG" ||
  fail "failed target was not verified"
grep -Fxq 'verify:v0.2.1' "$COMMAND_LOG" ||
  fail "automatic rollback did not verify the restored version"
[[ ! -e "$APPLIANCE_HOME/secrets/cloudflare-access-validation.env" ]] ||
  fail "verified automatic rollback retained Access credentials"
jq -e '. == {active_version:"v0.2.1",previous_version:"v0.2.0"}' \
  "$APPLIANCE_HOME/state/deployment.json" >/dev/null ||
  fail "failed update changed deployment state"

: >"$COMMAND_LOG"
PATH="$MOCK_BIN:/usr/bin:/bin" \
  QUOTEOPS_HOME="$APPLIANCE_HOME" \
  LIFECYCLE_LOG="$COMMAND_LOG" \
  bash "$APPLIANCE_HOME/current/upgrade.sh" \
    --rollback \
    --cloudflare-access-file "$CALLER_ACCESS_FILE" >/dev/null
[[ "$(readlink "$APPLIANCE_HOME/current")" == "releases/v0.2.0" ]] ||
  fail "explicit rollback ignored deployment.previous_version"
jq -e '. == {active_version:"v0.2.0",previous_version:"v0.2.1"}' \
  "$APPLIANCE_HOME/state/deployment.json" >/dev/null ||
  fail "explicit rollback did not swap deployment versions"
grep -Fxq 'verify:v0.2.0' "$COMMAND_LOG" ||
  fail "explicit rollback did not verify the requested prior version"

LATEST_BACKUP="$(find "$APPLIANCE_HOME/backups" -type f -name '*.tar.gz' | sort | tail -1)"
[[ -n "$LATEST_BACKUP" && "$(mode_of "$LATEST_BACKUP")" == 600 ]] ||
  fail "backup archive is missing or not mode 0600"
BACKUP_EXTRACT="$WORK_DIR/backup-extract"
mkdir "$BACKUP_EXTRACT"
tar -xzf "$LATEST_BACKUP" -C "$BACKUP_EXTRACT"
jq -e '
  keys == ["client_id","created_at","includes","installation_id","quoteops_version","required_secret_keys","schema_version"] and
  .schema_version == 1 and
  .client_id == "LIFECYCLE" and
  .installation_id == "lifecycle-prod-001" and
  (.required_secret_keys | index("POSTGRES_PASSWORD")) and
  (.required_secret_keys | index("QUOTEOPS_REGISTRATION_TOKEN")) and
  (.required_secret_keys | index("OPENROUTER_API_KEY")) and
  (.required_secret_keys | index("TMS_API_KEY")) and
  (.required_secret_keys | index("TUNNEL_TOKEN"))
' "$BACKUP_EXTRACT/backup-manifest.json" >/dev/null ||
  fail "backup manifest is not exact or omitted required secret keys"
[[ -f "$BACKUP_EXTRACT/connectors/tms.yaml" &&
   -f "$BACKUP_EXTRACT/settings/cloudflare.json" &&
   -f "$BACKUP_EXTRACT/state/runtime.json" ]] ||
  fail "backup omitted safe connector/settings/state data"
[[ ! -e "$BACKUP_EXTRACT/state/deployment.json" &&
   ! -e "$BACKUP_EXTRACT/secrets" &&
   ! -e "$BACKUP_EXTRACT/.env" &&
   ! -e "$BACKUP_EXTRACT/evidence" &&
   ! -e "$BACKUP_EXTRACT/onboard-input" ]] ||
  fail "backup included deployment pointers or sensitive inputs"
(
  cd "$BACKUP_EXTRACT"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c SHA256SUMS >/dev/null
  else
    shasum -a 256 -c SHA256SUMS >/dev/null
  fi
) || fail "backup internal checksums failed"
grep -Fq 'SHA256SUMS' "$BACKUP_EXTRACT/SHA256SUMS" &&
  fail "backup checksum file listed itself"

FAILED_RESTORE_ROOT="$WORK_DIR/failed-restore-root"
FAILED_RESTORE_BACKUP="$WORK_DIR/failed-restore.tar.gz"
DATABASE_STATE="$WORK_DIR/database-state"
mkdir "$FAILED_RESTORE_ROOT"
tar -xzf "$LATEST_BACKUP" -C "$FAILED_RESTORE_ROOT"
printf '%s\n' '-- RESTORE_TARGET' >"$FAILED_RESTORE_ROOT/postgres.sql"
postgres_sha="$(sha256_file "$FAILED_RESTORE_ROOT/postgres.sql")"
awk -v hash="$postgres_sha" '
  $2 == "postgres.sql" { print hash "  postgres.sql"; next }
  { print }
' "$FAILED_RESTORE_ROOT/SHA256SUMS" >"$FAILED_RESTORE_ROOT/SHA256SUMS.new"
mv "$FAILED_RESTORE_ROOT/SHA256SUMS.new" "$FAILED_RESTORE_ROOT/SHA256SUMS"
tar -czf "$FAILED_RESTORE_BACKUP" -C "$FAILED_RESTORE_ROOT" .
printf '%s\n' 'original-local-manifest' >"$APPLIANCE_HOME/manifests/client.yaml"
printf '%s\n' original >"$DATABASE_STATE"
: >"$COMMAND_LOG"
if PATH="$MOCK_BIN:/usr/bin:/bin" \
  QUOTEOPS_HOME="$APPLIANCE_HOME" \
  LIFECYCLE_LOG="$COMMAND_LOG" \
  LIFECYCLE_FAIL_RESTORE_IMPORT=1 \
  LIFECYCLE_DB_STATE="$DATABASE_STATE" \
  bash "$APPLIANCE_HOME/current/restore.sh" \
    --backup "$FAILED_RESTORE_BACKUP" >/dev/null 2>&1; then
  fail "partially failed PostgreSQL import returned success"
fi
[[ "$(cat "$DATABASE_STATE")" == original ]] ||
  fail "restore failure did not put back the original PostgreSQL state"
[[ "$(cat "$APPLIANCE_HOME/manifests/client.yaml")" == original-local-manifest ]] ||
  fail "restore failure did not put back the original files"
grep -Fxq partial-import "$COMMAND_LOG" ||
  fail "restore failure fixture did not reach a partial import"
grep -Fxq 'verify:v0.2.0' "$COMMAND_LOG" ||
  fail "restore failure did not verify the relaunched active release"
[[ "$(readlink "$APPLIANCE_HOME/current")" == "releases/v0.2.0" ]] ||
  fail "restore failure changed the active release"

CORRUPT_BACKUP="$WORK_DIR/corrupt.tar.gz"
CORRUPT_ROOT="$WORK_DIR/corrupt-root"
mkdir "$CORRUPT_ROOT"
tar -xzf "$LATEST_BACKUP" -C "$CORRUPT_ROOT"
printf 'corrupt\n' >>"$CORRUPT_ROOT/postgres.sql"
tar -czf "$CORRUPT_BACKUP" -C "$CORRUPT_ROOT" .
: >"$COMMAND_LOG"
if PATH="$MOCK_BIN:/usr/bin:/bin" \
  QUOTEOPS_HOME="$APPLIANCE_HOME" \
  LIFECYCLE_LOG="$COMMAND_LOG" \
  bash "$APPLIANCE_HOME/current/restore.sh" --backup "$CORRUPT_BACKUP" >/dev/null 2>&1; then
  fail "corrupt backup was accepted"
fi
if grep -Eq 'stop|psql' "$COMMAND_LOG"; then
  fail "corrupt backup stopped services or touched PostgreSQL"
fi

printf 'lifecycle: update, rollback, backup, restore preflight, and restore recovery checks passed\n'
