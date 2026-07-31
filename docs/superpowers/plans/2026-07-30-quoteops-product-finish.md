# QuoteOps Product Finish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the `codex/vm-appliance-onboarding` branch from "T1-T9 done, T10-T11 pending, prod not yet deployable, no installable release" to a finished, installable, locally-testable product with a published `v0.2.0` release and completed acceptance.

**Architecture:** Three tracks run in sequence. Track 1 fixes the blocking bugs discovered while attempting a local install and a prod deploy (these are not in any prior plan). Track 2 adds a slim, reusable **developer local-install harness** so the product can be exercised on a Mac without the full Task-10 acceptance machinery — this de-risks and feeds the real Task 10. Track 3 completes the original plan's Task 10 and Task 11, then publishes `v0.2.0` through the new `release.yml` pipeline so the customer install path is real.

**Tech Stack:** TypeScript, Vitest, Bash, Docker Compose v2, PostgreSQL 16, Vercel (control plane), GitHub Actions + GHCR, Cloudflare Tunnel/Access, QEMU/Lima (Ubuntu gate).

## Global Constraints

- Do not weaken the fail-closed security posture of the appliance: every local-test escape hatch must be gated behind an explicit, named, opt-in flag and must never be the default in production.
- Never commit secrets, tokens, or customer data. Local-dev credential inputs live in `0600` files under a bounded temp root and are deleted after use.
- Every behavior change follows RED → GREEN → commit. Every shell change is guarded by `bash -n` and an existing or new fixture.
- Preserve backward compatibility of `deploy/appliance/install.sh` direct invocations and existing data paths.
- The `codex/vm-appliance-onboarding` worktree is the working root. Revert any uncommitted experimental patch before starting (the `installPack.ts` localhost patch from the prior session must be gone — verify in Task 1 Step 0).
- Production deploys go to the Vercel project `quote-ops-portal` (projectId `prj_TfZJoBENxj6N6l1mpApQfzP6Xzbq`), not the abandoned `quoteops-control-plane` project.

---

## Current State (do not re-implement)

- **`2026-07-19-quoteops-human-simulator-repair.md` — COMPLETE (7/7).** Branch `codex/fix-quoteops-human-simulator` is an ancestor of `codex/vm-appliance-onboarding`. Evidence at `docs/evidence/2026-07-19-vps-human-simulator/` shows `required_steps: []` (ready). No further work on that plan.
- **`2026-07-29-one-command-vm-appliance-onboarding.md` — T1-T9 COMPLETE, T10-T11 PENDING.** Latest commit `587aecb fix(appliance): close final onboarding integration gaps` is integration hardening on T8-T9; T10 deliverables (`macbook-acceptance.sh`, `ubuntu-vm-bootstrap-acceptance.sh`, `docs/runbooks/customer-vm-install.md`) do not yet exist.
- **Control plane prod (`quote-ops-portal.vercel.app`)** was redeployed at commit `99674aa` during the prior session; the T9 endpoints (`/api/releases/:version/appliance`, `/api/internal/releases/sync-bundled`) now respond (401/503 instead of 404).

## Blocking Gaps Discovered (Track 1 work)

These are real bugs in the current branch that block both prod deploy and local install. They are not covered by any prior plan task.

1. **`vercel.json` `includeFiles` is an array** — Vercel rejects with `Invalid vercel.json - functions['api/index.ts'].includeFiles should be string`. Blocks every `vercel build`.
2. **`apps/control-plane-api/src/adminCli.ts:142` requires Postgres** — `createDatabaseData` throws if no `DATABASE_URL`, even though the API server supports the file store. A developer cannot issue an install pack locally without a running Postgres.
3. **`apps/control-plane/src/installPack.ts:120` `normalizeControlPlaneOrigin` rejects HTTP/localhost** — by design for production, but there is no opt-in local escape hatch, so no local install pack can be issued against `http://127.0.0.1:19083`.
4. **`install_pack_token_mismatch`** — issuing an install pack via `adminCli install-pack` against Postgres fails the snapshot-vs-record validation in `apps/control-plane-api/src/data/index.ts:413`. Needs root-cause + fix.
5. **GHCR images are not anonymously pullable** (`ghcr.io/alejandroc-bit/quote-ops-{api,agent,web}` → 401/403). Violates the plan Global Constraint "release workflow must fail if the three GHCR application images cannot be pulled anonymously." Package visibility is private.
6. **No `v0.2.0` tag/release; `release.yml` (new pipeline) never ran.** No immutable appliance bundle is published to a GitHub Release; prod control plane has no release registered (`sync-bundled` never called from CI).
7. **`apps/control-plane-api/src/installerScript.ts:109` uses `Object.hasOwn`** without `lib: es2022` in the tsconfig — TS2550 warning (build passed but fragile).

---

## File Structure

### Create

- `scripts/dev-install-quoteops.sh` — developer local-install orchestrator (Track 2): spins up a throwaway control plane + Postgres, packages a local bundle from already-loaded images, issues an install pack, and invokes `install.sh --no-pull` into a bounded `$QUOTEOPS_HOME`. The slim, reusable analog of Task 10's `macbook-acceptance.sh`.
- `deploy/appliance/tests/dev-install.test.ts` — Vitest contract test for the dev-install orchestrator's argument/bound checks.
- `docs/runbooks/dev-local-install.md` — one-page developer guide: prerequisites, how to run `scripts/dev-install-quoteops.sh`, what it does/doesn't prove, cleanup.
- (Track 3) `deploy/appliance/tests/macbook-acceptance.sh`, `deploy/appliance/tests/ubuntu-vm-bootstrap-acceptance.sh`, `deploy/appliance/tests/fixtures/readiness-knowledge.md`, `docs/runbooks/customer-vm-install.md` — as specified in original Task 10.
- (Track 3) `docs/runbooks/azure-hostinger-cloudflare-browser-e2e.md`, `docs/evidence/templates/browser-e2e-report.md`, `scripts/validate-browser-evidence.mjs`, `tests/regression/browser-evidence.test.ts` — as specified in original Task 11.

### Modify

- `vercel.json` — fix `includeFiles` to a single glob string (Track 1, Task 1).
- `apps/control-plane-api/src/adminCli.ts` — accept the file store when `QUOTEOPS_CONTROL_PLANE_STORE_PATH` is set (Track 1, Task 2).
- `apps/control-plane/src/installPack.ts` — add an explicit, opt-in `QUOTEOPS_ALLOW_LOCAL_ORIGIN=1` escape hatch to `normalizeControlPlaneOrigin` (Track 1, Task 3).
- `apps/control-plane-api/src/data/index.ts` and/or `apps/control-plane-api/src/data/postgres.ts` — root-cause and fix `install_pack_token_mismatch` (Track 1, Task 4).
- `apps/control-plane-api/tsconfig.json` (or the shared build config) — set `lib` to include `es2022` so `Object.hasOwn` type-checks cleanly (Track 1, Task 5).
- `.github/workflows/release.yml` — ensure the `anonymous-pull` gate fails closed on non-public packages, and document/automate the one-time GHCR package visibility flip (Track 3, Task 9).
- `package.json` — add `dev:install`, `test:appliance:ubuntu-vm`, `test:appliance:mac`, `evidence:browser:validate` scripts.

---

## Track 1 — Unblock prod deploy + local install (Tasks 1-6)

### Task 1: Fix `vercel.json` `includeFiles` to a string glob

**Files:**
- Modify: `vercel.json`
- Test: `deploy/appliance/tests/smoke.sh` (extend) or a new `scripts/verify-vercel-config.mjs`

**Interfaces:**
- Produces: a `vercel.json` that passes `vercel build --prod` without the `includeFiles should be string` error.

- [ ] **Step 1: Write the failing config check**

Create `scripts/verify-vercel-config.mjs`:

```js
import fs from "node:fs";
const cfg = JSON.parse(fs.readFileSync("vercel.json", "utf8"));
const inc = cfg.functions?.["api/index.ts"]?.includeFiles;
if (typeof inc !== "string" || inc.trim() === "") {
  console.error(`includeFiles must be a non-empty string glob, got: ${JSON.stringify(inc)}`);
  process.exit(1);
}
console.log("vercel.json includeFiles OK");
```

- [ ] **Step 2: Run to verify RED**

Run: `node scripts/verify-vercel-config.mjs`
Expected: FAIL with "includeFiles must be a non-empty string glob".

- [ ] **Step 3: Fix `vercel.json`**

Replace the array with a brace-glob string that Vercel accepts:

```json
"includeFiles": "{deploy/appliance/**,dist/appliance/**,docs/integrations/tms-http-v1.openapi.yaml,docs/integrations/tms-http-v1.md}"
```

- [ ] **Step 4: Run config check to verify GREEN**

Run: `node scripts/verify-vercel-config.mjs`
Expected: PASS, prints "vercel.json includeFiles OK".

- [ ] **Step 5: Verify a real Vercel build succeeds**

Run: `vercel build --prod --yes`
Expected: build completes with `status: ok` (no `includeFiles should be string` error).

- [ ] **Step 6: Commit**

```bash
git add vercel.json scripts/verify-vercel-config.mjs
git commit -m "fix(vercel): use string glob for function includeFiles"
```

### Task 2: Let `adminCli` use the file store

**Files:**
- Modify: `apps/control-plane-api/src/adminCli.ts:142-147` (`createDatabaseData`)
- Test: `apps/control-plane-api/tests/adminCli.test.ts` (create)

**Interfaces:**
- Consumes: `createDefaultControlPlaneData` from `apps/control-plane-api/src/data/index.ts` (already supports file store via `QUOTEOPS_CONTROL_PLANE_STORE_PATH`).
- Produces: `adminCli` that works with either Postgres (`DATABASE_URL`) or the file store (`QUOTEOPS_CONTROL_PLANE_STORE_PATH`), matching the API server's behavior.

- [ ] **Step 1: Write the failing test**

In `apps/control-plane-api/tests/adminCli.test.ts`, assert that running the admin CLI `list` command with only `QUOTEOPS_CONTROL_PLANE_STORE_PATH` set (no `DATABASE_URL`) does not throw `DATABASE_URL ... is required`, and returns an empty list exit code 0. Use a `tmpdir` store path.

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run apps/control-plane-api/tests/adminCli.test.ts`
Expected: FAIL with "DATABASE_URL or QUOTEOPS_SUPABASE_DB_URL is required".

- [ ] **Step 3: Make `createDatabaseData` delegate to `createDefaultControlPlaneData`**

```ts
function createDatabaseData(env: NodeJS.ProcessEnv): ControlPlaneData {
  return createDefaultControlPlaneData(env);
}
```

`createDefaultControlPlaneData` already picks Postgres → file → in-memory in that order, so the file store is now honored.

- [ ] **Step 4: Run to verify GREEN**

Run: `npx vitest run apps/control-plane-api/tests/adminCli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane-api/src/adminCli.ts apps/control-plane-api/tests/adminCli.test.ts
git commit -m "fix(admin-cli): honor file store when Postgres is absent"
```

### Task 3: Add an explicit local-origin escape hatch

**Files:**
- Modify: `apps/control-plane/src/installPack.ts:120-133` (`normalizeControlPlaneOrigin`)
- Test: `apps/control-plane/tests/install-pack-install.test.ts`

**Interfaces:**
- Produces: `normalizeControlPlaneOrigin(value, { allowLocal?: boolean })`. When `allowLocal` is true, accepts `http://127.0.0.1:<port>` and `http://localhost:<port>` origins; HTTPS remains the only accepted protocol otherwise. The caller in `createInstallPack` reads `process.env.QUOTEOPS_ALLOW_LOCAL_ORIGIN === "1"` to set `allowLocal`.

- [ ] **Step 1: Write the failing test**

Add a case asserting `normalizeControlPlaneOrigin("http://127.0.0.1:19083/", { allowLocal: true })` returns `"http://127.0.0.1:19083"`, and that without `allowLocal` it throws `"control_plane_origin_invalid"`. Also assert `https://quote-ops-portal.vercel.app/` still normalizes with and without the flag.

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run apps/control-plane/tests/install-pack-install.test.ts`
Expected: FAIL (current signature ignores the second argument and rejects localhost).

- [ ] **Step 3: Implement the opt-in hatch**

```ts
export function normalizeControlPlaneOrigin(
  value: string,
  options: { allowLocal?: boolean } = {}
): string {
  const url = new URL(value);
  const isLocalHttp =
    options.allowLocal === true &&
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (
    !(url.protocol === "https:" || isLocalHttp) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("control_plane_origin_invalid");
  }
  return url.origin;
}
```

In `createInstallPack`, thread the env flag:

```ts
const controlPlaneUrl = normalizeControlPlaneOrigin(input.control_plane_url, {
  allowLocal: process.env.QUOTEOPS_ALLOW_LOCAL_ORIGIN === "1"
});
```

- [ ] **Step 4: Run to verify GREEN**

Run: `npx vitest run apps/control-plane/tests/install-pack-install.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/installPack.ts apps/control-plane/tests/install-pack-install.test.ts
git commit -m "feat(install-pack): opt-in local-origin escape hatch for dev"
```

### Task 4: Root-cause and fix `install_pack_token_mismatch`

**Files:**
- Modify: `apps/control-plane-api/src/data/index.ts:395-414` (validation) and/or `apps/control-plane-api/src/data/postgres.ts` (`saveRegistrationToken`) and/or `apps/control-plane-api/src/adminCli.ts:97-111`
- Test: `apps/control-plane-api/tests/data.test.ts` (extend)

**Interfaces:**
- Produces: an end-to-end "issue install pack → save token → re-read → validate" round-trip that passes for both the file store and Postgres, with no `install_pack_token_mismatch`.

- [ ] **Step 0: Reproduce deterministically**

Write a failing test in `apps/control-plane-api/tests/data.test.ts` that, for each data backend (file store with a tmpdir path, and Postgres via `testcontainers` or the existing pg test helper), performs the exact sequence `adminCli install-pack` runs: build a `PublishedApplianceRelease` from a seeded release row, call `createInstallPack`, build the `RegistrationTokenRecord` with `pack_sha256 = sha256(canonicalizeInstallPack(snapshot))`, call `saveRegistrationToken`, then re-read via the activation path and assert validation passes. Capture the exact field that mismatches.

- [ ] **Step 1: Run to verify RED**

Run: `npx vitest run apps/control-plane-api/tests/data.test.ts`
Expected: FAIL with `install_pack_token_mismatch` on the Postgres path (and possibly the file path).

- [ ] **Step 2: Fix the root cause**

The likely cause is a serialization drift: `install_pack_snapshot` is stored as JSON and re-parsed by `parseInstallPack`, but `canonicalizeInstallPack` is not invariant under JSON round-trip (key order or a field like `release.bundle_sha256` vs the stored `bundle_sha256` column). Apply the minimal fix so the canonical form is stable across store→load. Do not loosen the check by deleting it; make the round-trip faithful. If the drift is in `parsePublishedApplianceRelease` discarding fields the manifest needs, restore them.

- [ ] **Step 3: Run to verify GREEN**

Run: `npx vitest run apps/control-plane-api/tests/data.test.ts`
Expected: PASS on both backends.

- [ ] **Step 4: End-to-end verify the real CLI path**

Run (with a throwaway Postgres or file store):
```bash
QUOTEOPS_ALLOW_LOCAL_ORIGIN=1 \
QUOTEOPS_CONTROL_PLANE_URL=http://127.0.0.1:19083 \
npm run admin -- install-pack LOCAL-TEST --url http://127.0.0.1:19083
```
Expected: prints a registration token + install command, exit 0, no mismatch.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane-api/src/data/index.ts apps/control-plane-api/src/data/postgres.ts apps/control-plane-api/tests/data.test.ts
git commit -m "fix(control-plane): keep install-pack snapshot stable across store round-trip"
```

### Task 5: Fix `Object.hasOwn` TS lib

**Files:**
- Modify: the tsconfig that builds `apps/control-plane-api` (verify which config governs `installerScript.ts`); add `"es2022"` to `lib` (and `target` if needed).
- Test: existing build.

- [ ] **Step 1: Confirm the warning**

Run: `npm run build:ts`
Expected: `error TS2550: Property 'hasOwn' does not exist ...` at `apps/control-plane-api/src/installerScript.ts:109`.

- [ ] **Step 2: Add `es2022` to the governing `lib`**

In the relevant `tsconfig.json` `compilerOptions`, set `"lib": ["es2022"]` (merge with existing DOM/next libs as appropriate). Do not lower `Object.hasOwn` to a polyfill — raise the target.

- [ ] **Step 3: Run to verify GREEN**

Run: `npm run build:ts`
Expected: clean build, no TS2550.

- [ ] **Step 4: Commit**

```bash
git add <governing-tsconfig.json>
git commit -m "build: target es2022 for Object.hasOwn in installer script"
```

### Task 6: Redeploy control plane prod and verify

**Files:** none (operational)

- [ ] **Step 1: Build locally**

Run: `vercel build --prod --yes`
Expected: `status: ok`.

- [ ] **Step 2: Deploy to `quote-ops-portal`**

Run: `vercel deploy --prebuilt --prod --yes`
Expected: production alias `quote-ops-portal.vercel.app` updated.

- [ ] **Step 3: Probe the T9 endpoints**

```bash
BASE=https://quote-ops-portal.vercel.app
curl -s -o /dev/null -w "%{http_code}\n" "$BASE/api/releases/latest"            # 401
curl -s -o /dev/null -w "%{http_code}\n" "$BASE/api/releases/v0.2.0/appliance"  # 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$BASE/api/internal/releases/sync-bundled"  # 503 (no token)
curl -s "$BASE/api/health"                                                       # {"ok":true,...}
```
Expected: all match (endpoints present, not 404).

- [ ] **Step 4: No commit (operational)** — record the deployed commit SHA in the commit message of the last code change for traceability.

---

## Track 2 — Developer local-install harness (Tasks 7-8)

### Task 7: `scripts/dev-install-quoteops.sh` orchestrator

**Files:**
- Create: `scripts/dev-install-quoteops.sh`
- Create: `deploy/appliance/tests/dev-install.test.ts`
- Modify: `package.json` (add `dev:install`)

**Interfaces:**
- Consumes: `0600` credential files under `~/.quoteops-secrets/` (`openrouter-key`, `resend-key`, `sakbe-key`, `embedding-key`), already-loaded Docker images (or it pulls the public `v0.1.2` side-load tarballs), and the `deploy/appliance/install.sh --no-pull` path.
- Produces: a running QuoteOps stack under a bounded `$QUOTEOPS_HOME` (e.g. `${TMPDIR}/quoteops-dev.<ts>/quoteops-v1`) with a local control plane, a registered `v0.1.2` release, an issued install pack, and onboarding started via the real `install.sh`. Prints the local web URL and the resume command. Cleans up everything on exit unless `--keep`.

- [ ] **Step 1: Write the failing contract test**

`deploy/appliance/tests/dev-install.test.ts` asserts the script's preflight: it refuses to run without `~/.quoteops-secrets/openrouter-key`; it refuses if `docker info` fails; it bounds `QUOTEOPS_HOME` under `${TMPDIR}/quoteops-dev.*` and refuses `/`, `$HOME`, or the repo root; and it exposes `--help`. Use a fake `docker`/`curl` for the parsing checks.

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run deploy/appliance/tests/dev-install.test.ts`
Expected: FAIL (script missing).

- [ ] **Step 3: Implement the orchestrator**

`scripts/dev-install-quoteops.sh` does, in order:
1. Preflight: `docker info`, `docker compose version >= 2.24`, required secret files exist and are `0600`, `QUOTEOPS_PLATFORM=linux/amd64` (Mac uses AMD64 emulation).
2. Create bounded root `E2E_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/quoteops-dev.XXXXXX")"`, `QUOTEOPS_HOME="$E2E_ROOT/quoteops-v1"`, `COMPOSE_PROJECT_NAME="quoteops_dev_$(date +%s)"`.
3. Ensure images are loaded: if `ghcr.io/alejandroc-bit/quote-ops-api:v0.1.2` is absent locally, download the public `v0.1.2` side-load tarballs from the GitHub release and `docker load` + `docker tag` them (reuse the exact sequence proven in the prior session).
4. Start a throwaway control plane: run `docker run -d` Postgres 16 on a random port, apply the 3 migrations, start `npm run dev:control-plane-api` with `DATABASE_URL`, `QUOTEOPS_APPLIANCE_RELEASE_VERSION=v0.1.2`, a generated `QUOTEOPS_RELEASE_SYNC_TOKEN`, and `QUOTEOPS_ALLOW_LOCAL_ORIGIN=1`. Wait for `/api/health`.
5. Stage the appliance bundle: copy `deploy/appliance/*` runtime assets into `dist/appliance/v0.1.2/` and run `npm run package:appliance -- --version v0.1.2 ...` with the locally-inspected image digests (use `docker image inspect` for digests at runtime, do not hard-code).
6. `POST /api/internal/releases/sync-bundled` with the sync token to register `v0.1.2`.
7. `npm run admin -- create-client DEV "QuoteOps Dev" <email>` then `install-pack DEV --url http://127.0.0.1:19083`, capture the registration token into a `0600` file.
8. Invoke `deploy/appliance/install.sh` with `--no-pull`, `--home "$QUOTEOPS_HOME"`, `--client DEV`, `--manifest <generated>`, `--compose-file deploy/appliance/docker-compose.yml`, `--control-plane-url http://127.0.0.1:19083`, `--registration-token-file <0600 file>`, `--image-registry ghcr.io/alejandroc-bit`, `--site-address :8080` (loopback only). Pass the `~/.quoteops-secrets/*` files into `secrets/client.env` as env references, never values.
9. Print the local web URL (`http://127.0.0.1:8080`), the API health URL, the `quoteops onboard --resume` command, and the cleanup command.
10. Trap: on exit (unless `--keep`), `docker compose down --volumes --remove-orphans` for the recorded project, stop the CP Postgres container and CP API process, remove `$E2E_ROOT`.

- [ ] **Step 4: Run to verify GREEN**

Run: `npx vitest run deploy/appliance/tests/dev-install.test.ts`
Expected: PASS (preflight + parsing checks).

- [ ] **Step 5: Add the npm script**

In `package.json` `"scripts"`:
```json
"dev:install": "bash scripts/dev-install-quoteops.sh"
```

- [ ] **Step 6: Commit**

```bash
git add scripts/dev-install-quoteops.sh deploy/appliance/tests/dev-install.test.ts package.json
git commit -m "feat(dev): add local install orchestrator for developer testing"
```

### Task 8: Developer runbook + live local run

**Files:**
- Create: `docs/runbooks/dev-local-install.md`

- [ ] **Step 1: Write the runbook**

Document: prerequisites (Docker Desktop running, the 4 `0600` secret files), how to create the secrets, `npm run dev:install`, what it proves (full stack + onboarding start), what it does NOT prove (no Cloudflare tunnel, no real Ubuntu apt bootstrap, no public hostname), and cleanup (`--keep` debugging + manual `--cleanup`).

- [ ] **Step 2: Run it for real**

Run: `npm run dev:install`
Expected: stack comes up, `http://127.0.0.1:8080` loads the QuoteOps UI, onboarding can be resumed. Capture any failure as a follow-up task (do not skip).

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/dev-local-install.md
git commit -m "docs(dev): add local install runbook"
```

---

## Track 3 — Complete the original Task 10 & 11, publish v0.2.0 (Tasks 9-12)

### Task 9: Make GHCR images anonymously pullable

**Files:**
- Modify: `.github/workflows/release.yml` (strengthen `anonymous-pull` gate)
- Operational: flip package visibility on the three GHCR packages.

**Interfaces:**
- Produces: `curl`/`docker pull` of `ghcr.io/alejandroc-bit/quote-ops-{api,agent,web}:v0.2.0` succeeds without authentication, and the `anonymous-pull` job fails closed if it doesn't.

- [ ] **Step 1: Write the failing gate assertion**

In `.github/workflows/release.yml`, make the `anonymous-pull` job run on a fresh runner with no `registry login`, pull each image by `v0.2.0`, and `exit 1` if any pull fails. Add a comment that package visibility must be set to "public" on each GHCR package once.

- [ ] **Step 2: Verify RED (locally, against current v0.1.7)**

Run: `docker pull ghcr.io/alejandroc-bit/quote-ops-api:v0.1.7`
Expected: FAIL (403) — confirms packages are still private.

- [ ] **Step 3: Flip visibility (operational, one-time)**

On GitHub, set each of the three packages (`quote-ops-api`, `quote-ops-agent`, `quote-ops-web`) to "public". Record this as a prerequisite in `.github/workflows/release.yml` comments.

- [ ] **Step 4: Verify GREEN (against v0.1.7 after flip)**

Run: `docker pull ghcr.io/alejandroc-bit/quote-ops-api:v0.1.7`
Expected: succeeds without login.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(release): enforce anonymous-pull gate for public GHCR packages"
```

### Task 10: Complete original Task 10 deliverables

**Files:** as specified in `2026-07-29-one-command-vm-appliance-onboarding.md` Task 10.

**Interfaces:** as specified in the original plan.

- [ ] **Step 1: Port the dev-install learnings into `macbook-acceptance.sh`**

Implement `deploy/appliance/tests/macbook-acceptance.sh` per original Task 10 Steps 3-9, reusing the bounded-root, state-file, and cleanup-trap patterns proven by `scripts/dev-install-quoteops.sh`. The Mac acceptance adds: real published release images (not side-loaded), the real `E2E_CONTROL_PLANE_URL` (prod), the Cloudflare tunnel profile, the full public workflow assertions, and redacted evidence.

- [ ] **Step 2: Implement `ubuntu-vm-bootstrap-acceptance.sh`** per original Task 10 Step 9 (Lima/QEMU Ubuntu 24.04 AMD64 gate).

- [ ] **Step 3: Write `docs/runbooks/customer-vm-install.md`** per original Task 10 Steps 1-2 (prerequisite checklist + one-command/operator flow).

- [ ] **Step 4: Write `deploy/appliance/tests/fixtures/readiness-knowledge.md`** per original Task 10 Step 5.

- [ ] **Step 5: Add npm scripts** `test:appliance:ubuntu-vm` and `test:appliance:mac` to `package.json`.

- [ ] **Step 6: Run the local verification gate** per original Task 10 Step 10:
```bash
npm run build
npm test -- --run
bash deploy/appliance/tests/smoke.sh
bash deploy/appliance/tests/lifecycle.sh
npm run test:appliance:ubuntu-vm -- --run
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add deploy/appliance/tests/ubuntu-vm-bootstrap-acceptance.sh deploy/appliance/tests/macbook-acceptance.sh deploy/appliance/tests/fixtures/readiness-knowledge.md docs/runbooks/customer-vm-install.md package.json
git commit -m "test(appliance): add MacBook VM acceptance journey"
```

- [ ] **Step 8: Run the live MacBook acceptance** (original Task 10 Step 11) with real inputs — requires Alejandro's AI key, Cloudflare, Resend, SAKBÉ, embeddings. Defer to a scheduled session; do not block the plan on it.

### Task 11: Complete original Task 11 (live Chrome E2E)

**Files:** as specified in `2026-07-29-one-command-vm-appliance-onboarding.md` Task 11.

- [ ] **Step 1: Write the failing browser-evidence contract test** (`tests/regression/browser-evidence.test.ts`) per original Task 11 Step 1.
- [ ] **Step 2: Run RED** — `npx vitest run tests/regression/browser-evidence.test.ts`.
- [ ] **Step 3: Implement the report template + validator** (`docs/evidence/templates/browser-e2e-report.md`, `scripts/validate-browser-evidence.mjs`) per original Task 11 Step 3; add `evidence:browser:validate` to `package.json`.
- [ ] **Step 4: Run GREEN** — `npx vitest run tests/regression/browser-evidence.test.ts`.
- [ ] **Step 5: Commit** — `git commit -m "test(appliance): add live browser acceptance evidence"`.
- [ ] **Step 6: Execute the live Chrome E2E** (original Task 11 Steps 4-10) — Azure VM + Hostinger/Supabase + Cloudflare, through Alejandro's authenticated Chrome. This is the final sign-off and must be scheduled with Alejandro; it is the only task that cannot be automated.

### Task 12: Publish `v0.2.0` through the real release pipeline

**Files:** none committed (operational + tag).

- [ ] **Step 1: Ensure `main` (or a release branch) has all Track 1-3 code merged.**

- [ ] **Step 2: Tag and push**

```bash
git tag -a v0.2.0 -m "QuoteOps appliance v0.2.0"
git push origin v0.2.0
```

- [ ] **Step 3: Watch the `release.yml` run**

```bash
gh run watch -R alejandroc-bit/quote_ops_v1 $(gh run list -R alejandroc-bit/quote_ops_v1 --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
```
Expected: `build-and-push` → `package-appliance` → `n-minus-one-schema` → `anonymous-pull` → `publish-appliance` → `deploy-control-plane` all green.

- [ ] **Step 4: Verify prod control plane received the release**

```bash
BASE=https://quote-ops-portal.vercel.app
# with a real installation token:
curl -s "$BASE/api/releases/latest"   # {"version":"v0.2.0","bundle_sha256":"...","manifest":{...}}
```
Expected: `version === "v0.2.0"`, `bundle_sha256` matches the GitHub Release `SHA256SUMS`.

- [ ] **Step 5: Verify a customer install pack can be issued against `v0.2.0`** via `npm run admin -- install-pack <CLIENT> --url https://quote-ops-portal.vercel.app` (requires Supabase admin auth in prod).

- [ ] **Step 6: No commit** — record the release URL in the runbook.

---

## Final Verification Gate

Run from a clean checkout at the `v0.2.0` tag:

```bash
npm ci
npm run build
npx vitest run
bash deploy/appliance/tests/smoke.sh
bash deploy/appliance/tests/lifecycle.sh
npm run test:appliance:ubuntu-vm -- --run
npm run dev:install            # developer local path
# then, scheduled with Alejandro:
npm run test:appliance:mac
npm run evidence:browser:validate -- "$BROWSER_E2E_EVIDENCE_DIR"
```

The product is finished when all of the following hold:

- `vercel build --prod` succeeds and `quote-ops-portal.vercel.app` serves the T9 release endpoints;
- `npm run dev:install` brings up a local QuoteOps stack on a Mac with onboarding started, using only `0600` secret files;
- GHCR images are anonymously pullable and the `release.yml` `anonymous-pull` gate is green;
- tag `v0.2.0` exists, `release.yml` ran green end-to-end, and `/api/releases/latest` on prod returns `v0.2.0`;
- a customer install pack can be issued and the one-command `bash -c '... curl .../install/quoteops | sudo bash'` flow reaches guided onboarding without a second manual Compose command;
- original Task 10 (`macbook-acceptance.sh`, `ubuntu-vm-bootstrap-acceptance.sh`, `customer-vm-install.md`) is committed and the local gates pass;
- original Task 11's evidence validator passes on a live Chrome E2E run (scheduled with Alejandro).

## Explicitly Deferred

- Native ARM64 QuoteOps application images (Mac acceptance uses AMD64 emulation).
- Splitting PostgreSQL/Redis/API/agent/web onto separate machines.
- Additional AI providers beyond OpenRouter and Gemini.
- A PostgreSQL mirror/sync worker for normalized TMS history.
- OAuth support for customer TMS APIs.
