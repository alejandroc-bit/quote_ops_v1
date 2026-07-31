# Bug Report: `lifecycle.sh` fails in GitHub Actions CI (passes locally)

## Summary

The `release.yml` workflow's `verify` job fails at `bash deploy/appliance/tests/lifecycle.sh` with:

```
lifecycle.sh: missing Access input did not print a safe resume command
```

This passes locally on macOS but fails on GitHub Actions `ubuntu-latest` runners.

## Environment

- **Branch:** `main` (tag `v0.2.0`, commit `f2688bc`)
- **Workflow:** `release-appliance` (`.github/workflows/release.yml`), job `verify`
- **CI runner:** `ubuntu-latest`, `bash -e` (GitHub Actions default shell)
- **Local:** macOS arm64, Docker Desktop, `bash` 5.x — passes every time

## Reproduction

The failing workflow run: `gh run view 30664885937 -R alejandroc-bit/quote_ops_v1`

Failed log line:
```
verify  Run bash deploy/appliance/tests/lifecycle.sh  lifecycle.sh: missing Access input did not print a safe resume command
```

Local (passes):
```bash
bash deploy/appliance/tests/lifecycle.sh
# → lifecycle: update, rollback, backup, restore preflight, and restore recovery checks passed
```

## Root Cause Analysis (incomplete — needs Codex)

The failing assertion is at `deploy/appliance/tests/lifecycle.sh:448-449`:

```bash
if PATH="$MOCK_BIN:/usr/bin:/bin" \
  ... \
  bash "$APPLIANCE_HOME/current/upgrade.sh" --to v0.2.1 \
    >"$WORK_DIR/missing-access.log" 2>&1; then
  fail "non-interactive tunnel update accepted missing Access input"
fi
grep -Fq -- '--cloudflare-access-file' "$WORK_DIR/missing-access.log" ||
  fail "missing Access input did not print a safe resume command"
```

The test expects `upgrade.sh` to die with a message containing `--cloudflare-access-file`. The relevant `die` is at `deploy/appliance/upgrade.sh:305-306`:

```bash
if [[ -z "$source" ]]; then
  [[ -t 0 && -r /dev/tty ]] ||
    die "Cloudflare Access credentials required; resume with --cloudflare-access-file /absolute/mode-0600-file"
```

The `die()` function writes to `>&2` (stderr), and the test captures `2>&1`, so the message should be in the log.

### Hypothesis (unconfirmed)

On macOS, `/dev/tty` is readable even when stdin is not a terminal (`[[ -r /dev/tty ]]` returns true). On GitHub Actions `ubuntu-latest`, `/dev/tty` may not exist or not be readable, so the `die` fires. **However**, the `die` message DOES contain `--cloudflare-access-file`, so the `grep -Fq` should still match.

This suggests the script is **dying before reaching line 306** — likely at one of the earlier validation steps (`need_command`, `validate_cloudflare_json`, `validate_deployment_json`, the curl download, or `access_preflight`) — with a different error message that does NOT contain `--cloudflare-access-file`.

Possible culprits to investigate:

1. **`need_command docker` (line 416):** The test uses `MOCK_BIN` with a fake `docker`, but on CI `ubuntu-latest` the real Docker is also on `/usr/bin`. The mock should take precedence (it's first in PATH), but the mock's behavior may diverge from what `upgrade.sh` expects when called by the real Docker daemon.

2. **`validate_cloudflare_json` (line 469):** The test creates `settings/cloudflare.json` with `{"enabled":true}`. If the validator expects additional fields (e.g., `provider`, `tunnel_name`), it may `die` before reaching the Access check. This would pass locally only if the local `jq` version handles the schema differently.

3. **`access_preflight` or pre-download steps (lines 474-540):** The curl mock or release staging may fail differently on CI.

4. **`/dev/tty` behavior difference:** On GitHub Actions, `/dev/tty` may not exist at all, causing `[[ -r /dev/tty ]]` to return false and trigger the `die`. But this would produce the CORRECT message. The fact that the grep fails means either (a) the script died elsewhere, or (b) the `die` output is not reaching the log file for some shell-redirection reason under `bash -e`.

### What Codex needs to do

1. Add `set -x` or a debug trap to `upgrade.sh` temporarily, or have `lifecycle.sh` dump `$WORK_DIR/missing-access.log` on failure, to see the ACTUAL error message that `upgrade.sh` prints when it dies before the Access check.
2. Reproduce on `ubuntu-latest` (e.g., via `act` or a draft workflow that just runs `lifecycle.sh`).
3. Fix the root cause so the script reaches `copy_access_credentials` and prints the correct resume message, OR fix the test to handle the CI-specific death path.

## Impact

- Blocks the `v0.2.0` release: `release.yml` cannot pass the `verify` job, so `build-and-push`, `package-appliance`, `publish-appliance`, and `deploy-control-plane` never run.
- No immutable appliance bundle is published to GitHub Releases.
- No release is synced to the control plane via `sync-bundled`.
- Customer install path (`GET /install/quoteops` → `bootstrap.sh` → `install.sh`) cannot download a real `v0.2.0` bundle.

## Related files

- `deploy/appliance/tests/lifecycle.sh` (test harness, line 448-449 is the failing assertion)
- `deploy/appliance/upgrade.sh` (script under test, lines 298-343 is `copy_access_credentials`, line 416 is `need_command docker`, line 469 is `validate_cloudflare_json`)
- `.github/workflows/release.yml` (the `verify` job that runs the test)
