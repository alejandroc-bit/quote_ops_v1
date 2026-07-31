#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: verify.sh APPLIANCE_BASE_URL

Queries the appliance's public health and setup-state endpoints. It prints a
redacted JSON summary and fails unless health is good and required_steps is
empty. The URL must not contain credentials or query-string secrets.
USAGE
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

[[ "$#" -eq 1 ]] || { usage >&2; exit 64; }
command -v curl >/dev/null 2>&1 || { echo "verify.sh: curl is required" >&2; exit 69; }
command -v node >/dev/null 2>&1 || { echo "verify.sh: node is required" >&2; exit 69; }

base_url="${1%/}"
[[ "$base_url" =~ ^https?://[^/?#]+$ ]] || {
  echo "verify.sh: base URL must be an http(s) origin without credentials, path, query, or fragment" >&2
  exit 64
}
[[ "$base_url" != *"@"* ]] || {
  echo "verify.sh: base URL must not contain credentials" >&2
  exit 64
}

health_file="$(mktemp "${TMPDIR:-/tmp}/quoteops-human-simulator-health.XXXXXX")"
setup_file="$(mktemp "${TMPDIR:-/tmp}/quoteops-human-simulator-setup.XXXXXX")"
cleanup() { rm -f "$health_file" "$setup_file"; }
trap cleanup EXIT

curl --fail --silent --show-error --max-time 15 "$base_url/api/health" >"$health_file"
curl --fail --silent --show-error --max-time 15 "$base_url/api/setup-state" >"$setup_file"

BASE_URL="$base_url" HEALTH_FILE="$health_file" SETUP_FILE="$setup_file" node <<'NODE'
const fs = require("node:fs");

const redact = (value) => {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      /key|secret|token|password|authorization|license/i.test(key) ? "[REDACTED]" : key,
      /key|secret|token|password|authorization|license/i.test(key) ? "[REDACTED]" : redact(child)
    ]));
  }
  if (typeof value === "string" && /(?:gh[pousr]_|sk-|nvapi-|re_)/i.test(value)) return "[REDACTED]";
  return value;
};

let health;
let setup;
try {
  health = JSON.parse(fs.readFileSync(process.env.HEALTH_FILE, "utf8"));
  setup = JSON.parse(fs.readFileSync(process.env.SETUP_FILE, "utf8"));
} catch (error) {
  console.error("verify.sh: public endpoint returned invalid JSON");
  process.exit(65);
}

const requiredSteps = Array.isArray(setup.required_steps) ? setup.required_steps : null;
const summary = redact({
  base_url: process.env.BASE_URL,
  health: {
    ok: health.ok === true,
    product_version: typeof health.product_version === "string" ? health.product_version : null,
    workflow_runs: Number.isFinite(health.workflow_runs) ? health.workflow_runs : null,
    heartbeats: Number.isFinite(health.heartbeats) ? health.heartbeats : null
  },
  setup: {
    activation_status: setup.activation?.status === "unlocked" ? "unlocked" : "not_unlocked",
    required_steps: requiredSteps
  }
});
console.log(JSON.stringify(summary, null, 2));

if (health.ok !== true || requiredSteps === null || requiredSteps.length !== 0) process.exit(1);
NODE
