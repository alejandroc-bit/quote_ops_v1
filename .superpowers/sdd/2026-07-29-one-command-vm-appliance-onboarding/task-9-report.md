# Task 9 — Lifecycle Operations and Release Delivery

Status: DONE_WITH_CONCERNS

## Outcome

Implemented the appliance release API, health-gated update and rollback lifecycle,
safe backup and restore recovery, a real N-1 schema compatibility gate, and the
release/CI delivery wiring.

The release API now authenticates exact-version downloads and machine-only bundled
release synchronization, validates immutable bundled artifacts, preserves
historical releases, and exposes only the installation-safe latest-release shape.

The appliance lifecycle now stages and verifies an exact semver release, protects
Cloudflare Access material, preserves immutable release directories, switches the
active symlink atomically, and performs a verified rollback of core services,
tunnel state, access material, and deployment pointers after a failed update.
Backups use an exact manifest and internal checksums, omit secrets and deployment
state, and restores complete every preflight before stopping services and recover
both files and PostgreSQL after a partial failure.

## TDD Evidence

RED:

- `npx vitest run apps/control-plane-api/tests/control-plane-api.test.ts`
  initially failed 3 assertions: unsafe latest-release shape, anonymous exact
  download returning 404 instead of 401, and missing sync endpoint returning 404
  instead of 401.
- `bash deploy/appliance/tests/lifecycle.sh` initially failed because
  `upgrade.sh` did not support `--cloudflare-access-file`.

GREEN:

- `npx vitest run apps/control-plane-api/tests/control-plane-api.test.ts`:
  44/44 passed.
- `bash deploy/appliance/tests/lifecycle.sh`: update, rollback, backup, restore
  preflight, and restore recovery checks passed.
- `npx vitest run`: 50 files and 545/545 tests passed.
- `npm run build`: TypeScript and both Vite builds passed.
- `bash deploy/appliance/tests/smoke.sh`: passed; Docker-only checks were skipped
  because the local Docker daemon was unavailable.
- `bash -n` on appliance commands and tests: passed.
- `git diff --check`: passed.
- Release and CI workflows parsed as valid YAML; `vercel.json` parsed as valid
  JSON.
- A local deterministic appliance package fixture passed archive inventory,
  checksum, permission, manifest version, and payload file-count validation.

## Files Changed

- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `apps/control-plane-api/src/index.ts`
- `apps/control-plane-api/tests/control-plane-api.test.ts`
- `deploy/appliance/backup.sh`
- `deploy/appliance/restore.sh`
- `deploy/appliance/upgrade.sh`
- `deploy/appliance/tests/lifecycle.sh`
- `deploy/appliance/tests/n-minus-one-schema.sh`
- `vercel.json`

## Self-review

- Confirmed all lifecycle scripts and new test gates are executable.
- Confirmed no added `set -x`, token logging, insecure curl flags, JSON `eval`,
  broad destructive removal, TODO, or FIXME patterns.
- Confirmed the release workflow gates publication on anonymous digest pulls and
  an N-1 migration/read/backward-read Docker test before production deployment.
- Confirmed release sync and installation-auth verification run after deployment
  with credentials stored only in mode-0600 curl config files.

## Concern

The real Docker N-1 gate could not be executed locally because the Docker daemon
was unavailable. It is implemented as a mandatory release-workflow gate before
publication and is not configured to skip in CI.

## Fix R1 — Important Findings

Status: GREEN

### Corrections

1. Removed the production `--skip-backup` and
   `--skip-pre-restore-backup` arguments. Update and restore safety backups are
   mandatory. The only new test seam records lifecycle events when
   `QUOTEOPS_LIFECYCLE_TEST_MODE=1` is combined with the bounded
   `quoteops-cloudflare-gate.lifecycle.*/home` fixture root and its exact
   `commands.log`; it cannot bypass a backup and is not exposed by `quoteops`.
2. Restore now validates both current and restored Cloudflare settings before
   the safety backup or deployment mutation. If either enables the tunnel, it
   requires a caller-owned regular mode-0600 Access file or secure `/dev/tty`
   entry, copies a transient credential, retains it through target/recovery
   verification, and removes it only after verified success.
3. Backup now derives `required_secret_keys` from strict active agent and TMS
   schemas plus tunnel and SAKBE state. The fixture covers OpenRouter, OAuth
   mailbox, embeddings, an HTTP TMS auth-header reference, tunnel, and live
   SAKBE. Provider/auth aliases and unrelated stale keys are excluded, and a
   missing active key fails before PostgreSQL is read.
4. Lifecycle integration uses the real `verify-install.sh`. Exact success and
   automatic-rollback order covers response checksum, staging, Access
   preflight, mandatory backup, physical release env compose, tunnel start,
   internal health, tunnel connections, anonymous Access denial,
   authenticated origin/setup, transient cleanup, and deployment state.

### RED Evidence

- `bash deploy/appliance/tests/lifecycle.sh` first failed with
  `production update did not reject --skip-backup at argument parsing`.
- After removing bypasses, it failed because the old manifest did not derive
  the exact active secret list.
- With active derivation added, it failed because restore accepted missing
  Access credentials when only the restored settings enabled the tunnel.
- With the real verifier enabled, the exact order assertion exposed that the
  old fixture lacked checksum, staging, Access, switch, state, and cleanup
  evidence.

### GREEN Evidence

- `bash deploy/appliance/tests/lifecycle.sh`: passed with production bypass
  rejection, real-verifier success and automatic rollback, exact active secret
  derivation, unknown agent/TMS schema rejection, missing-active-key failure
  before `pg_dump`, restored-tunnel Access failure before backup/mutation, and
  partial-restore recovery.
- `npx vitest run apps/control-plane-api/tests/control-plane-api.test.ts`:
  44/44 passed.
- `npx vitest run`: 50 files and 545/545 tests passed.
- `npm run build`: TypeScript and both Vite builds passed.
- `bash deploy/appliance/tests/smoke.sh`: passed; Docker-only checks reported
  the local daemon unavailable.
- Shell syntax, executable-mode, workflow YAML, Vercel JSON, production
  backup-bypass absence, secret-output/insecure-curl/eval scans, and
  `git diff --check` passed. `shellcheck` was not installed locally.

## Fix R2 — Production Schema Parsing

Status: GREEN

### Corrections

1. Replaced the handwritten backup AWK parsers with a bounded Node CLI in the
   existing API image. It imports the production agent and TMS loaders, so
   backup validation now uses the same strict Zod/YAML schemas as runtime
   startup, including multiline SQL blocks and canonical/legacy HTTP shapes.
2. The CLI receives only available environment-key names, never values, and
   emits only a sorted newline-delimited required-key list. Invalid
   configuration errors are sanitized; the only specific diagnostic retained
   is the validated name of a missing active secret.
3. Backup invokes the pinned appliance runtime and compiled CLI through the
   existing `quoteops-onboard` service with `--rm --no-deps -T`. It fails
   closed on command failure, malformed/duplicate/unsorted output, unknown
   schema fields, symlinked configs, and missing active secrets before
   `pg_dump`.
4. Lifecycle fixtures cover file/CSV, canonical HTTP, legacy explicit HTTP,
   literal (`|`) and folded (`>`) multiline SQL queries/write statements,
   active agent/mailbox/embeddings/SAKBE/tunnel keys, and stale-key exclusion.

### RED Evidence

- `npx vitest run apps/api/tests/lifecycle-secret-keys.test.ts` first failed
  because `../src/lifecycleSecretKeys.js` did not exist.
- `bash deploy/appliance/tests/lifecycle.sh` first failed with
  `active TMS config failed exact-schema validation`; the handwritten parser
  rejected the production-valid multiline SQL fixture and created no backup.

### GREEN Evidence

- `npx vitest run apps/api/tests/lifecycle-secret-keys.test.ts`: 9/9 passed,
  including sanitized failure output.
- `bash deploy/appliance/tests/lifecycle.sh`: passed with all R1 recovery/order
  assertions plus every production adapter shape, both multiline SQL styles,
  stale-key exclusion, unknown-field rejection, and missing-active rejection.
- `npx vitest run`: 51 files and 554/554 tests passed.
- `npm run build`: TypeScript and both Vite builds passed.
- `bash deploy/appliance/tests/smoke.sh`: passed; Docker-only checks reported
  the local daemon unavailable.
- Shell syntax, executable modes, removal of both handwritten parser
  functions, pinned runtime/CLI paths, secret-output/eval/debug scans, and
  `git diff --check` passed.
