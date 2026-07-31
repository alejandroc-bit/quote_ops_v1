#!/usr/bin/env bash
# Disposable Ubuntu 24.04 AMD64 bootstrap gate for the QuoteOps appliance.
#
# Spins up a throwaway Ubuntu 24.04 linux/amd64 VM under Lima/QEMU on this Mac,
# drives the REAL staging bootstrap (GET /install/quoteops) with the secure
# token-file automation branch and a bounded answers directory, and asserts the
# Ubuntu bootstrap path (apt, signed Docker repo, release pinning, identity
# binding, immutable releases) before onboarding intentionally stops at the live
# AI validation step (deliberately invalid, non-secret AI probe key). The fake
# key must never be persisted.
#
# This gate is intentionally separate from the Mac runtime journey
# (macbook-acceptance.sh): Mac test mode skips Ubuntu detection and apt, while
# this gate proves the real Ubuntu bootstrap. No repository checkout, bind
# mount, preinstalled Docker, QUOTEOPS_BOOTSTRAP_TEST_MODE, or locally built
# application image is allowed here.
#
# The VM is destroyed by default, even after a failure. --keep retains the exact
# VM/instance for debugging and prints the cleanup command. --cleanup loads the
# deterministic state file and tears down a previously retained run.
set -Eeuo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd -P)"
FIXTURE_DIR="$REPO_ROOT/deploy/appliance/tests/fixtures"

die() { printf 'ubuntu-vm-bootstrap-acceptance: %s\n' "$*" >&2; exit 1; }

file_mode() {
  local mode
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then mode="$(stat -f '%Lp' "$1")"
  else mode="$(stat -c '%a' "$1")"; fi
  printf '%s\n' "$mode"
}

usage() {
  cat <<USAGE
Usage: $(basename "$0") --run [options]
       $(basename "$0") --cleanup
       $(basename "$0") [--help]

Options:
  --run       Execute the disposable Ubuntu 24.04 AMD64 bootstrap gate. Required
              to actually run; without it the script only prints this help.
  --keep      Retain the exact VM instance + bounded Lima root after a FAILED
              run for debugging. Prints the exact instance name + cleanup command.
  --cleanup   Load the deterministic state file and tear down a previously
              retained run. Non-destructive on missing/invalid state.
  -h, --help  Show this help.

Required environment:
  E2E_CONTROL_PLANE_URL                 HTTPS staging control-plane origin
  E2E_EXPECTED_CLIENT_ID                production client-ID (schema-validated)
  E2E_EXPECTED_INSTALLATION_ID          installation-ID (schema-validated)
  E2E_UBUNTU_REGISTRATION_TOKEN_FILE    0600 single-use staging token (<=15m TTL)
  E2E_UBUNTU_IMAGE_URL                  Ubuntu 24.04 cloud-image URL (HTTPS)
  E2E_UBUNTU_IMAGE_SHA256               64-hex sha256 of the cloud image
USAGE
}

E2E_UBUNTU_STATE_FILE="${TMPDIR:-/tmp}/quoteops-ubuntu-acceptance-${UID}.json"
CLIENT_ID_RE='^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$'
INSTALLATION_ID_RE='^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$'
HTTPS_RE='^https://[A-Za-z0-9._:-]'
SHA256_RE='^[0-9a-f]{64}$'
FAKE_AI_KEY="ubuntu-e2e-invalid-ai-probe-not-a-secret-INVALID"
VM_WORK="/tmp/quoteops-ubuntu-e2e"

# ---------------------------------------------------------------------------
# Mode parsing
# ---------------------------------------------------------------------------
ACTION="help"
KEEP=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --run) ACTION="run"; shift;;
    --keep) KEEP=1; shift;;
    --cleanup) ACTION="cleanup"; shift;;
    -h|--help) ACTION="help"; shift;;
    *) die "unknown option: $1";;
  esac
done

# ---------------------------------------------------------------------------
# Cleanup mode: load deterministic 0600 state, stop/delete the exact instance
# ---------------------------------------------------------------------------
if [[ "$ACTION" == "cleanup" ]]; then
  if [[ ! -f "$E2E_UBUNTU_STATE_FILE" ]]; then
    printf 'no state file at %s (nothing to clean)\n' "$E2E_UBUNTU_STATE_FILE"
    exit 0
  fi
  [[ "$(file_mode "$E2E_UBUNTU_STATE_FILE")" == "600" ]] || { printf 'state file not 0600 (refusing): %s\n' "$E2E_UBUNTU_STATE_FILE" >&2; exit 2; }
  STATE="$(cat "$E2E_UBUNTU_STATE_FILE")"
  C_LIMA="$(printf '%s' "$STATE" | jq -r '.lima_home // empty')"
  C_INSTANCE="$(printf '%s' "$STATE" | jq -r '.instance // empty')"
  [[ "$C_LIMA" == "${TMPDIR:-/tmp}"/quoteops-ubuntu-e2e.* ]] || { printf 'refusing unsafe lima home: %s\n' "$C_LIMA" >&2; exit 2; }
  [[ "$C_INSTANCE" == quoteops-ubuntu-e2e-* ]] || { printf 'refusing unsafe instance: %s\n' "$C_INSTANCE" >&2; exit 2; }
  printf 'cleaning instance=%s lima_home=%s\n' "$C_INSTANCE" "$C_LIMA"
  LIMA_HOME="$C_LIMA" limactl stop "$C_INSTANCE" >/dev/null 2>&1 || true
  LIMA_HOME="$C_LIMA" limactl delete "$C_INSTANCE" >/dev/null 2>&1 || true
  rm -rf "$C_LIMA"
  rm -f "$E2E_UBUNTU_STATE_FILE"
  printf 'cleanup done\n'
  exit 0
fi

if [[ "$ACTION" == "help" ]]; then
  usage
  exit 0
fi

# ---------------------------------------------------------------------------
# Preflight: fail closed, print only missing names, never values
# ---------------------------------------------------------------------------
PREFLIGHT_FAIL=()

if [[ "$(uname -m)" != "arm64" ]]; then PREFLIGHT_FAIL+=("uname -m == arm64"); fi
for c in limactl qemu-system-x86_64 jq curl; do
  command -v "$c" >/dev/null 2>&1 || PREFLIGHT_FAIL+=("$c")
done

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
check_file_0600 E2E_UBUNTU_REGISTRATION_TOKEN_FILE
check_env_match E2E_EXPECTED_CLIENT_ID "$CLIENT_ID_RE"
check_env_match E2E_EXPECTED_INSTALLATION_ID "$INSTALLATION_ID_RE"
if [[ -z "${E2E_UBUNTU_IMAGE_URL:-}" ]] || ! [[ "${E2E_UBUNTU_IMAGE_URL}" =~ $HTTPS_RE ]]; then
  PREFLIGHT_FAIL+=("E2E_UBUNTU_IMAGE_URL")
fi
if [[ -z "${E2E_UBUNTU_IMAGE_SHA256:-}" ]] || ! [[ "${E2E_UBUNTU_IMAGE_SHA256}" =~ $SHA256_RE ]]; then
  PREFLIGHT_FAIL+=("E2E_UBUNTU_IMAGE_SHA256")
fi

if [[ ${#PREFLIGHT_FAIL[@]} -gt 0 ]]; then
  printf 'ubuntu-vm-bootstrap-acceptance: missing preflight inputs:\n' >&2
  printf '  %s\n' "${PREFLIGHT_FAIL[@]}" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Bounded Lima root + state file
# ---------------------------------------------------------------------------
LIMA_HOME="$(mktemp -d "${TMPDIR:-/tmp}/quoteops-ubuntu-e2e.XXXXXX")"
INSTANCE="quoteops-ubuntu-e2e-$(date +%s)-$$"
[[ "$LIMA_HOME" == "${TMPDIR:-/tmp}"/quoteops-ubuntu-e2e.* ]] || die "unsafe lima home: $LIMA_HOME"
[[ "$INSTANCE" == quoteops-ubuntu-e2e-* ]] || die "unsafe instance name: $INSTANCE"

write_state() {
  local tmp_state
  tmp_state="$(mktemp "$LIMA_HOME/state.XXXXXX")"
  jq -n \
    --arg lima_home "$LIMA_HOME" \
    --arg instance "$INSTANCE" \
    --arg created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{lima_home:$lima_home, instance:$instance, created_at:$created_at}' \
    > "$tmp_state"
  chmod 0600 "$tmp_state"
  mv "$tmp_state" "$E2E_UBUNTU_STATE_FILE"
  chmod 0600 "$E2E_UBUNTU_STATE_FILE"
}

# Refuse a new run while a retained instance is still on disk.
if [[ -f "$E2E_UBUNTU_STATE_FILE" ]]; then
  PREV_INSTANCE="$(jq -r '.instance // empty' "$E2E_UBUNTU_STATE_FILE" 2>/dev/null || true)"
  PREV_LIMA="$(jq -r '.lima_home // empty' "$E2E_UBUNTU_STATE_FILE" 2>/dev/null || true)"
  if [[ "$PREV_INSTANCE" == quoteops-ubuntu-e2e-* && -d "$PREV_LIMA" ]] \
     && LIMA_HOME="$PREV_LIMA" limactl ls "$PREV_INSTANCE" >/dev/null 2>&1; then
    die "a previous retained run exists (instance=$PREV_INSTANCE); clean it first with: bash $0 --cleanup"
  fi
  rm -f "$E2E_UBUNTU_STATE_FILE"
fi

write_state

# vm helpers
vm_root() {
  LIMA_HOME="$LIMA_HOME" limactl exec "$INSTANCE" -- sudo bash -lc "$1"
}
vm_user() {
  LIMA_HOME="$LIMA_HOME" limactl exec "$INSTANCE" -- bash -lc "$1"
}

cleanup() {
  local code=$?
  if [[ "$KEEP" == "1" && $code -ne 0 ]]; then
    printf 'ubuntu-vm-bootstrap-acceptance: retained VM for debugging: instance=%s\n' "$INSTANCE" >&2
    printf 'ubuntu-vm-bootstrap-acceptance: lima_home=%s\n' "$LIMA_HOME" >&2
    printf 'ubuntu-vm-bootstrap-acceptance: to clean: bash %s --cleanup\n' "$0" >&2
    printf 'ubuntu-vm-bootstrap-acceptance: revoke the dedicated staging token now if activation did not consume it (short TTL is the fallback)\n' >&2
    return 0
  fi
  LIMA_HOME="$LIMA_HOME" limactl stop "$INSTANCE" >/dev/null 2>&1 || true
  LIMA_HOME="$LIMA_HOME" limactl delete "$INSTANCE" >/dev/null 2>&1 || true
  [[ "${LIMA_HOME:-}" == "${TMPDIR:-/tmp}"/quoteops-ubuntu-e2e.* ]] && rm -rf "$LIMA_HOME"
  rm -f "$E2E_UBUNTU_STATE_FILE" 2>/dev/null || true
  printf 'ubuntu-vm-bootstrap-acceptance: revoke the dedicated staging token now if activation did not consume it (short TTL is the fallback)\n' >&2
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Generate the minimal Lima config (qemu, x86_64, no Docker provisioning)
# ---------------------------------------------------------------------------
LIMA_CONFIG="$LIMA_HOME/$INSTANCE.yaml"
cat > "$LIMA_CONFIG" <<YAML
vmType: qemu
arch: x86_64
os: Linux
image:
  location: ${E2E_UBUNTU_IMAGE_URL}
  digest: sha256:${E2E_UBUNTU_IMAGE_SHA256}
cpus: 2
memory: 2GiB
disk: 10GiB
mounts: []
ssh:
  loadDotSSHPubKeys: false
containerd:
  system: false
  user: false
provision: []
YAML
chmod 0600 "$LIMA_CONFIG"

# ---------------------------------------------------------------------------
# Boot the VM (capped wait)
# ---------------------------------------------------------------------------
LIMA_HOME="$LIMA_HOME" limactl start --tty=false --name "$INSTANCE" "$LIMA_CONFIG" \
  > "$LIMA_HOME/start.log" 2>&1 || die "lima start failed (see $LIMA_HOME/start.log)"

vm_running=0
for _ in $(seq 1 60); do
  status="$(LIMA_HOME="$LIMA_HOME" limactl ls "$INSTANCE" --json 2>/dev/null | jq -r '.status // empty' 2>/dev/null || true)"
  [[ "$status" == "running" ]] && { vm_running=1; break; }
  sleep 5
done
[[ "$vm_running" == "1" ]] || die "VM did not reach running state (see $LIMA_HOME/start.log)"

# Reject a base VM where docker already exists (no preinstalled Docker allowed).
if vm_root 'command -v docker >/dev/null 2>&1' 2>/dev/null; then
  die "base VM already has docker installed; refusing to proceed"
fi

# ---------------------------------------------------------------------------
# Copy (not interpolate) the token + invalid AI probe + readiness knowledge
# ---------------------------------------------------------------------------
printf '%s' "$FAKE_AI_KEY" > "$LIMA_HOME/ai-key"
chmod 0600 "$LIMA_HOME/ai-key"

cat > "$LIMA_HOME/answers.json" <<'JSON'
{
  "schema_version": 1,
  "ai_provider": {
    "provider": "openrouter",
    "api_key": { "file": "/run/quoteops-onboard-input/ai-key" }
  },
  "activation": {
    "authorized_email": "ubuntu-e2e-not-activated@quoteops.invalid"
  },
  "knowledge": {
    "sources": [{ "file": "/run/quoteops-onboard-input/readiness-knowledge.md" }],
    "consent_external_embedding_transfer": true
  },
  "accept_generated_profiles": true,
  "accept_default_authorization": true,
  "accept_sample_prices": true
}
JSON
chmod 0600 "$LIMA_HOME/answers.json"

vm_user "mkdir -p '$VM_WORK' && chmod 0700 '$VM_WORK'"
LIMA_HOME="$LIMA_HOME" limactl cp "$E2E_UBUNTU_REGISTRATION_TOKEN_FILE" "$INSTANCE:$VM_WORK/token" \
  || die "could not copy registration token into VM"
LIMA_HOME="$LIMA_HOME" limactl cp "$LIMA_HOME/ai-key" "$INSTANCE:$VM_WORK/ai-key" \
  || die "could not copy AI probe file into VM"
LIMA_HOME="$LIMA_HOME" limactl cp "$FIXTURE_DIR/readiness-knowledge.md" "$INSTANCE:$VM_WORK/readiness-knowledge.md" \
  || die "could not copy readiness knowledge into VM"
LIMA_HOME="$LIMA_HOME" limactl cp "$LIMA_HOME/answers.json" "$INSTANCE:$VM_WORK/answers.json" \
  || die "could not copy answers.json into VM"
vm_root "chown root:root '$VM_WORK/token' '$VM_WORK/ai-key' '$VM_WORK/readiness-knowledge.md' '$VM_WORK/answers.json' && chmod 0600 '$VM_WORK/token' '$VM_WORK/ai-key' '$VM_WORK/readiness-knowledge.md' '$VM_WORK/answers.json'"

# ---------------------------------------------------------------------------
# Invoke the real staging bootstrap inside the VM (secure token-file branch,
# bounded answers dir; no QUOTEOPS_BOOTSTRAP_TEST_MODE, no local image build)
# ---------------------------------------------------------------------------
REMOTE_BOOTSTRAP="$LIMA_HOME/remote-bootstrap.sh"
cat > "$REMOTE_BOOTSTRAP" <<REMOTE
#!/usr/bin/env bash
set -Eeuo pipefail
CP_URL='$E2E_CONTROL_PLANE_URL'
WORK='$VM_WORK'
curl --proto "=https" --proto-redir "=https" --tlsv1.2 -fsSL \\
  -o /tmp/quoteops-bootstrap.sh "\$CP_URL/install/quoteops"
chmod 700 /tmp/quoteops-bootstrap.sh
QUOTEOPS_REGISTRATION_TOKEN_FILE="\$WORK/token" \\
QUOTEOPS_AUTOMATION_MODE=1 \\
QUOTEOPS_CONTROL_PLANE_URL="\$CP_URL" \\
bash /tmp/quoteops-bootstrap.sh --answers-dir "\$WORK"
REMOTE
chmod 0600 "$REMOTE_BOOTSTRAP"

LIMA_HOME="$LIMA_HOME" limactl cp "$REMOTE_BOOTSTRAP" "$INSTANCE:/tmp/quoteops-remote-bootstrap.sh" \
  || die "could not copy remote bootstrap script into VM"
set +e
LIMA_HOME="$LIMA_HOME" limactl exec "$INSTANCE" -- sudo bash /tmp/quoteops-remote-bootstrap.sh \
  > "$LIMA_HOME/bootstrap.out" 2> "$LIMA_HOME/bootstrap.err"
BOOTSTRAP_RC=$?
set -e
# Onboarding is expected to stop at live AI validation (nonzero rc). A zero rc
# would mean the invalid key was accepted, which is a gate failure.
[[ "$BOOTSTRAP_RC" -ne 0 ]] || die "staging bootstrap completed with an invalid AI key; gate failed"

# ---------------------------------------------------------------------------
# Assert onboarding stopped specifically at live AI validation
# ---------------------------------------------------------------------------
SUMMARY_JSON="$(vm_root 'cat /opt/quoteops-v1/settings/install-summary.json 2>/dev/null || echo {}' 2>/dev/null || printf '{}')"
jq -e '
  has("ai_validation") and
  .ai_validation.provider == "openrouter" and
  .ai_validation.live_request == true and
  .ai_validation.fallback == false and
  (.ai_validation.validated == false or .ai_validation.validated == null)
' <<<"$SUMMARY_JSON" >/dev/null \
  || die "onboarding did not stop at live AI validation"

# Assert the deliberately invalid AI key was not persisted to client.env.
CLIENT_ENV_DUMP="$LIMA_HOME/client.env.dump"
vm_root 'cat /opt/quoteops-v1/secrets/client.env 2>/dev/null || true' > "$CLIENT_ENV_DUMP" 2>/dev/null || true
chmod 0600 "$CLIENT_ENV_DUMP"
if grep -Fq "$FAKE_AI_KEY" "$CLIENT_ENV_DUMP" 2>/dev/null; then
  die "the deliberately invalid AI key was persisted to client.env"
fi

# ---------------------------------------------------------------------------
# Post-asserts inside the VM (collected via one remote script; safe markers)
# ---------------------------------------------------------------------------
PINNED_VM="$(vm_root 'sed -n "s/^QUOTEOPS_VERSION=//p" /opt/quoteops-v1/current/release.env 2>/dev/null | tr -d "\""' 2>/dev/null || true)"
[[ "$PINNED_VM" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "could not read pinned release version from VM"

ASSERT_SCRIPT="$LIMA_HOME/post-asserts.sh"
cat > "$ASSERT_SCRIPT" <<ASSERT
#!/usr/bin/env bash
set -uo pipefail
PINNED='$PINNED_VM'
CP_URL='$E2E_CONTROL_PLANE_URL'
CLIENT_ID='$E2E_EXPECTED_CLIENT_ID'
INSTALL_ID='$E2E_EXPECTED_INSTALLATION_ID'

. /etc/os-release
[[ "\${ID}" == "ubuntu" && "\${VERSION_ID}" == "24.04" ]] || { echo "not-ubuntu-24.04"; exit 1; }
[[ "\$(uname -m)" == "x86_64" ]] || { echo "not-x86_64"; exit 1; }
test -f /etc/apt/sources.list.d/docker.list || { echo "no-docker-apt-source"; exit 1; }
grep -q "signed-by=/etc/apt/keyrings/docker.asc" /etc/apt/sources.list.d/docker.list || { echo "docker-apt-not-signed"; exit 1; }
grep -q "https://download.docker.com/linux/ubuntu" /etc/apt/sources.list.d/docker.list || { echo "docker-apt-not-official"; exit 1; }
systemctl is-enabled docker.service >/dev/null || { echo "docker-not-enabled"; exit 1; }
systemctl is-active docker.service >/dev/null || { echo "docker-not-active"; exit 1; }
DC="\$(docker compose version --short 2>/dev/null | sed 's/^v//')"
DC_M="\${DC%%.*}"; DC_R="\${DC#*.}"; DC_m="\${DC_R%%.*}"
[[ "\${DC_M}" =~ ^[0-9]+\$ ]] || DC_M=0
[[ "\${DC_m}" =~ ^[0-9]+\$ ]] || DC_m=0
if (( DC_M < 2 || (DC_M == 2 && DC_m < 24) )); then echo "docker-compose-too-old"; exit 1; fi
test -d "/opt/quoteops-v1/releases/\${PINNED}" || { echo "pinned-release-missing"; exit 1; }
[ "\$(stat -c %u /opt/quoteops-v1/releases/\${PINNED})" = 0 ] || { echo "pinned-release-not-root"; exit 1; }
if sudo -u nobody test -w "/opt/quoteops-v1/releases/\${PINNED}" 2>/dev/null; then echo "pinned-release-writable-by-nonroot"; exit 1; fi
[ "\$(readlink /opt/quoteops-v1/current)" = "/opt/quoteops-v1/releases/\${PINNED}" ] || { echo "current-symlink-wrong"; exit 1; }
test -x /usr/local/bin/quoteops || { echo "quoteops-wrapper-missing"; exit 1; }
[ "\$(stat -c %u /usr/local/bin/quoteops)" = 0 ] || { echo "quoteops-wrapper-not-root"; exit 1; }
test -f /opt/quoteops-v1/secrets/client.env || { echo "client-env-missing"; exit 1; }
[ "\$(stat -c %a /opt/quoteops-v1/secrets/client.env)" = 600 ] || { echo "client-env-mode"; exit 1; }
[ "\$(stat -c %u /opt/quoteops-v1/secrets/client.env)" = 0 ] || { echo "client-env-owner"; exit 1; }
test -f /opt/quoteops-v1/secrets/cloudflare.env || { echo "cloudflare-env-missing"; exit 1; }
[ "\$(stat -c %a /opt/quoteops-v1/secrets/cloudflare.env)" = 600 ] || { echo "cloudflare-env-mode"; exit 1; }
[ "\$(stat -c %u /opt/quoteops-v1/secrets/cloudflare.env)" = 0 ] || { echo "cloudflare-env-owner"; exit 1; }
grep -q "^QUOTEOPS_CONTROL_PLANE_URL=\"\${CP_URL}\"\$" /opt/quoteops-v1/.env || { echo "cp-url-mismatch"; exit 1; }
grep -q "^QUOTEOPS_CLIENT_ID=\"\${CLIENT_ID}\"\$" /opt/quoteops-v1/.env || { echo "client-id-mismatch"; exit 1; }
grep -q "^QUOTEOPS_INSTALLATION_ID=\"\${INSTALL_ID}\"\$" /opt/quoteops-v1/.env || { echo "installation-id-mismatch"; exit 1; }
echo "post-asserts-ok"
ASSERT

LIMA_HOME="$LIMA_HOME" limactl cp "$ASSERT_SCRIPT" "$INSTANCE:/tmp/quoteops-post-asserts.sh" \
  || die "could not copy post-assert script into VM"
set +e
LIMA_HOME="$LIMA_HOME" limactl exec "$INSTANCE" -- sudo bash /tmp/quoteops-post-asserts.sh \
  > "$LIMA_HOME/post-asserts.out" 2>&1
ASSERT_RC=$?
set -e
[[ "$ASSERT_RC" == "0" ]] || die "VM post-asserts failed: $(tr '\n' ' ' < "$LIMA_HOME/post-asserts.out")"

# ---------------------------------------------------------------------------
# Secret-leak scan: token + POSTGRES_PASSWORD absent from argv/journal/evidence
# ---------------------------------------------------------------------------
TOKEN_VALUE="$(cat "$E2E_UBUNTU_REGISTRATION_TOKEN_FILE")"
LEAK_FILES=( "$LIMA_HOME/bootstrap.out" "$LIMA_HOME/bootstrap.err" "$LIMA_HOME/post-asserts.out" )
if grep -Fq "$TOKEN_VALUE" "${LEAK_FILES[@]}" 2>/dev/null; then
  die "registration token leaked into captured bootstrap output"
fi
if grep -Eq 'POSTGRES_PASSWORD=' "${LEAK_FILES[@]}" 2>/dev/null; then
  die "POSTGRES_PASSWORD leaked into captured bootstrap output"
fi

JOURNAL_DUMP="$LIMA_HOME/journal.dump"
vm_root 'journalctl --no-pager -u quoteops -u quoteops-onboard 2>/dev/null || true' > "$JOURNAL_DUMP" 2>/dev/null || true
chmod 0600 "$JOURNAL_DUMP"
if grep -Fq "$TOKEN_VALUE" "$JOURNAL_DUMP" 2>/dev/null; then
  die "registration token leaked into journal output"
fi
if grep -Eq 'POSTGRES_PASSWORD=' "$JOURNAL_DUMP" 2>/dev/null; then
  die "POSTGRES_PASSWORD leaked into journal output"
fi
if grep -Fq "$FAKE_AI_KEY" "$JOURNAL_DUMP" 2>/dev/null; then
  die "deliberately invalid AI key leaked into journal output"
fi

# ---------------------------------------------------------------------------
# Success
# ---------------------------------------------------------------------------
printf 'UBUNTU VM BOOTSTRAP ACCEPTANCE: PASS\n'
