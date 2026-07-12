#!/usr/bin/env bash
set -euo pipefail

CONTROL_PLANE_URL="${CONTROL_PLANE_URL:-http://127.0.0.1:19083}"
CLIENT_ID="${CLIENT_ID:-NMX}"
LEGAL_NAME="${LEGAL_NAME:-Autolineas NuevoMex}"
AUTHORIZED_EMAIL="${AUTHORIZED_EMAIL:-ops@nmx.example}"
INSTALLATION_ID="${INSTALLATION_ID:-nmx-prod-001}"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

post_json() {
  local path="$1"
  local body="$2"
  local out="$3"
  curl -fsS \
    -X POST "$CONTROL_PLANE_URL$path" \
    -H 'content-type: application/json' \
    -d "$body" \
    > "$out"
}

get_json() {
  local path="$1"
  local out="$2"
  curl -fsS "$CONTROL_PLANE_URL$path" > "$out"
}

node_read() {
  local file="$1"
  local expression="$2"
  node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); console.log($expression);" "$file"
}

health="$TMP_DIR/health.json"
client="$TMP_DIR/client.json"
pack="$TMP_DIR/install-pack.json"
login="$TMP_DIR/login.json"
activate="$TMP_DIR/activate.json"
heartbeat="$TMP_DIR/heartbeat.json"
counters="$TMP_DIR/counters.json"
clients="$TMP_DIR/clients.json"

get_json "/api/health" "$health"
post_json "/api/admin/clients" \
  "{\"client_id\":\"$CLIENT_ID\",\"legal_name\":\"$LEGAL_NAME\",\"authorized_email\":\"$AUTHORIZED_EMAIL\"}" \
  "$client"
post_json "/api/admin/clients/$CLIENT_ID/install-pack" "{}" "$pack"

REGISTRATION_TOKEN="$(node_read "$pack" "data.install_pack.registration_token")"

post_json "/api/onboarding/login" \
  "{\"client_id\":\"$CLIENT_ID\",\"email\":\"$AUTHORIZED_EMAIL\"}" \
  "$login"
post_json "/api/onboarding/activate" \
  "{\"client_id\":\"$CLIENT_ID\",\"installation_id\":\"$INSTALLATION_ID\",\"email\":\"$AUTHORIZED_EMAIL\",\"registration_token\":\"$REGISTRATION_TOKEN\"}" \
  "$activate"
post_json "/api/installations/$INSTALLATION_ID/heartbeat" \
  "{\"client_id\":\"$CLIENT_ID\",\"ai_key_status\":\"configured\",\"onboarding_status\":\"ready\"}" \
  "$heartbeat"
post_json "/api/installations/$INSTALLATION_ID/counters" \
  "{\"client_id\":\"$CLIENT_ID\",\"total\":3,\"validated\":2,\"rejected\":1,\"pending\":0,\"failed\":0}" \
  "$counters"
get_json "/api/admin/clients" "$clients"

echo "Control Plane API: $CONTROL_PLANE_URL"
echo "Created: $(node_read "$client" "data.client.client_id + ' / ' + data.client.installation.installation_id")"
echo "Install token issued: ${REGISTRATION_TOKEN:0:8}..."
echo "Login authorized: $(node_read "$login" "String(data.authorized)")"
echo "License activated: $(node_read "$activate" "String(data.activated)")"
echo "Heartbeat: $(node_read "$heartbeat" "data.client.installation.last_heartbeat_at")"
echo "Counters: $(node_read "$counters" "JSON.stringify(data.client.counters)")"
echo "Clients in registry: $(node_read "$clients" "String(data.items.length)")"
