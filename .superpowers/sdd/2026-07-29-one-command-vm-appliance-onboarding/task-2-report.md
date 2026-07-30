# Task 2 Report — Release-Pinned Registration Tokens and Install Packs

## Implementation

- Split the safe `InstallPack` from the one-time `IssuedInstallPack`, added the immutable release pin and strict schema, removed credentials from the command/snapshot, and normalized issuance to a configured HTTPS origin.
- Persisted a SHA-256 registration-token hash, exact safe install-pack snapshot, canonical JSON hash, release version, and bundle hash in one token write. Legacy incomplete rows fail closed with `registration_token_reissue_required`.
- Added canonical JSON serialization, schema/hash/cross-field validation on store reads and writes, 2 MiB bounded immutable release rows, byte-preserving file/Postgres storage, and version/hash `getRelease`/`upsertRelease` operations.
- Added additive PostgreSQL/Supabase columns and an operator reissue migration note.
- Replaced the token-in-path route and live-checkout rendering with Bearer-only `GET /api/install`, `no-store`/`no-referrer` headers, and rendering exclusively from the pinned stored snapshot/archive.
- Added strict gzip/tar validation (checksum, regular entries, safe paths, duplicates, exact inventory, manifest bytes, payload hashes, and `release.env` agreement), a 4,000,000-byte response cap, a server allowlist for UTF-8 client overlays, and a portable cleanup-safe self-extractor that passes the exact version and external token file to `install.sh`.
- Preserved direct `install.sh --registration-token` test behavior; adapted the admin CLI to issue the same release-pinned records.

## Files changed

- `apps/control-plane/src/installPack.ts`
- `apps/control-plane/tests/install-pack-install.test.ts`
- `apps/control-plane/tests/minimal-registry.test.ts`
- `apps/control-plane-api/src/adminCli.ts`
- `apps/control-plane-api/src/data/index.ts`
- `apps/control-plane-api/src/data/file.ts`
- `apps/control-plane-api/src/data/postgres.ts`
- `apps/control-plane-api/src/index.ts`
- `apps/control-plane-api/src/installerScript.ts`
- `apps/control-plane-api/tests/control-plane-api.test.ts`
- `apps/control-plane-api/tests/data.test.ts`
- `supabase/migrations/0003_pin_install_packs_to_releases.sql`

## RED / GREEN evidence

### RED — install-pack release pin

Command:

```bash
npx vitest run apps/control-plane/tests/install-pack-install.test.ts
```

Relevant output: exit 1; 1 failed test; `AssertionError: expected undefined to deeply equal { version: 'v0.2.0', … }`.

### RED — token persistence and Bearer endpoint

Command:

```bash
npx vitest run apps/control-plane-api/tests/control-plane-api.test.ts
```

Relevant output: exit 1; 2 failed tests; `TypeError: data.upsertRelease is not a function`; existing issuance returned 500 because it had no release.

### GREEN — required focused suite

Command:

```bash
npx vitest run apps/control-plane/tests/install-pack-install.test.ts apps/control-plane-api/tests/control-plane-api.test.ts
```

Relevant output: 2 test files passed; 39 tests passed; duration 443 ms.

Additional verification:

```bash
npm run typecheck
```

Relevant output: `TYPECHECK_PASS`.

## Full-suite result

Command:

```bash
npm test -- --run
```

Result: **FAILED** — 45 files passed, 1 failed; 395 tests passed, 5 failed. All Task 2 focused/data/control-plane tests passed. The five failures are in `apps/api/tests/api.test.ts`: those older integration fixtures seed pre-migration token/release records without the now-required release bytes and safe snapshot/hash. They now fail closed as designed (`release_bytes_required`, `registration_token_invalid`, and `unauthorized_installation`) and must be migrated to issue/seed complete pinned records.

## Self-review

- Confirmed plaintext registration credentials are absent from stored token rows, install-pack snapshots, URLs, overlay files, archive payloads, and rendered scripts.
- Confirmed installer redemption never calls `createInstallPack`, reads current templates, or loads live deploy files.
- Confirmed old tokens remain byte-pinned across release and overlay drift; snapshot/hash/release/bundle tampering fails before rendering.
- Confirmed absolute/traversal paths, symlinks, hardlinks, directories, duplicate tar entries, runtime-file overlay collisions, corrupted archives, and both byte caps are covered.
- Confirmed release metadata endpoints expose only version/notes, not archive or manifest bytes.
- `git diff --check` passed.

## Concerns

- The repository-wide suite is not green because five application integration tests still construct legacy pre-migration records. Production behavior is intentionally fail-closed; those fixtures require reissue-style migration.
- Task 3 is still responsible for the adjacent `bootstrap.sh` and remaining appliance lifecycle assets noted by Task 1. The Task 2 command and self-extractor interfaces are pinned for that handoff.

## Concern resolution before review

Migrated only the five legacy fixtures in `apps/api/tests/api.test.ts`. The shared cloud-test helper now seeds a valid bounded release through `upsertRelease`, configures the canonical test origin, and lets the normal install-pack endpoint persist the hashed token, exact safe snapshot, release pin, and canonical pack hash. The `v1.1.0` settings-sync fixture also seeds its explicit release through the same data interface. Production fail-closed behavior was not changed.

Files changed:

- `apps/api/tests/api.test.ts`
- `.superpowers/sdd/2026-07-29-one-command-vm-appliance-onboarding/task-2-report.md`

Focused command:

```bash
npx vitest run apps/api/tests/api.test.ts
```

Exact result: `FOCUSED_PASS`; 1 test file passed; 27 tests passed; duration 1.07 s.

Full-suite command:

```bash
npm test -- --run
```

Exact result: `FULL_SUITE_PASS`; 46 test files passed; 400 tests passed; duration 3.19 s.

The prior full-suite concern is resolved; Task 2 is review-ready.
