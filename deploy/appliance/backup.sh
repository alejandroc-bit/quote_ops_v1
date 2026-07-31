#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
QUOTEOPS_HOME="${QUOTEOPS_HOME:-/opt/quoteops-v1}"
ENV_FILE="${QUOTEOPS_ENV_FILE:-$QUOTEOPS_HOME/.env}"
OUTPUT_DIR=""
ENV_FILE_SET=0

usage() {
  cat <<USAGE
Usage: $(basename "$0") --output /opt/quoteops-v1/backups [options]

Options:
  --home PATH          Appliance data root (default: /opt/quoteops-v1)
  --env-file PATH      Shared env file (default: <home>/.env)
  --compose-file PATH  Deprecated; the active release compose file is always used
  -h, --help           Show this help
USAGE
}

die() {
  printf 'backup.sh: %s\n' "$*" >&2
  exit 1
}

require_value() {
  [[ -n "${2:-}" && "${2:-}" != --* ]] || die "$1 requires a value"
}

absolute_existing_file() {
  local path="$1"
  local directory
  directory="$(cd "$(dirname "$path")" && pwd -P)" ||
    die "cannot resolve path: $path"
  printf '%s/%s\n' "$directory" "$(basename "$path")"
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

read_env_value() {
  local key="$1"
  local file="$2"
  local lines
  local value
  [[ -f "$file" && ! -L "$file" ]] || return 1
  lines="$(awk -v key="$key" -F= '$1 == key { count++; value=substr($0,index($0,"=")+1) } END { if (count == 1) print value; else exit 1 }' "$file")" ||
    return 1
  value="$lines"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value#\"}"
    value="${value%\"}"
  fi
  [[ -n "$value" && "$value" != *$'\n'* && "$value" != *$'\r'* ]] ||
    return 1
  printf '%s' "$value"
}

validate_deployment_json() {
  local file="$1"
  jq -e '
    type == "object" and
    keys == ["active_version","previous_version"] and
    (.active_version | type == "string" and test("^v[0-9]+[.][0-9]+[.][0-9]+$")) and
    (.previous_version | type == "string" and test("^v[0-9]+[.][0-9]+[.][0-9]+$"))
  ' "$file" >/dev/null
}

validate_cloudflare_json() {
  local file="$1"
  jq -e '
    type == "object" and
    keys == ["origin_url","provider","public_hostname"] and
    .provider == "cloudflare" and
    .origin_url == "http://caddy:80" and
    (.public_hostname | type == "string" and
      test("^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$"))
  ' "$file" >/dev/null
}

derive_agent_secret_keys() {
  local file="$1"
  awk '
    function invalid() { bad=1; exit 1 }
    function trim(value) {
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      return value
    }
    function scalar(value) {
      value=trim(value)
      if ((value ~ /^".*"$/) || (value ~ /^'\''.*'\''$/)) {
        value=substr(value,2,length(value)-2)
      }
      return value
    }
    function env_name(value) {
      return value ~ /^[A-Za-z_][A-Za-z0-9_]*$/
    }
    function remember(container, key) {
      if (seen[container SUBSEP key]++) invalid()
    }
    BEGIN {
      section=""
      subsection=""
      current_tool=""
    }
    {
      sub(/\r$/, "")
      if ($0 ~ /\t/) invalid()
      line=$0
      sub(/[[:space:]]+$/, "", line)
      if (line ~ /^[[:space:]]*($|#)/) next
      match(line,/^ */)
      indent=RLENGTH
      content=substr(line,indent+1)
      colon=index(content,":")
      if (colon == 0) {
        if (section == "authorization" && subsection == "allowed_domains" &&
            indent == 4 && content ~ /^-[ ]+[^ ].*$/) next
        invalid()
      }
      key=substr(content,1,colon-1)
      value=scalar(substr(content,colon+1))
      if (key !~ /^[A-Za-z0-9_.-]+$/) invalid()
      if (indent == 0) {
        remember("top",key)
        if (key !~ /^(model|authorization|mailbox|embeddings)$/) invalid()
        if ((key == "model" || key == "authorization") && value != "") invalid()
        if ((key == "mailbox" || key == "embeddings") &&
            value != "" && value != "null") invalid()
        section=key
        subsection=""
        current_tool=""
        top[key]=value
        next
      }
      if (indent == 2 && section == "model") {
        if (key !~ /^(provider|model_name|temperature|api_key_env|base_url)$/) invalid()
        remember("model",key)
        model[key]=value
        next
      }
      if (indent == 2 && section == "authorization") {
        if (key !~ /^(approver_email|allowed_domains|whatsapp_approver_phone|tools)$/) invalid()
        remember("authorization",key)
        if ((key == "allowed_domains" || key == "tools") && value != "") invalid()
        subsection=key
        auth[key]=value
        next
      }
      if (indent == 4 && section == "authorization" && subsection == "tools") {
        if (value != "") invalid()
        remember("tool",key)
        current_tool=key
        tool_declared[key]=1
        next
      }
      if (indent == 6 && section == "authorization" &&
          subsection == "tools" && current_tool != "") {
        if (key !~ /^(effect|mode)$/ || value == "") invalid()
        remember("tool-policy-" current_tool,key)
        tool_policy[current_tool SUBSEP key]=value
        tool_names[current_tool]=1
        next
      }
      if (indent == 2 && section == "mailbox" && top["mailbox"] != "null") {
        if (key !~ /^(provider|auth|processed_mailbox|poll_interval_ms|imap_host|imap_port)$/) invalid()
        remember("mailbox",key)
        mailbox[key]=value
        next
      }
      if (indent == 2 && section == "embeddings" && top["embeddings"] != "null") {
        if (key !~ /^(provider|model|api_key_env|base_url)$/) invalid()
        remember("embeddings",key)
        embeddings[key]=value
        next
      }
      invalid()
    }
    END {
      if (bad) exit 1
      if (!("model" in top) || !("authorization" in top) ||
          !("provider" in model) || !("model_name" in model) ||
          !("tools" in auth)) exit 1
      if (model["provider"] !~ /^(deterministic|gemini_sdk|openai|openrouter|claude_cli)$/ ||
          model["model_name"] == "") exit 1
      if (("temperature" in model) &&
          model["temperature"] !~ /^-?[0-9]+([.][0-9]+)?$/) exit 1
      if (("api_key_env" in model) &&
          model["api_key_env"] != "null" &&
          !env_name(model["api_key_env"])) exit 1
      if (model["provider"] == "openrouter") {
        key=(model["api_key_env"] == "" || model["api_key_env"] == "null" ? "OPENROUTER_API_KEY" : model["api_key_env"])
        print key
      } else if (model["provider"] == "gemini_sdk") {
        key=(model["api_key_env"] == "" || model["api_key_env"] == "null" ? "GEMINI_API_KEY" : model["api_key_env"])
        print key
      } else if (model["provider"] == "openai") {
        if (model["api_key_env"] == "" || model["api_key_env"] == "null") exit 1
        print model["api_key_env"]
      }
      for (tool in tool_declared) {
        effect=tool_policy[tool SUBSEP "effect"]
        mode=tool_policy[tool SUBSEP "mode"]
        if (effect !~ /^(read|write|send|approve)$/ ||
            mode !~ /^(allowed|approval_required|disabled)$/) exit 1
      }
      if (("mailbox" in top) && top["mailbox"] == "") {
        provider=("provider" in mailbox ? mailbox["provider"] : "gmail")
        auth_type=("auth" in mailbox ? mailbox["auth"] : "oauth2")
        if (provider !~ /^(gmail|outlook|imap|resend)$/ ||
            auth_type !~ /^(oauth2|password)$/) exit 1
        if (("poll_interval_ms" in mailbox) &&
            mailbox["poll_interval_ms"] !~ /^[1-9][0-9]*$/) exit 1
        if (("imap_port" in mailbox) &&
            mailbox["imap_port"] != "null" &&
            mailbox["imap_port"] !~ /^[1-9][0-9]*$/) exit 1
        print "MAILBOX_USER"
        if (provider == "resend") {
          print "RESEND_API_KEY"
        } else if (auth_type == "password") {
          print "MAILBOX_PASSWORD"
        } else {
          print "MAILBOX_OAUTH_CLIENT_ID"
          print "MAILBOX_OAUTH_CLIENT_SECRET"
          print "MAILBOX_OAUTH_REFRESH_TOKEN"
        }
      }
      if (("embeddings" in top) && top["embeddings"] == "") {
        provider=("provider" in embeddings ? embeddings["provider"] : "gemini")
        key=("api_key_env" in embeddings ? embeddings["api_key_env"] : "QUOTEOPS_EMBEDDING_API_KEY")
        if (provider !~ /^(gemini|openai_compatible)$/ ||
            key == "null" || !env_name(key)) exit 1
        print key
      }
    }
  ' "$file"
}

derive_tms_secret_keys() {
  local file="$1"
  awk '
    function invalid() { bad=1; exit 1 }
    function trim(value) {
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      return value
    }
    function scalar(value) {
      value=trim(value)
      if ((value ~ /^".*"$/) || (value ~ /^'\''.*'\''$/)) {
        value=substr(value,2,length(value)-2)
      }
      return value
    }
    function env_name(value) {
      return value ~ /^[A-Za-z_][A-Za-z0-9_]*$/
    }
    function remember(container,key) {
      if (seen[container SUBSEP key]++) invalid()
    }
    {
      sub(/\r$/, "")
      if ($0 ~ /\t/) invalid()
      line=$0
      sub(/[[:space:]]+$/, "", line)
      if (line ~ /^[[:space:]]*($|#)/) next
      match(line,/^ */)
      indent=RLENGTH
      content=substr(line,indent+1)
      colon=index(content,":")
      if (colon == 0) invalid()
      key=substr(content,1,colon-1)
      value=scalar(substr(content,colon+1))
      if (indent == 0) {
        if (key !~ /^[a-z_]+$/) invalid()
        remember("top",key)
        top[key]=value
        section=(value == "" ? key : "")
        next
      }
      if (indent == 2 && section == "headers") {
        if (key == "" || value == "") invalid()
        remember("header",key)
        headers[key]=value
        next
      }
      if (indent == 2 && section == "queries") {
        if (key !~ /^(get_rfq|new_rfqs|historical_quotes|historical_shipments|customers|agreements|unit_positions|units|performance|availability_zones)$/ ||
            value == "") invalid()
        remember("query",key)
        next
      }
      if (indent == 2 && (section == "write_quote" || section == "write_status")) {
        if (key != "statement" || value == "") invalid()
        remember(section,key)
        next
      }
      invalid()
    }
    END {
      if (bad || !("provider" in top)) exit 1
      provider=top["provider"]
      if (provider == "file_import") {
        allowed=" provider rfqs_path_env historical_quotes_path_env historical_shipments_path_env customers_path_env agreements_path_env unit_positions_path_env units_path_env performance_path_env availability_zones_path_env quote_writebacks_path_env status_writebacks_path_env "
        for (key in top) {
          if (index(allowed," " key " ") == 0 || top[key] == "") exit 1
          if (key != "provider" && !env_name(top[key])) exit 1
        }
      } else if (provider == "http") {
        allowed=" provider contract base_url_env headers health_endpoint_path get_rfq_endpoint_path list_new_rfqs_endpoint_path search_historical_quotes_endpoint_path search_historical_shipments_endpoint_path get_customer_endpoint_path get_customer_agreements_endpoint_path get_unit_positions_endpoint_path get_units_endpoint_path get_unit_performance_endpoint_path get_availability_zones_endpoint_path write_quote_endpoint_path write_status_endpoint_path "
        for (key in top) {
          if (index(allowed," " key " ") == 0) exit 1
          if (key != "headers" && top[key] == "") exit 1
        }
        if (!("base_url_env" in top) || !env_name(top["base_url_env"])) exit 1
        if (("contract" in top) && top["contract"] != "quoteops-tms-http-v1") exit 1
        for (name in headers) {
          value=headers[name]
          lower=tolower(name)
          if ((lower == "authorization" || lower ~ /api-key|apikey|token|secret/) &&
              value !~ /\$\{[A-Za-z_][A-Za-z0-9_]*\}/) exit 1
          rest=value
          while (match(rest,/\$\{[A-Za-z_][A-Za-z0-9_]*\}/)) {
            env_key=substr(rest,RSTART+2,RLENGTH-3)
            print env_key
            rest=substr(rest,RSTART+RLENGTH)
          }
          if (rest ~ /\$\{/) exit 1
        }
      } else if (provider == "sql") {
        allowed=" provider dialect connection_url_env queries write_quote write_status "
        for (key in top) {
          if (index(allowed," " key " ") == 0) exit 1
        }
        if (top["dialect"] !~ /^(postgres|mysql|mssql)$/ ||
            !env_name(top["connection_url_env"]) ||
            !("queries" in top) || top["queries"] != "") exit 1
        print top["connection_url_env"]
      } else {
        exit 1
      }
    }
  ' "$file"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      require_value "$1" "${2:-}"
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --home)
      require_value "$1" "${2:-}"
      QUOTEOPS_HOME="$2"
      if [[ "$ENV_FILE_SET" -eq 0 ]]; then
        ENV_FILE="$QUOTEOPS_HOME/.env"
      fi
      shift 2
      ;;
    --env-file)
      require_value "$1" "${2:-}"
      ENV_FILE="$2"
      ENV_FILE_SET=1
      shift 2
      ;;
    --compose-file)
      require_value "$1" "${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ -n "$OUTPUT_DIR" ]] || die "--output is required"
need_command jq
need_command tar
need_command awk
if ! command -v sha256sum >/dev/null 2>&1; then
  need_command shasum
fi
need_command docker
docker compose version >/dev/null 2>&1 ||
  die "Docker Compose v2 is required"

[[ -d "$QUOTEOPS_HOME" && ! -L "$QUOTEOPS_HOME" ]] ||
  die "home must be a physical directory"
QUOTEOPS_HOME="$(cd "$QUOTEOPS_HOME" && pwd -P)"
[[ "$QUOTEOPS_HOME" != "/" ]] || die "home cannot be /"
ENV_FILE="$(absolute_existing_file "$ENV_FILE")"
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] ||
  die "env file must be a regular file"
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd -P)"

[[ -L "$QUOTEOPS_HOME/current" ]] || die "current release link is missing"
ACTIVE_RELEASE="$(cd "$QUOTEOPS_HOME/current" && pwd -P)"
case "$ACTIVE_RELEASE" in
  "$QUOTEOPS_HOME"/releases/v[0-9]*.[0-9]*.[0-9]*) ;;
  *) die "current release escaped the release directory" ;;
esac
RELEASE_ENV_FILE="$ACTIVE_RELEASE/release.env"
COMPOSE_FILE="$ACTIVE_RELEASE/docker-compose.yml"
[[ -f "$RELEASE_ENV_FILE" && ! -L "$RELEASE_ENV_FILE" ]] ||
  die "active release.env is missing"
[[ -f "$COMPOSE_FILE" && ! -L "$COMPOSE_FILE" ]] ||
  die "active compose file is missing"
QUOTEOPS_VERSION="$(read_env_value QUOTEOPS_VERSION "$RELEASE_ENV_FILE")" ||
  die "active release.env has no exact QUOTEOPS_VERSION"
[[ "$QUOTEOPS_VERSION" =~ ^v[0-9]+[.][0-9]+[.][0-9]+$ ]] ||
  die "active release version is invalid"
[[ "$(basename "$ACTIVE_RELEASE")" == "$QUOTEOPS_VERSION" ]] ||
  die "current release and release.env disagree"

DEPLOYMENT_FILE="$QUOTEOPS_HOME/state/deployment.json"
if [[ -e "$DEPLOYMENT_FILE" ]]; then
  [[ -f "$DEPLOYMENT_FILE" && ! -L "$DEPLOYMENT_FILE" ]] ||
    die "deployment state must be a regular file"
  validate_deployment_json "$DEPLOYMENT_FILE" ||
    die "deployment state failed exact-schema validation"
  [[ "$(jq -er '.active_version' "$DEPLOYMENT_FILE")" == "$QUOTEOPS_VERSION" ]] ||
    die "deployment state does not match current"
fi

CLOUDFLARE_SETTINGS_FILE="$QUOTEOPS_HOME/settings/cloudflare.json"
if [[ -e "$CLOUDFLARE_SETTINGS_FILE" ]]; then
  [[ -f "$CLOUDFLARE_SETTINGS_FILE" && ! -L "$CLOUDFLARE_SETTINGS_FILE" ]] ||
    die "Cloudflare settings must be a regular file"
  validate_cloudflare_json "$CLOUDFLARE_SETTINGS_FILE" ||
    die "Cloudflare settings failed exact-schema validation"
fi

# shellcheck disable=SC1090
set -a
. "$ENV_FILE"
set +a
QUOTEOPS_CLIENT_ID="${QUOTEOPS_CLIENT_ID:-}"
QUOTEOPS_INSTALLATION_ID="${QUOTEOPS_INSTALLATION_ID:-}"
POSTGRES_DB="${POSTGRES_DB:-quoteops}"
POSTGRES_USER="${POSTGRES_USER:-quoteops}"
[[ "$QUOTEOPS_CLIENT_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] ||
  die "QUOTEOPS_CLIENT_ID is invalid"
[[ "$QUOTEOPS_INSTALLATION_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] ||
  die "QUOTEOPS_INSTALLATION_ID is invalid"
[[ "$POSTGRES_DB" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
  die "POSTGRES_DB is invalid"
[[ "$POSTGRES_USER" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
  die "POSTGRES_USER is invalid"

CLIENT_ENV_FILE="${QUOTEOPS_CLIENT_ENV_FILE:-$QUOTEOPS_HOME/secrets/client.env}"
CLOUDFLARE_ENV_FILE="${QUOTEOPS_CLOUDFLARE_ENV_FILE:-$QUOTEOPS_HOME/secrets/cloudflare.env}"
for secret_file in "$CLIENT_ENV_FILE" "$CLOUDFLARE_ENV_FILE"; do
  if [[ -e "$secret_file" ]]; then
    [[ -f "$secret_file" && ! -L "$secret_file" ]] ||
      die "secret inventory source must be a regular file"
  fi
done

TIMESTAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
CREATED_AT="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
SAFE_CLIENT="$(printf '%s' "$QUOTEOPS_CLIENT_ID" |
  tr '[:upper:]' '[:lower:]' |
  sed 's/[^a-z0-9_.-]/-/g')"
BACKUP_FILE="$OUTPUT_DIR/quoteops-$SAFE_CLIENT-$QUOTEOPS_VERSION-$TIMESTAMP.tar.gz"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/quoteops-backup.XXXXXX")"
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

for directory in manifests criteria connectors settings state; do
  mkdir -p "$WORK_DIR/$directory"
  source_directory="$QUOTEOPS_HOME/$directory"
  if [[ -d "$source_directory" ]]; then
    if find "$source_directory" -type l -print -quit | grep -q .; then
      die "$directory contains a symbolic link"
    fi
    cp -R "$source_directory/." "$WORK_DIR/$directory/"
  fi
done
rm -f "$WORK_DIR/state/deployment.json"

find "$WORK_DIR" -type f -name '*.json' -print0 |
  while IFS= read -r -d '' json_file; do
    jq -e . "$json_file" >/dev/null ||
      die "backup source contains invalid JSON: ${json_file#"$WORK_DIR/"}"
  done

AVAILABLE_KEYS_RAW="$WORK_DIR/.available-secret-keys.raw"
AVAILABLE_KEYS_FILE="$WORK_DIR/.available-secret-keys"
: >"$AVAILABLE_KEYS_RAW"
for secret_file in "$CLIENT_ENV_FILE" "$CLOUDFLARE_ENV_FILE"; do
  [[ -f "$secret_file" ]] || continue
  awk -F= '
    /^[[:space:]]*($|#)/ { next }
    /^[A-Z_][A-Z0-9_]*=.+$/ { print $1; next }
    { exit 1 }
  ' "$secret_file" >>"$AVAILABLE_KEYS_RAW" ||
    die "secret inventory source has an invalid assignment"
done
if [[ -n "$(LC_ALL=C sort "$AVAILABLE_KEYS_RAW" | uniq -d)" ]]; then
  die "secret inventory sources contain a duplicate key"
fi
LC_ALL=C sort -u "$AVAILABLE_KEYS_RAW" >"$AVAILABLE_KEYS_FILE"

AGENT_CONFIG_FILE="$QUOTEOPS_HOME/connectors/agent/agent-config.yaml"
TMS_CONFIG_FILE="$QUOTEOPS_HOME/connectors/tms-adapter.yaml"
[[ -f "$AGENT_CONFIG_FILE" && ! -L "$AGENT_CONFIG_FILE" ]] ||
  die "active agent config must be a regular YAML file"
[[ -f "$TMS_CONFIG_FILE" && ! -L "$TMS_CONFIG_FILE" ]] ||
  die "active TMS config must be a regular YAML file"

REQUIRED_KEYS_FILE="$WORK_DIR/.required-secret-keys"
{
  printf '%s\n' POSTGRES_PASSWORD QUOTEOPS_REGISTRATION_TOKEN
  derive_agent_secret_keys "$AGENT_CONFIG_FILE" ||
    die "active agent config failed exact-schema validation"
  derive_tms_secret_keys "$TMS_CONFIG_FILE" ||
    die "active TMS config failed exact-schema validation"
  if [[ -e "$CLOUDFLARE_SETTINGS_FILE" ]]; then
    printf '%s\n' TUNNEL_TOKEN
  fi
  case "${QUOTEOPS_SAKBE_LIVE_ENABLED:-true}" in
    true|1|yes|on)
      if grep -Fxq INEGI_SAKBE_KEY "$AVAILABLE_KEYS_FILE"; then
        printf '%s\n' INEGI_SAKBE_KEY
      elif grep -Fxq QUOTEOPS_SAKBE_API_KEY "$AVAILABLE_KEYS_FILE"; then
        printf '%s\n' QUOTEOPS_SAKBE_API_KEY
      else
        die "required active secret key is missing: INEGI_SAKBE_KEY"
      fi
      ;;
    false|0|no|off) ;;
    *) die "QUOTEOPS_SAKBE_LIVE_ENABLED is invalid" ;;
  esac
} | LC_ALL=C sort -u >"$REQUIRED_KEYS_FILE"

while IFS= read -r required_key; do
  grep -Fxq "$required_key" "$AVAILABLE_KEYS_FILE" ||
    die "required active secret key is missing: $required_key"
done <"$REQUIRED_KEYS_FILE"
REQUIRED_KEYS_JSON="$(jq -Rsc 'split("\n") | map(select(length > 0))' "$REQUIRED_KEYS_FILE")"
rm -f "$AVAILABLE_KEYS_RAW" "$AVAILABLE_KEYS_FILE" "$REQUIRED_KEYS_FILE"

jq -n \
  --arg client "$QUOTEOPS_CLIENT_ID" \
  --arg installation "$QUOTEOPS_INSTALLATION_ID" \
  --arg version "$QUOTEOPS_VERSION" \
  --arg created "$CREATED_AT" \
  --argjson required "$REQUIRED_KEYS_JSON" \
  '{
    schema_version: 1,
    client_id: $client,
    installation_id: $installation,
    quoteops_version: $version,
    created_at: $created,
    includes: [
      "postgres.sql",
      "manifests",
      "criteria",
      "connectors",
      "settings",
      "state"
    ],
    required_secret_keys: $required
  }' >"$WORK_DIR/backup-manifest.json"

compose() {
  docker compose \
    --env-file "$ENV_FILE" \
    --env-file "$RELEASE_ENV_FILE" \
    -f "$COMPOSE_FILE" \
    "$@"
}
compose config >/dev/null
compose exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" \
  >"$WORK_DIR/postgres.sql"

(
  cd "$WORK_DIR"
  : >SHA256SUMS
  while IFS= read -r file; do
    file="${file#./}"
    [[ "$file" =~ ^[A-Za-z0-9._/-]+$ &&
       "$file" != *$'\n'* &&
       "$file" != *$'\r'* ]] ||
      die "backup path is not a safe portable relative path"
    printf '%s  %s\n' "$(sha256_file "$file")" "$file" >>SHA256SUMS
  done < <(LC_ALL=C find . -type f ! -name SHA256SUMS -print | LC_ALL=C sort)
)

tar -czf "$BACKUP_FILE" -C "$WORK_DIR" .
chmod 600 "$BACKUP_FILE"
printf '%s\n' "$BACKUP_FILE"
