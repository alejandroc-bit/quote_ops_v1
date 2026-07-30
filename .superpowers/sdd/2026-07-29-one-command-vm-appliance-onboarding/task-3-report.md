# Task 3 Report — Stable One-Command Ubuntu Bootstrap and Runtime Layout

## Status

Implemented and verified. The public bootstrap is release-pinned and checksum-verified, the installer separates immutable runtime files from persistent data/secrets, `current` switches atomically, and the stable operator CLI dispatches through the active release.

## Implementation

- Added `GET /install/quoteops`, loading only `dist/appliance/$QUOTEOPS_APPLIANCE_RELEASE_VERSION/bootstrap.sh`, verifying its exact detached `SHA256SUMS` entry, replacing the single canonical-origin placeholder, and serving `text/x-shellscript` with `no-store` and `no-referrer`.
- Added the Ubuntu 24.04/linux-amd64 bootstrap with signed Ubuntu/Docker apt repositories, hidden `/dev/tty` token prompting, protected curl config/token files, authenticated `/api/install` download, Docker daemon validation, and bounded Darwin-only acceptance mode.
- Added release staging under `releases/$VERSION.tmp`, immutable validation, final rename, portable atomic `current` switching, exact release-env allowlisting, guided digest enforcement, and the explicit deprecated `legacy_direct` fallback.
- Added persistent data roots for manifests, criteria, connectors, secrets, settings, state, logs, and backups.
- Added root/current-user-owned `0600` client and Cloudflare secret files; PostgreSQL password and registration token are generated/copied once and preserved across reinstalls. Shared `.env` contains paths and safe settings only.
- Added the stable wrapper and release-local `quoteops status|doctor|onboard|update|rollback|backup|restore|logs` dispatcher plus install verification.
- Converted Compose to required release-env image references, linux/amd64 only for the four application services, required long-syntax client env files only for PostgreSQL/agent/API/onboarding, and a reserved cloudflared image interface without Task 4 tunnel behavior.
- Preserved legacy direct installs and added idempotence, different-client rejection, secret preservation, hostile-host, missing-asset, checksum-mismatch, and Mac layout coverage.

## Files Changed

- `apps/control-plane-api/src/index.ts`
- `apps/control-plane-api/src/installerScript.ts`
- `apps/control-plane-api/tests/control-plane-api.test.ts`
- `apps/control-plane/tests/task-d-deploy.test.ts`
- `deploy/appliance/bootstrap.sh` (new, executable)
- `deploy/appliance/docker-compose.yml`
- `deploy/appliance/install.sh`
- `deploy/appliance/quoteops.sh` (new, executable)
- `deploy/appliance/tests/smoke.sh`
- `deploy/appliance/verify-install.sh` (new, executable)
- `.superpowers/sdd/2026-07-29-one-command-vm-appliance-onboarding/task-3-report.md`

## RED

Command:

```bash
npx vitest run apps/control-plane-api/tests/control-plane-api.test.ts
```

Observed:

```text
exit=1
apps/control-plane-api/tests/control-plane-api.test.ts (41 tests | 1 failed)
renders the stable one-command bootstrap without exposing credentials
expected 404 to be 200
Tests 1 failed | 40 passed
```

Command:

```bash
bash deploy/appliance/tests/smoke.sh
```

Observed:

```text
exit=1
smoke.sh: docker daemon not available; checked schema constraints by grep
install.sh: unknown argument: --registration-token-file
```

## GREEN and Focused Verification

Commands:

```bash
bash -n deploy/appliance/bootstrap.sh
bash -n deploy/appliance/install.sh
bash -n deploy/appliance/quoteops.sh
bash -n deploy/appliance/verify-install.sh
npx vitest run apps/control-plane-api/tests/control-plane-api.test.ts
bash deploy/appliance/tests/smoke.sh
```

Observed:

```text
All four bash syntax checks: exit=0
Control-plane API: 1 file passed, 42 tests passed
Appliance smoke: exit=0, smoke.sh: ok
```

The smoke preserved the first PostgreSQL password and registration token on a same-release reinstall, kept secrets out of shared `.env`, rejected a different client without moving `current`, and rendered all four application services for linux/amd64 when Compose is available.

## Build and Full Suite

Command:

```bash
npm run build:ts
```

Observed:

```text
exit=0
tsc -b --force packages/shared packages/contracts packages/quote-core packages/audit packages/criteria packages/connectors packages/knowledge apps/agent apps/api apps/control-plane apps/control-plane-api
```

Command:

```bash
npm test
```

Observed:

```text
exit=0
Test Files 46 passed (46)
Tests 405 passed (405)
```

Manual bounded-Mac bootstrap smoke with mocked Docker/download transport:

```text
physical_tmp=/private/var/...
bounded_alias_pass=true
wrong_prefix_rejected=true
below_root_symlink_rejected=true
```

## Self-Review

- `git diff --check`: clean.
- Verified bootstrap URL comes only from configured canonical origin; hostile request host headers do not affect output.
- Verified registration tokens are passed through `0600` files/curl config and never embedded in URL paths or generated installer bytes.
- Verified shared `.env` does not write password, registration-token, API-key, or image fallback values.
- Verified guided releases reject missing versions, `--registration-token`, unknown release-env keys, `latest`, and non-digest image references.
- Verified `current` uses a temporary absolute symlink plus GNU `mv -Tf` / BSD `mv -hf`, then checks the exact target.
- Verified Web/Caddy do not receive the client secret env; cloudflared behavior remains deferred to Task 4.

## Concerns

- The local Docker daemon was unavailable, so the smoke used static Compose assertions and the existing mock-Docker lifecycle test; the Docker-backed PostgreSQL schema smoke and real `docker compose config` branch reported their normal skip.
- Ubuntu apt/Docker repository installation cannot be executed on this Mac. The bootstrap production branch is syntax-checked and constrained to Ubuntu 24.04 x86_64; a real Ubuntu VM remains the appropriate final infrastructure acceptance environment.
