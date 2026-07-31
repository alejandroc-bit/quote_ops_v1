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
