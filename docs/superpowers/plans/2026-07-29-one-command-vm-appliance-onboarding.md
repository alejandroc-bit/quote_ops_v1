# One-Command Customer VM Appliance Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a fresh customer VM appliance from one terminal command, guide the operator from the AI-provider key through Cloudflare and TMS setup, pin every installation to an immutable release, and prove the complete journey on this ARM64 MacBook.

**Architecture:** The control plane serves a small bootstrap script and a release-pinned, self-extracting client installer; the VM never clones this repository. Immutable runtime assets live in version-named directories under `/opt/quoteops-v1/releases/`, customer data and secrets remain in stable top-level directories, and `/opt/quoteops-v1/current` selects the active release atomically. The existing TypeScript LangGraph runtime, PostgreSQL store, Caddy proxy, onboarding CLI, HTTP TMS adapter, backup/restore scripts, and control-plane licensing flow are extended rather than replaced.

**Tech Stack:** TypeScript, Node.js 22, Vitest, Bash, `jq`, Docker Engine + Docker Compose v2, PostgreSQL 16, Redis 7, Caddy 2, Cloudflare Tunnel/Access, Zod, OpenAPI 3.1, GitHub Actions, GHCR.

## Global Constraints

- The first supported production target is Ubuntu Server 24.04 LTS on `linux/amd64`.
- This `arm64` MacBook runs the deterministic Docker Desktop/QEMU acceptance gates. The final live acceptance is driven from this MacBook’s authenticated Chrome session against a real Ubuntu 24.04 `linux/amd64` Azure VM, a Supabase-backed mock TMS on the supplied Hostinger VPS, and a test-scoped tunnel in the user’s Cloudflare account.
- Azure, Hostinger, Supabase, and Cloudflare infrastructure configuration in the live acceptance must be performed through their visible Chrome web interfaces. Do not use the in-app browser, Appium, headless browser automation, Azure/Hostinger/Cloudflare management APIs, CLIs, Terraform, or direct database administration from this Mac. Application HTTP traffic, the TMS REST contract, and shell commands typed in an Azure browser terminal are part of the system under test and remain allowed.
- Every live cloud resource must use one UTC run ID, remain isolated from existing workloads, and be retained until the user reviews the screenshot report. Deletion, tunnel revocation, or project teardown happens only after explicit approval and targets only resources created for that run.
- A production appliance must use a remotely managed Cloudflare named tunnel; Caddy, PostgreSQL, Redis, the API, and the agent must not expose public host ports.
- The client owns the Cloudflare account, DNS zone, tunnel, hostname, and Access policy. QuoteOps retains only the named-tunnel token and public hostname after setup; the Access Service Auth credential exists only as a local transient verification secret and is deleted after the authenticated-origin receipt is written.
- Cloudflare Access must deny an unauthenticated request, and a one-time Service Auth request must return this installation’s identity/version, before the installer declares the public endpoint ready. The Service Auth credential is deleted after the safe validation receipt is written.
- The first guided-onboarding step is a live validation of the selected AI-provider key. The key is written only after validation succeeds.
- The initial guided providers remain OpenRouter and Google Gemini; adding another model provider is outside this plan.
- Runtime secrets are partitioned into root-only `0600` files under `/opt/quoteops-v1/secrets/`: `client.env` for the application services, `cloudflare.env` containing only `TUNNEL_TOKEN` for `cloudflared`, and the temporary `cloudflare-access-validation.env` while authenticated-origin verification is pending. The temporary Access file is excluded from backups/evidence and deleted on success; if it is absent on resume, onboarding must request the Service Auth values again. No secret may appear in URLs, shell history, process arguments, install packs, logs, evidence, or Git. Automated onboarding answer files may contain paths to `0600` source files, never secret values, and must be deleted before collecting evidence.
- The canonical customer integration is `quoteops-tms-http-v1`; it uses HTTPS plus `Authorization: Bearer ${TMS_API_KEY}`.
- The canonical TMS HTTPS requirement may be relaxed only for the exact Docker Desktop fixture URL `http://host.docker.internal:19091` while bounded Mac test mode is active; production and every other HTTP URL remain rejected.
- TMS v1 reads data on demand and uses the existing durable cache. Building a normalized PostgreSQL mirror or sync worker is outside this plan.
- Existing explicit-path custom REST configurations remain loadable for backward compatibility, but new guided installs become ready only after their adapter outputs pass the same canonical live checks. The current mapping JSON is not a runtime response transformer, so AI-generated arbitrary REST transformation is explicitly deferred rather than treated as connected.
- Image tags and appliance bundles are immutable. Production installation and update commands must never resolve `latest`.
- Every Compose invocation loads the shared `$QUOTEOPS_HOME/.env` followed by `$QUOTEOPS_HOME/current/release.env`; release version, platform, and image references never live in the shared env.
- The release workflow must fail if the three GHCR application images cannot be pulled anonymously.
- Existing data paths, client manifests, connector packs, registration/activation behavior, and direct invocations of `deploy/appliance/install.sh` remain backward compatible.
- The one-command path may pause as `onboarding_pending` when a required external prerequisite is unavailable, but it must print one local resume command and must never report the appliance ready.

---

## Scope and Existing Baseline

This is one vertical delivery rather than three independent products: the release bundle, guided onboarding, Cloudflare exposure, TMS contract, and MacBook acceptance test must interoperate before the VM installation is useful.

Reuse these existing boundaries:

- `apps/control-plane/src/installPack.ts` already creates client-specific non-secret files and a one-line install command.
- `apps/control-plane-api/src/index.ts` already issues single-use registration tokens and serves a self-extracting installer.
- `apps/control-plane-api/src/installerScript.ts` already embeds deploy files and hands off to `install.sh`.
- `deploy/appliance/install.sh` already validates identifiers, copies manifests/connectors, creates `0600` env files, pulls images, and starts Compose.
- `apps/api/src/onboard/cli.ts` already starts with the AI key and guides secrets, TMS, unit profiles, authorization, pricing, and knowledge ingestion.
- `packages/connectors/src/tms/HttpTmsAdapter.ts` and `TmsAdapterConfig.ts` already support configurable HTTP paths and secret-bearing headers through environment references.
- `deploy/appliance/backup.sh`, `restore.sh`, and `upgrade.sh` already provide the lifecycle primitives.
- `deploy/appliance/tests/smoke.sh`, the Vitest suites, and `deploy/appliance/mock-tms/server.mjs` already cover most reusable fixtures.

The plan closes these observed gaps:

- the deploy scripts served by the control plane can diverge from the image version;
- the current self-extractor ships only `install.sh`, Compose, and Caddy;
- Docker must already be installed and onboarding is printed as a second command;
- registration tokens currently appear in the installer URL;
- Cloudflare is absent and Caddy binds public ports;
- HTTP TMS onboarding paths disagree with the adapter and mock server;
- HTTP historical search expects an aggregated result that is unnecessarily hard for a client to implement;
- setup readiness checks configuration presence instead of probing required TMS endpoints;
- updates lack health-gated rollback;
- the current Mac test did not exercise the real one-command/onboarding/tunnel path.

## Target Runtime Layout

```text
/opt/quoteops-v1/
├── releases/
│   ├── v0.2.0/
│   │   ├── release.json
│   │   ├── PAYLOAD_SHA256SUMS
│   │   ├── release.env
│   │   ├── docker-compose.yml
│   │   ├── Caddyfile
│   │   ├── install.sh
│   │   ├── quoteops.sh
│   │   ├── verify-install.sh
│   │   ├── upgrade.sh
│   │   ├── backup.sh
│   │   ├── restore.sh
│   │   └── secrets.sh
│   └── v0.2.1/
├── current -> releases/v0.2.1
├── .env
├── manifests/
├── criteria/
├── connectors/
├── settings/
├── state/
├── secrets/
│   ├── client.env
│   ├── cloudflare.env
│   └── cloudflare-access-validation.env  # temporary; absent after successful verification
├── logs/
└── backups/

/usr/local/bin/quoteops
  # stable executable wrapper; delegates to
  # /opt/quoteops-v1/current/quoteops.sh
```

Release assets may change between versions; data and secret directories never move. Switching the `current` symlink is the only activation operation.

## File Structure

### Create

- `packages/shared/src/applianceRelease.ts` — release-manifest schema and exact TypeScript contract shared by release packaging and the control plane.
- `scripts/package-appliance-release.mjs` — deterministic bundle generator and SHA-256 producer.
- `deploy/appliance/bootstrap.sh` — stable Ubuntu bootstrap, hidden token prompt, Docker installation, and authenticated installer download.
- `deploy/appliance/docker-compose.direct.yml` — loopback-only Caddy port override for development and bounded acceptance tests.
- `deploy/appliance/quoteops.sh` — operator CLI for `status`, `doctor`, `onboard`, `update`, `rollback`, `backup`, `restore`, and `logs`.
- `deploy/appliance/verify-install.sh` — fail-closed internal, tunnel, public endpoint, Access, version, and setup-state verifier.
- `apps/api/src/onboard/onboardingFlow.ts` — resumable ordered step engine with prompt dependency injection.
- `apps/api/src/onboard/aiProviderStep.ts` — provider selection, live credential validation, and atomic model configuration.
- `apps/api/src/onboard/applianceSecretsStep.ts` — provider-aware mailbox, SAKBÉ, and optional embedding-secret collection.
- `apps/api/src/onboard/cloudflareStep.ts` — Cloudflare input validation and secret persistence.
- `apps/api/src/onboard/licenseActivationStep.ts` — resumable local activation phase.
- `apps/api/src/onboard/testRfqStep.ts` — controlled local RFQ submission, polling, and safe readiness receipt.
- `apps/api/src/onboard/tmsProbe.ts` — live contract-v1 endpoint probes and redacted receipt.
- `packages/contracts/src/tmsHttpV1.ts` — versioned TMS v1 paths and strict request/response schemas.
- `docs/integrations/tms-http-v1.openapi.yaml` — customer-facing OpenAPI 3.1 contract.
- `docs/integrations/tms-http-v1.md` — implementation, authentication, idempotency, example, and acceptance guide for a customer TMS team.
- `apps/api/tests/onboarding-flow.test.ts` — order, resume, secret, Cloudflare, and interruption tests.
- `apps/api/tests/tmsProbe.test.ts` — live-probe behavior tests.
- `tests/regression/tms-openapi-contract.test.ts` — OpenAPI/example/runtime-schema consistency.
- `deploy/appliance/tests/lifecycle.sh` — install/update/rollback/backup/restore shell lifecycle checks with fake Docker.
- `deploy/appliance/tests/n-minus-one-schema.sh` — real PostgreSQL migration compatibility gate for rollback.
- `deploy/appliance/tests/macbook-acceptance.sh` — destructive-target-bounded final acceptance harness for this MacBook.
- `deploy/appliance/tests/fixtures/readiness-knowledge.md` — non-sensitive document proving fresh knowledge ingestion in Mac acceptance.
- `docs/runbooks/customer-vm-install.md` — customer prerequisite, one-command install, resume, operation, and recovery runbook.

### Modify

- `packages/shared/src/index.ts`
- `packages/contracts/src/index.ts`
- `packages/connectors/src/tms/HttpTmsAdapter.ts`
- `packages/connectors/src/tms/TmsAdapterConfig.ts`
- `packages/connectors/src/tms/historicalAnalysis.ts`
- `packages/connectors/tests/tms-adapter.test.ts`
- `apps/control-plane/src/installPack.ts`
- `apps/control-plane/src/onboarding/createClientManifest.ts`
- `apps/control-plane/src/onboarding/validateTms.ts`
- `apps/control-plane/tests/install-pack-install.test.ts`
- `apps/control-plane/tests/onboarding.test.ts`
- `apps/control-plane-api/src/data/index.ts`
- `apps/control-plane-api/src/data/file.ts`
- `apps/control-plane-api/src/data/postgres.ts`
- `apps/control-plane-api/src/installerScript.ts`
- `apps/control-plane-api/src/index.ts`
- `apps/control-plane-api/tests/control-plane-api.test.ts`
- `apps/api/src/onboard/cli.ts`
- `apps/api/src/onboard/onboardConfig.ts`
- `apps/api/src/index.ts`
- `apps/api/tests/api.test.ts`
- `apps/api/tests/onboard.test.ts`
- `apps/web/src/api/quoteOpsApi.ts`
- `apps/web/src/pages/clientSetupWizard.tsx`
- `apps/web/tests/portalUi.test.tsx`
- `deploy/appliance/docker-compose.yml`
- `deploy/appliance/Caddyfile`
- `deploy/appliance/entrypoint.sh`
- `deploy/appliance/install.sh`
- `deploy/appliance/upgrade.sh`
- `deploy/appliance/backup.sh`
- `deploy/appliance/restore.sh`
- `deploy/appliance/README.md`
- `deploy/appliance/CONTROL_PLANE.md`
- `deploy/appliance/SECRETS.md`
- `deploy/appliance/mock-tms/server.mjs`
- `deploy/appliance/mock-tms/tms-adapter.http.yaml`
- `deploy/appliance/mock-tms/README.md`
- `deploy/appliance/tests/smoke.sh`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `vercel.json`
- `package.json`
- `package-lock.json`

---

### Task 1: Define and Produce an Immutable Appliance Release Bundle

**Files:**
- Create: `packages/shared/src/applianceRelease.ts`
- Create: `scripts/package-appliance-release.mjs`
- Modify: `packages/shared/src/index.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/release.yml`
- Test: `apps/control-plane/tests/task-d-deploy.test.ts`

**Interfaces:**
- Produces: `applianceReleaseSchema`, `publishedApplianceReleaseSchema`, `ApplianceRelease`, `PublishedApplianceRelease`, and their parse functions.
- Initial fixture command: `SOURCE_DATE_EPOCH=1785348000 npm run package:appliance -- --version v0.2.0 --git-sha 0123456789abcdef0123456789abcdef01234567 --agent-digest sha256:1111111111111111111111111111111111111111111111111111111111111111 --api-digest sha256:2222222222222222222222222222222222222222222222222222222222222222 --web-digest sha256:3333333333333333333333333333333333333333333333333333333333333333 --postgres-image postgres:16-alpine@sha256:4444444444444444444444444444444444444444444444444444444444444444 --redis-image redis:7-alpine@sha256:5555555555555555555555555555555555555555555555555555555555555555 --caddy-image caddy:2-alpine@sha256:6666666666666666666666666666666666666666666666666666666666666666`.
- Initial output directory: `dist/appliance/v0.2.0/`, containing `quoteops-appliance-v0.2.0.tar.gz`, `release.json`, `bootstrap.sh`, and `SHA256SUMS`.
- Consumed by: Tasks 2, 3, 8, and 9.

- [ ] **Step 1: Write the failing release-contract test**

Add assertions to `apps/control-plane/tests/task-d-deploy.test.ts` that parse a complete manifest, reject both unpinned `latest` and digest-pinned `:latest@sha256:...` for application or dependency images, reject a non-`linux/amd64` application platform, and reject an unpinned Cloudflare image.

```ts
import { parseApplianceRelease } from "@quoteops/shared";

const release = parseApplianceRelease({
  schema_version: 1,
  version: "v0.2.0",
  git_sha: "0123456789abcdef0123456789abcdef01234567",
  platform: "linux/amd64",
  images: {
    agent:
      "ghcr.io/alejandroc-bit/quote-ops-agent:v0.2.0@sha256:" + "1".repeat(64),
    api:
      "ghcr.io/alejandroc-bit/quote-ops-api:v0.2.0@sha256:" + "2".repeat(64),
    web:
      "ghcr.io/alejandroc-bit/quote-ops-web:v0.2.0@sha256:" + "3".repeat(64),
    postgres: "postgres:16-alpine@sha256:" + "4".repeat(64),
    redis: "redis:7-alpine@sha256:" + "5".repeat(64),
    caddy: "caddy:2-alpine@sha256:" + "6".repeat(64),
    cloudflared:
      "cloudflare/cloudflared:2026.7.3@sha256:e39ee8da81ad5e05d77f38d2f51c60ca51bf2a8450ac3abab50c17fdb91d91bf"
  },
  files_sha256: {
    "docker-compose.yml": "a".repeat(64)
  },
  created_at: "2026-07-29T18:00:00.000Z"
});

expect(release.version).toBe("v0.2.0");
expect(() =>
  parseApplianceRelease({
    ...release,
    images: { ...release.images, api: "ghcr.io/alejandroc-bit/quote-ops-api:latest" }
  })
).toThrow(/digest-pinned|semver tag/i);
expect(() =>
  parseApplianceRelease({
    ...release,
    images: {
      ...release.images,
      postgres: "postgres:latest@sha256:" + "4".repeat(64)
    }
  })
).toThrow(/latest is forbidden/i);
expect(() =>
  parseApplianceRelease({
    ...release,
    images: {
      ...release.images,
      api:
        "ghcr.io/alejandroc-bit/quote-ops-api:v0.1.9@sha256:" +
        "2".repeat(64)
    }
  })
).toThrow(/must equal v0\.2\.0/i);
```

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
npx vitest run apps/control-plane/tests/task-d-deploy.test.ts
```

Expected: FAIL because `parseApplianceRelease` does not exist.

- [ ] **Step 3: Add the exact release schema**

Create `packages/shared/src/applianceRelease.ts` with this public shape:

```ts
import { z } from "zod";

const versionSchema = z.string().regex(/^v\d+\.\d+\.\d+$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const digestImageSchema = z
  .string()
  .regex(/^[^@\s]+@sha256:[a-f0-9]{64}$/, "digest-pinned image required")
  .refine(
    (value) => !/:latest@sha256:/i.test(value),
    "latest is forbidden even when digest-pinned"
  );
const applicationImageSchema = digestImageSchema.refine(
  (value) => /:v\d+\.\d+\.\d+@sha256:/.test(value),
  "application image requires semver tag plus digest"
);

export const applianceReleaseSchema = z
  .object({
    schema_version: z.literal(1),
    version: versionSchema,
    git_sha: z.string().regex(/^[a-f0-9]{40}$/),
    platform: z.literal("linux/amd64"),
    images: z
      .object({
        agent: applicationImageSchema,
        api: applicationImageSchema,
        web: applicationImageSchema,
        postgres: digestImageSchema,
        redis: digestImageSchema,
        caddy: digestImageSchema,
        cloudflared: digestImageSchema
      })
      .strict(),
    files_sha256: z.record(z.string().min(1), sha256Schema),
    created_at: z.string().datetime({ offset: true })
  })
  .strict()
  .superRefine((release, context) => {
    for (const image of ["agent", "api", "web"] as const) {
      if (!release.images[image].includes(`:${release.version}@sha256:`)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["images", image],
          message: `application image tag must equal ${release.version}`
        });
      }
    }
  });

export type ApplianceRelease = z.infer<typeof applianceReleaseSchema>;

export function parseApplianceRelease(value: unknown): ApplianceRelease {
  return applianceReleaseSchema.parse(value);
}

export const publishedApplianceReleaseSchema = z
  .object({
    manifest: applianceReleaseSchema,
    bundle_sha256: sha256Schema
  })
  .strict();

export type PublishedApplianceRelease = z.infer<
  typeof publishedApplianceReleaseSchema
>;

export function parsePublishedApplianceRelease(
  value: unknown
): PublishedApplianceRelease {
  return publishedApplianceReleaseSchema.parse(value);
}
```

Export it from `packages/shared/src/index.ts`.

- [ ] **Step 4: Run the focused test to verify GREEN**

Run:

```bash
npx vitest run apps/control-plane/tests/task-d-deploy.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write the failing bundle-generator test**

Extend `apps/control-plane/tests/task-d-deploy.test.ts` to create a complete temporary source-asset fixture, including a stub `bootstrap.sh` implemented in Task 3 (the test supplies stub bytes for files implemented in later tasks), execute the packaging script with `--assets-dir`, and assert that the archive inventory contains exactly these runtime assets:

```ts
const requiredAssets = [
  "release.json",
  "PAYLOAD_SHA256SUMS",
  "release.env",
  "docker-compose.yml",
  "Caddyfile",
  "install.sh",
  "quoteops.sh",
  "verify-install.sh",
  "upgrade.sh",
  "backup.sh",
  "restore.sh",
  "secrets.sh"
];
expect(archiveEntries.sort()).toEqual(requiredAssets.sort());
expect(Object.keys(release.files_sha256).sort()).toEqual(
  requiredAssets
    .filter((name) => !["release.json", "PAYLOAD_SHA256SUMS"].includes(name))
    .sort()
);
expect(release.files_sha256["docker-compose.yml"]).toMatch(/^[a-f0-9]{64}$/);
expect(bundleSha256FromSums).toMatch(/^[a-f0-9]{64}$/);
expect(manifestSha256FromSums).toMatch(/^[a-f0-9]{64}$/);
expect(bootstrapSha256FromSums).toMatch(/^[a-f0-9]{64}$/);
expect(extractedMode("install.sh")).toBe(0o755);
expect(extractedMode("quoteops.sh")).toBe(0o755);
expect(extractedMode("docker-compose.yml")).toBe(0o644);
expect(archiveEntries).not.toContain("bootstrap.sh");
```

- [ ] **Step 6: Run the bundle test to verify RED**

Run:

```bash
npx vitest run apps/control-plane/tests/task-d-deploy.test.ts
```

Expected: FAIL because the package script does not exist.

- [ ] **Step 7: Implement deterministic packaging**

Create `scripts/package-appliance-release.mjs` to:

1. require `--version` matching `^v\d+\.\d+\.\d+$`;
2. require a 40-character lowercase `--git-sha`;
3. accept `--assets-dir` for tests and default it to `deploy/appliance`; require `bootstrap.sh` there as a separate deployment asset, not a tar entry;
4. require application digests through `--agent-digest`, `--api-digest`, and `--web-digest`, plus full `--postgres-image`, `--redis-image`, and `--caddy-image` digest references; build semver-tag-plus-digest application references;
5. copy only the declared runtime assets into a temporary staging directory;
6. generate `release.env` with only `QUOTEOPS_VERSION`, `QUOTEOPS_PLATFORM`, and the seven digest-pinned `QUOTEOPS_*_IMAGE` values for agent, API, web, PostgreSQL, Redis, Caddy, and cloudflared;
7. normalize executable scripts to `0755` and configuration files to `0644`;
8. hash every staged runtime asset except generated `release.json` and `PAYLOAD_SHA256SUMS`, then write those hashes into `release.json.files_sha256`;
9. write `release.json` with the three exact GHCR semver-plus-digest references and digest-pinned PostgreSQL, Redis, Caddy, and Cloudflare images;
10. generate in-archive `PAYLOAD_SHA256SUMS` containing sorted hashes for `release.json` and every other archive entry except itself; it is the portable post-extraction integrity verifier;
11. create the tarball once with sorted names, uid/gid `0`, normalized modes, tar entry mtime from required `SOURCE_DATE_EPOCH`, and gzip mtime `0`;
12. copy the exact in-archive `release.json` plus executable `bootstrap.sh` next to the tarball for control-plane deployment;
13. calculate SHA-256 for the final tarball, adjacent `release.json`, and adjacent `bootstrap.sh`, then write those three exact filenames in sorted order to detached `SHA256SUMS`.

The archive and `release.json` must never contain their own hashes: that would create a self-referential checksum. Detached `SHA256SUMS` may safely authenticate all three adjacent artifacts. The control plane joins the immutable manifest and tarball checksum into `PublishedApplianceRelease`.

Use the `tar-stream` package plus Node’s `zlib.createGzip({ mtime: 0 })` instead of GNU-only `tar` flags, so the packaging test runs identically on Ubuntu and this Mac. The test must create every declared asset in a temporary fixture directory, run the packager twice with the same `SOURCE_DATE_EPOCH`, and assert byte-identical tarballs. It must also reject one missing or extra file.

Add:

```json
{
  "scripts": {
    "package:appliance": "node scripts/package-appliance-release.mjs"
  }
}
```

Run `npm install --save-dev tar-stream` so `package.json` and `package-lock.json` pin the portable archive implementation.

The script must print only the three output paths, never file contents.

- [ ] **Step 8: Make release publication depend on verification**

Modify `.github/workflows/release.yml` so the release job:

```yaml
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm test -- --run
      - run: bash deploy/appliance/tests/smoke.sh

  build-and-push:
    needs: verify
```

Have each `docker/build-push-action` step expose its pushed digest as a job output. Do not publish the final appliance bundle in this task because Tasks 3, 4, and 9 still create runtime assets. Task 9 adds the post-runtime `package-appliance` and publication jobs. Keep the anonymous pull gate here, but run it in a separate job on a fresh runner with no registry login or local image cache and pull every semver-plus-digest reference. The job must fail on `403` or a mutable reference.

- [ ] **Step 9: Run release-contract verification**

Run:

```bash
npm run build
npx vitest run apps/control-plane/tests/task-d-deploy.test.ts
bash deploy/appliance/tests/smoke.sh
```

Expected: all commands PASS and the generated manifest contains no `latest`.

- [ ] **Step 10: Commit**

```bash
git add packages/shared/src/applianceRelease.ts packages/shared/src/index.ts scripts/package-appliance-release.mjs package.json package-lock.json .github/workflows/release.yml apps/control-plane/tests/task-d-deploy.test.ts
git commit -m "feat(release): package immutable appliance bundles"
```

---

### Task 2: Pin Registration Tokens and Install Packs to a Release

**Files:**
- Modify: `apps/control-plane/src/installPack.ts`
- Modify: `apps/control-plane/tests/install-pack-install.test.ts`
- Modify: `apps/control-plane-api/src/data/index.ts`
- Modify: `apps/control-plane-api/src/data/file.ts`
- Modify: `apps/control-plane-api/src/data/postgres.ts`
- Modify: `apps/control-plane-api/src/index.ts`
- Modify: `apps/control-plane-api/src/installerScript.ts`
- Modify: `apps/control-plane-api/tests/control-plane-api.test.ts`

**Interfaces:**
- Consumes: `PublishedApplianceRelease` from Task 1.
- Produces: `InstallPack.release`, containing `version` and `bundle_sha256`.
- Produces: `IssuedInstallPack`, the control-plane-only response that adds the one-time `registration_token`; the rendered install payload never contains that token.
- Produces: `RegistrationTokenRecord.release_version`, `bundle_sha256`, `install_pack_snapshot`, and `pack_sha256`; the safe client overlay is frozen at token issuance instead of being regenerated by a later deployment.
- Produces: versioned `ReleaseRecord` storage containing the parsed manifest, detached hash, and bounded archive bytes.
- Produces: `getRelease(version)` and `upsertRelease(release)` data operations; release rows are immutable by version/hash.
- Produces: authenticated `GET /api/install` using the registration token as a Bearer credential.
- Removes: legacy `GET /api/install/:registrationToken`; production must never accept credentials in URL paths.
- Replaces: live-checkout `APPLIANCE_DEPLOY_FILES` rendering with the exact verified archive pinned by `InstallPack.release.bundle_sha256`.

- [ ] **Step 1: Write the failing install-pack release-pin test**

In `apps/control-plane/tests/install-pack-install.test.ts`, construct `createInstallPack` with a release and assert:

```ts
expect(pack.release).toEqual({
  version: "v0.2.0",
  bundle_sha256: "a".repeat(64)
});
expect(pack.install_command).toContain(
  'curl --proto "=https" --proto-redir "=https" --tlsv1.2'
);
expect(pack.install_command).toContain(`${pack.control_plane_url}/install/quoteops`);
expect(pack.install_command).toContain("sudo bash");
expect(pack.install_command).not.toContain("|");
expect(pack.install_command).not.toContain(pack.registration_token);
```

- [ ] **Step 2: Run the install-pack test to verify RED**

Run:

```bash
npx vitest run apps/control-plane/tests/install-pack-install.test.ts
```

Expected: FAIL because `InstallPack` has no release field and still embeds the token route.

- [ ] **Step 3: Extend the install-pack contract**

Change the public shape in `apps/control-plane/src/installPack.ts`:

```ts
export type InstallPack = {
  client_id: string;
  installation_id: string;
  expires_at: string;
  control_plane_url: string;
  install_command: string;
  release: {
    version: string;
    bundle_sha256: string;
  };
  files: Record<string, string>;
};

export type IssuedInstallPack = InstallPack & {
  registration_token: string;
};
```

Require `release: PublishedApplianceRelease` in `createInstallPack`, set the stable bootstrap command, copy `release.manifest.version` and `release.bundle_sha256` into the safe pack, and return the token only in the outer `IssuedInstallPack` response shown once to the control-plane operator. Render the command as one `bash -c` invocation that enables `set -Eeuo pipefail`, downloads the bootstrap to `mktemp` with `curl --proto "=https" --proto-redir "=https" --tlsv1.2`, executes it only after curl succeeds, and removes the temporary file through a trap; do not use a `curl | bash` pipeline.

Require `control_plane_url` to be the configured normalized HTTPS origin with no userinfo/path/query/fragment. Install-pack issuance and installer serving return `503 control_plane_origin_missing` when `QUOTEOPS_CONTROL_PLANE_URL` is absent or invalid; they must never fall back to request host headers. Assert the same canonical value is embedded for installation, activation, heartbeat, and update URLs.

- [ ] **Step 4: Add the failing token-persistence tests**

In `apps/control-plane-api/tests/control-plane-api.test.ts`, assert that:

```ts
expect(savedToken.release_version).toBe("v0.2.0");
expect(savedToken.bundle_sha256).toBe("a".repeat(64));
expect(savedToken.install_pack_snapshot).toEqual(issuedPackWithoutToken);
expect(savedToken.pack_sha256).toBe(
  sha256(canonicalizeInstallPack(issuedPackWithoutToken))
);
expect(
  JSON.stringify(savedToken.install_pack_snapshot)
).not.toContain(registrationToken);
```

Also assert:

```ts
await request(app).get("/api/install").expect(401);
await request(app)
  .get("/api/install")
  .set("authorization", `Bearer ${registrationToken}`)
  .expect(200)
  .expect("content-type", /text\/x-shellscript/);
```

Add the deployment-drift regression: issue a token while `v0.2.0` and overlay fixture A are current, publish `v0.2.1`, change the live install-pack/template builder to fixture B, and then redeem the old token. The rendered installer must still contain the byte-equivalent canonical snapshot/hash for fixture A and the `v0.2.0` bundle; it must contain neither fixture B nor `v0.2.1`. Tampering with the stored snapshot, hash, release version, or bundle hash must fail closed before rendering.

- [ ] **Step 5: Run the control-plane test to verify RED**

Run:

```bash
npx vitest run apps/control-plane-api/tests/control-plane-api.test.ts
```

Expected: FAIL because tokens do not pin releases and `/api/install` does not exist.

- [ ] **Step 6: Persist the release pin**

Extend `RegistrationTokenRecord` with:

```ts
release_version: string;
bundle_sha256: string;
install_pack_snapshot: InstallPack;
pack_sha256: string;
```

Update memory/file stores and the PostgreSQL `registration_tokens` table. Add `install_pack jsonb` and `pack_sha256 text` alongside the release-pin columns with additive `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements. Preserve the existing hashed-token storage. A legacy record that lacks any release pin, pack snapshot, or pack hash is not reconstructable safely and must be rejected as `registration_token_reissue_required`; do not synthesize it from the currently deployed templates. Document that the operator must issue a fresh token after this migration.

Define one canonical JSON serializer that recursively sorts object keys, preserves array order and UTF-8 string bytes, and rejects non-JSON values. `pack_sha256` is the SHA-256 of that canonical serialization. On every store read/write, parse `install_pack` through the `InstallPack` schema, recompute the canonical hash, require exact agreement with `pack_sha256`, and require the snapshot’s client ID, installation ID, expiry, and release to match their token-record fields. The snapshot must never contain `registration_token` or another secret field.

Extend `ReleaseRecord` from `{ version, notes }` to:

```ts
export type ReleaseRecord = {
  version: string;
  notes: string | null;
  bundle_sha256: string;
  manifest: ApplianceRelease;
  manifest_bytes: Uint8Array;
  archive_bytes: Uint8Array;
  published_at: string;
};
```

Add `getRelease(version)` and `upsertRelease(release)` to every data store. In PostgreSQL, add `bundle_sha256 text`, `manifest jsonb`, `manifest_bytes bytea`, `archive bytea`, and `published_at timestamptz` to `releases`; in the file store, encode both byte fields as base64 behind the data interface. Parse `manifest_bytes` into `manifest` on write/read, require exact agreement, and retain the original bytes so they can be compared with in-archive `release.json`. Enforce a 2 MiB raw archive maximum, immutable `version + bundle_sha256`, and re-hash bytes on write/read. Also reject any rendered self-extractor whose UTF-8 response exceeds 4,000,000 bytes, leaving headroom under Vercel’s documented [4.5 MB Function response limit](https://vercel.com/docs/functions/limitations#request-body-size); add boundary tests for both caps. Never return either byte field from public release metadata. Retain all appliance release rows in v1 so an unexpired pinned token remains installable across a newer control-plane deploy.

- [ ] **Step 7: Resolve one release before issuing a token**

In `apps/control-plane-api/src/index.ts`, add one helper:

```ts
async function requireInstallableRelease(): Promise<PublishedApplianceRelease> {
  const published = await data.latestRelease();
  if (
    !published ||
    !/^[a-f0-9]{64}$/.test(published.bundle_sha256) ||
    sha256(published.archive_bytes) !== published.bundle_sha256
  ) {
    throw new ApiError(
      503,
      "release_unavailable",
      "no verified appliance release is available"
    );
  }
  return parsePublishedApplianceRelease({
    manifest: published.manifest,
    bundle_sha256: published.bundle_sha256
  });
}
```

Call it once before issuing each registration token. In the same issuance operation, build the complete safe `InstallPack` exactly once from that release and the client overlay, canonicalize and hash it, and persist the token hash, release pin, exact snapshot, and `pack_sha256` atomically before returning `IssuedInstallPack`. The response is the persisted safe snapshot plus the plaintext token shown once; later deployments must not be able to change it. Seed tests through `upsertRelease`; Task 9 adds the authenticated deployment sync that inserts real published bytes.

- [ ] **Step 8: Add the authenticated installer endpoint**

Add `GET /api/install`, parse the Bearer token without logging it, validate unused/unexpired status, load and schema-validate the stored `install_pack_snapshot`, recompute and verify `pack_sha256`, call `data.getRelease(token.release_version)`, and require its immutable hash to equal `token.bundle_sha256`. This endpoint must never call `createInstallPack`, read current client templates, or merge a live overlay. Before rendering:

1. hash the stored archive bytes and require equality with the release row, token pin, and stored `pack.release.bundle_sha256`;
2. parse the stored manifest and require its version to equal the row, token pin, and stored `pack.release.version`;
3. require the stored manifest bytes to equal the in-archive `release.json`;
4. reject a non-regular archive entry, symlink, hardlink, absolute path, `..` traversal, duplicate entry, missing file, or extra file;
5. verify every extracted payload hash against `files_sha256`.

Preserve client-specific `pack.files` separately from the immutable runtime archive. Validate every key against an exact server-side allowlist (`client-manifest.yaml`, `criteria-template.yaml`, and declared `connectors/**` files), reject absolute/traversal/duplicate/runtime-asset collisions, and have the generated script materialize those UTF-8 files only after the release archive verifies, with directories `0755` and files `0644`. Add malicious `../`, absolute-path, and `install.sh` collision tests. The release archive remains identical for every client; these non-secret pack files are the per-install overlay consumed by the handoff below.

Change the renderer interface to:

```ts
renderInstallerScript({
  pack,
  archiveBytes,
  bundleSha256,
  manifest
}: {
  pack: InstallPack;
  archiveBytes: Buffer;
  bundleSha256: string;
  manifest: ApplianceRelease;
}): string
```

The self-extractor embeds that exact archive, not files re-read from the live checkout. Render the already parsed manifest’s exact filename/hash pairs as shell constants and embed the expected `release.json` bytes as base64; verification does not depend on host-side Node. Add a test that flips one archive byte and asserts the generated installer exits before invoking `install.sh` or creating `current`.

Do not register `GET /api/install/:registrationToken`. Add a regression test that the old path is `404` and that no request logger captures the path segment. Add `Cache-Control: no-store` and `Referrer-Policy: no-referrer` to the authenticated response.

- [ ] **Step 9: Pass the exact version into `install.sh`**

In the self-extractor, add portable helpers:

```bash
decode_base64() {
  if base64 --help 2>&1 | grep -q -- '--decode'; then base64 --decode; else base64 -D; fi
}
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}
```

Decode into a `mktemp -d` directory, verify the detached hash before extraction, apply the entry/type/path checks above, verify `files_sha256`, and then hand off:

```bash
bash install.sh \
  --client '${pack.client_id}' \
  --manifest client-manifest.yaml \
  --connectors connectors \
  --compose-file docker-compose.yml \
  --control-plane-url '${pack.control_plane_url}' \
  --registration-token-file "$QUOTEOPS_REGISTRATION_TOKEN_FILE" \
  --installation-id '${pack.installation_id}' \
  --version '${pack.release.version}' \
  --guided \
  "$@"
```

The self-extractor must install an `EXIT/INT/TERM` trap that first changes to `/`, validates its extraction directory against the exact `mktemp -d` prefix it created, and removes only that directory. Do not `exec` the child installer because that bypasses cleanup; capture and return the child status after the trap runs. Reject a render request when `pack.release.version` differs from the bundled `release.json`. Shell code must read release-local image/version values from the strictly validated `release.env`; the VM does not require host-side Node, and bootstrap installs `jq` for lifecycle JSON.

- [ ] **Step 10: Run focused tests**

Run:

```bash
npx vitest run apps/control-plane/tests/install-pack-install.test.ts apps/control-plane-api/tests/control-plane-api.test.ts
```

Expected: PASS, with no registration token in `install_command`, URL, or response snapshots.

- [ ] **Step 11: Commit**

```bash
git add apps/control-plane/src/installPack.ts apps/control-plane/tests/install-pack-install.test.ts apps/control-plane-api/src/data/index.ts apps/control-plane-api/src/data/file.ts apps/control-plane-api/src/data/postgres.ts apps/control-plane-api/src/index.ts apps/control-plane-api/src/installerScript.ts apps/control-plane-api/tests/control-plane-api.test.ts
git commit -m "feat(installer): pin client packs to appliance releases"
```

---

### Task 3: Add the Stable One-Command Ubuntu Bootstrap and Runtime Layout

**Files:**
- Create: `deploy/appliance/bootstrap.sh`
- Create: `deploy/appliance/quoteops.sh`
- Modify: `apps/control-plane-api/src/installerScript.ts`
- Modify: `apps/control-plane-api/src/index.ts`
- Modify: `apps/control-plane-api/tests/control-plane-api.test.ts`
- Modify: `deploy/appliance/docker-compose.yml`
- Modify: `deploy/appliance/install.sh`
- Modify: `deploy/appliance/tests/smoke.sh`

**Interfaces:**
- Consumes: authenticated `/api/install` and release pin from Task 2.
- Produces: public `GET /install/quoteops`.
- Produces: `/usr/local/bin/quoteops`.
- Produces: stable release/data layout and atomic `current` symlink.
- Produces test-only `QUOTEOPS_HOME` and `QUOTEOPS_BIN_DIR` overrides that cannot escape the Mac acceptance root.
- Produces operator commands: `quoteops status|doctor|onboard|update|rollback|backup|restore|logs`.

- [ ] **Step 1: Write failing bootstrap rendering tests**

Add assertions to `apps/control-plane-api/tests/control-plane-api.test.ts`:

```ts
const response = await request(app).get("/install/quoteops").expect(200);
expect(response.text).toContain('read -r -s -p "Registration token: "');
expect(response.text).toContain('header = "Authorization: Bearer %s"');
expect(response.text).toContain('QUOTEOPS_REGISTRATION_TOKEN_FILE="$TOKEN_FILE"');
expect(response.text).toContain('bash "$INSTALLER_FILE" "$@" </dev/tty');
expect(response.text).toContain('bash "$INSTALLER_FILE" "$@" </dev/null');
expect(response.text).not.toContain("/api/install/$QUOTEOPS_REGISTRATION_TOKEN");
```

- [ ] **Step 2: Run the endpoint test to verify RED**

Run:

```bash
npx vitest run apps/control-plane-api/tests/control-plane-api.test.ts
```

Expected: FAIL with `GET /install/quoteops` returning 404.

- [ ] **Step 3: Implement the bootstrap script**

Create `deploy/appliance/bootstrap.sh` with:

```bash
#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

CONTROL_PLANE_URL="${QUOTEOPS_CONTROL_PLANE_URL:-__QUOTEOPS_CONTROL_PLANE_URL__}"
INSTALLER_FILE="$(mktemp "${TMPDIR:-/tmp}/quoteops-installer.XXXXXX")"
CURL_CONFIG_FILE="$(mktemp "${TMPDIR:-/tmp}/quoteops-curl.XXXXXX")"
TOKEN_FILE="$(mktemp "${TMPDIR:-/tmp}/quoteops-token.XXXXXX")"
cleanup() { rm -f "$INSTALLER_FILE" "$CURL_CONFIG_FILE" "$TOKEN_FILE"; }
trap cleanup EXIT

if [[ "${QUOTEOPS_BOOTSTRAP_TEST_MODE:-}" == "macbook" ]]; then
  [[ "$(uname -s)" == "Darwin" ]] ||
    { echo "macbook test mode requires Darwin" >&2; exit 1; }
  [[ "${QUOTEOPS_HOME:-}" == "${TMPDIR:-/tmp}"/quoteops-mac-e2e.*/quoteops-v1 ]] ||
    { echo "macbook test mode requires a bounded temporary QUOTEOPS_HOME" >&2; exit 1; }
  reject_symlink_path "$QUOTEOPS_HOME"
else
  [[ -r /etc/os-release ]] ||
    { echo "Ubuntu 24.04 is required" >&2; exit 1; }
  . /etc/os-release
  [[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "24.04" ]] ||
    { echo "Ubuntu 24.04 is required" >&2; exit 1; }
  [[ "$(uname -m)" == "x86_64" ]] ||
    { echo "linux/amd64 is required" >&2; exit 1; }
fi

if [[ -n "${QUOTEOPS_REGISTRATION_TOKEN_FILE:-}" ]]; then
  validate_secret_file "$QUOTEOPS_REGISTRATION_TOKEN_FILE"
  QUOTEOPS_REGISTRATION_TOKEN="$(<"$QUOTEOPS_REGISTRATION_TOKEN_FILE")"
else
  exec 3</dev/tty
  read -r -s -p "Registration token: " QUOTEOPS_REGISTRATION_TOKEN <&3
  printf "\n" >&2
fi
[[ "$QUOTEOPS_REGISTRATION_TOKEN" =~ ^[A-Za-z0-9._~-]{32,512}$ ]] ||
  { echo "Registration token is required" >&2; exit 1; }
printf '%s' "$QUOTEOPS_REGISTRATION_TOKEN" >"$TOKEN_FILE"
printf 'header = "Authorization: Bearer %s"\n' \
  "$QUOTEOPS_REGISTRATION_TOKEN" >"$CURL_CONFIG_FILE"
chmod 600 "$TOKEN_FILE" "$CURL_CONFIG_FILE"
unset QUOTEOPS_REGISTRATION_TOKEN

install_docker_if_missing

curl --fail --silent --show-error --location \
  --proto "=https" --proto-redir "=https" --tlsv1.2 \
  --config "$CURL_CONFIG_FILE" \
  --output "$INSTALLER_FILE" \
  "$CONTROL_PLANE_URL/api/install"
chmod 700 "$INSTALLER_FILE"

export QUOTEOPS_REGISTRATION_TOKEN_FILE="$TOKEN_FILE"
if [[ -n "${QUOTEOPS_AUTOMATION_MODE:-}" ]]; then
  bash "$INSTALLER_FILE" "$@" </dev/null
else
  bash "$INSTALLER_FILE" "$@" </dev/tty
fi
```

Install base host dependencies `ca-certificates`, `curl`, `gnupg`, and `jq` from Ubuntu’s signed repositories. Implement `install_docker_if_missing` with Docker’s official Ubuntu apt repository and packages `docker-ce`, `docker-ce-cli`, `containerd.io`, `docker-buildx-plugin`, and `docker-compose-plugin`. Do not execute another remote shell installer.

`QUOTEOPS_BOOTSTRAP_TEST_MODE=macbook` is accepted only on Darwin. First resolve the trusted system `${TMPDIR:-/tmp}` with `pwd -P`/`realpath` (macOS commonly canonicalizes `/var/...` to `/private/var/...`), then require the physical `QUOTEOPS_HOME` to match `$PHYSICAL_TMPDIR/quoteops-mac-e2e.*/quoteops-v1`. Reject symlinks created anywhere below the trusted physical temp root, but do not reject the operating system’s own `/var` prefix alias. It skips the Ubuntu/architecture gate and apt installation but still requires a working Docker daemon, downloads the authenticated release, verifies its checksum, and executes the same installer. Add `/var`→`/private/var` pass, wrong-prefix, home-directory, and below-root symlink-escape tests. The production command never sets this flag.

Implement `validate_secret_file` with the same regular-file, non-symlink, owner, and `0600` checks used by the onboarding answers path. The unattended token-file branch exists only for bounded acceptance automation; Task 10 sets `QUOTEOPS_AUTOMATION_MODE=1`, forwards installer arguments, and uses `/dev/null`. The displayed production command never sets automation mode and always uses the hidden `/dev/tty` prompt.

- [ ] **Step 4: Render the stable control-plane URL**

Load `bootstrap.sh` only from the deployed `dist/appliance/$QUOTEOPS_APPLIANCE_RELEASE_VERSION/bootstrap.sh`, verify its detached entry in the adjacent `SHA256SUMS`, then replace only `__QUOTEOPS_CONTROL_PLANE_URL__` with the server-configured canonical HTTPS control-plane origin and shell-escape it. Do not read the live repository checkout. Serve it from `GET /install/quoteops` with `text/x-shellscript`, `no-store`, and `no-referrer`. Never derive this value from the request `Host`, `Forwarded`, or `X-Forwarded-Host` headers; add hostile-host-header, missing-deployment-asset, and checksum-mismatch tests.

- [ ] **Step 5: Write failing runtime-layout smoke assertions**

Extend `deploy/appliance/tests/smoke.sh` to run `install.sh --skip-start` in a temporary home and assert:

```bash
test -d "$TEST_HOME/releases/v0.2.0"
test -L "$TEST_HOME/current"
test "$(readlink "$TEST_HOME/current")" = "$TEST_HOME/releases/v0.2.0"
test -x "$TEST_HOME/current/quoteops.sh"
test -x "$TEST_ROOT/usr-local-bin/quoteops"
test -d "$TEST_HOME/manifests"
test -d "$TEST_HOME/connectors"
test -d "$TEST_HOME/secrets"
```

Assert a second installation of the same release is idempotent, preserves the exact pre-existing `POSTGRES_PASSWORD` and registration token in `secrets/client.env`, and an attempted different client ID fails without modifying `current`. Assert the shared `.env` contains no password or token values.

- [ ] **Step 6: Run the shell smoke to verify RED**

Run:

```bash
bash deploy/appliance/tests/smoke.sh
```

Expected: FAIL because release directories and the CLI do not exist.

- [ ] **Step 7: Install immutable assets separately from data**

Modify `install.sh` so `--version` is mandatory in guided/production mode and so it:

1. stages runtime files under `$QUOTEOPS_HOME/releases/$QUOTEOPS_VERSION.tmp`;
2. validates every required runtime asset before activation;
3. renames the staging directory to `$QUOTEOPS_HOME/releases/$QUOTEOPS_VERSION`;
4. creates data directories only at `$QUOTEOPS_HOME/{manifests,criteria,connectors,secrets,settings,state,logs,backups}`;
5. switches `$QUOTEOPS_HOME/current` using a temporary symlink plus `mv`;
6. validates release-local `release.env` against an allowlist and uses it as the second Compose env file after the shared `.env`;
7. writes an executable stable wrapper at `${QUOTEOPS_BIN_DIR:-/usr/local/bin}/quoteops` that executes `$QUOTEOPS_HOME/current/quoteops.sh "$@"`;
8. keeps `.env`, `secrets/client.env`, and `secrets/cloudflare.env` outside all release directories, creates both secret files at `0600` before the first Compose command, and atomically writes `QUOTEOPS_CLIENT_ENV_FILE=$QUOTEOPS_HOME/secrets/client.env` plus `QUOTEOPS_CLOUDFLARE_ENV_FILE=$QUOTEOPS_HOME/secrets/cloudflare.env` to the shared `.env`;
9. reads the registration token from `--registration-token-file`, atomically stores it as `QUOTEOPS_REGISTRATION_TOKEN` in `secrets/client.env` before starting the local API, and deletes only the transient input file after the secure copy succeeds.

Preserve the existing direct-install default version only when `--guided` is absent, and print a deprecation warning for that fallback. In this explicitly development-only branch, synthesize the release-local `release.env` from the existing allowlisted image environment inputs and versioned tag defaults so current repository invocations still work; reject `latest`, never enter this branch from a control-plane installer, and mark it `legacy_direct` in status. Guided/production mode always requires the checksum-verified release-provided file and never synthesizes one. Add a regression test for the pre-existing direct command.

Generate `POSTGRES_PASSWORD` once with a cryptographic RNG only when that allowlisted key is absent from `secrets/client.env`; PostgreSQL and application services read it from that same env file. Never place it in shared `.env`, never regenerate it on reinstall/update/resume, and never print it. A missing password with an existing PostgreSQL data volume is a hard recovery error, not permission to generate a replacement.

In Compose, attach `${QUOTEOPS_CLIENT_ENV_FILE:?QUOTEOPS_CLIENT_ENV_FILE is required}` as a required long-syntax `env_file` to PostgreSQL, agent, API, and onboarding services only. Web, Caddy, and cloudflared must not receive it.

Add `--registration-token-file` and reject `--registration-token` in guided mode. Read the token once from the `0600` file, use it only through `0600` curl-config files or request bodies read from stdin, and remove the bootstrap token file after the durable secret write succeeds. The durable registration token is the installation’s long-lived control-plane credential after activation and remains in `client.env` for heartbeat, update, and authenticated artifact download.

Implement a portable `switch_current_release` helper that validates both link targets, uses `mv -Tf` when available on GNU coreutils and `mv -hf` on BSD/macOS, then confirms `readlink current` equals the intended absolute release directory. `QUOTEOPS_BIN_DIR` defaults to `/usr/local/bin`; permit an override only in bounded test mode and set it to `$E2E_ROOT/bin` on the Mac.

In `deploy/appliance/docker-compose.yml`, set:

```yaml
platform: ${QUOTEOPS_PLATFORM:-linux/amd64}
```

on `quoteops-agent`, `quoteops-api`, `quoteops-onboard`, and `quoteops-web` only. PostgreSQL, Redis, Caddy, and cloudflared remain native/multiarch. Assert all four rendered application services use `linux/amd64` in the Mac smoke fixture.

Replace every Compose image with its required release-env value: `QUOTEOPS_AGENT_IMAGE`, `QUOTEOPS_API_IMAGE` (also onboarding), `QUOTEOPS_WEB_IMAGE`, `QUOTEOPS_POSTGRES_IMAGE`, `QUOTEOPS_REDIS_IMAGE`, `QUOTEOPS_CADDY_IMAGE`, and `QUOTEOPS_CLOUDFLARED_IMAGE`. No service may fall back to a tag or registry/version concatenation.

- [ ] **Step 8: Add the operator CLI dispatcher**

Create `deploy/appliance/quoteops.sh` with exact routing:

```bash
case "${1:-}" in
  status)   exec "$SCRIPT_DIR/verify-install.sh" --summary ;;
  doctor)   exec "$SCRIPT_DIR/verify-install.sh" --verbose ;;
  onboard)  shift; exec docker compose --env-file "$QUOTEOPS_HOME/.env" \
               --env-file "$QUOTEOPS_HOME/current/release.env" \
               -f "$QUOTEOPS_HOME/current/docker-compose.yml" \
               --profile onboarding run --rm quoteops-onboard "$@" ;;
  update)   shift; exec "$SCRIPT_DIR/upgrade.sh" "$@" ;;
  rollback) shift; exec "$SCRIPT_DIR/upgrade.sh" --rollback "$@" ;;
  backup)   shift; exec "$SCRIPT_DIR/backup.sh" \
               --output "$QUOTEOPS_HOME/backups" "$@" ;;
  restore)  shift
            if [[ $# -eq 1 && "$1" != --* ]]; then set -- --backup "$1"; fi
            exec "$SCRIPT_DIR/restore.sh" "$@" ;;
  logs)     shift; exec docker compose --env-file "$QUOTEOPS_HOME/.env" \
               --env-file "$QUOTEOPS_HOME/current/release.env" \
               -f "$QUOTEOPS_HOME/current/docker-compose.yml" logs "$@" ;;
  *) echo "Usage: quoteops status|doctor|onboard|update|rollback|backup|restore|logs" >&2; exit 2 ;;
esac
```

Resolve `SCRIPT_DIR` from the physical path of the release-local script, resolve `QUOTEOPS_HOME` to `/opt/quoteops-v1` by default, and reject `/`, a home directory, or a symlink escaping that root. Require Docker Compose `2.24.0` or newer for long `env_file` syntax and multiple `--env-file` arguments.

- [ ] **Step 9: Run bootstrap/layout verification**

Run:

```bash
npx vitest run apps/control-plane-api/tests/control-plane-api.test.ts
bash deploy/appliance/tests/smoke.sh
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add deploy/appliance/bootstrap.sh deploy/appliance/quoteops.sh deploy/appliance/docker-compose.yml deploy/appliance/install.sh deploy/appliance/tests/smoke.sh apps/control-plane-api/src/installerScript.ts apps/control-plane-api/src/index.ts apps/control-plane-api/tests/control-plane-api.test.ts
git commit -m "feat(appliance): add one-command Ubuntu bootstrap"
```

---

### Task 4: Make Cloudflare Tunnel and Access a Production Gate

**Files:**
- Create: `deploy/appliance/docker-compose.direct.yml`
- Create: `deploy/appliance/verify-install.sh`
- Modify: `deploy/appliance/docker-compose.yml`
- Modify: `deploy/appliance/Caddyfile`
- Modify: `deploy/appliance/install.sh`
- Modify: `deploy/appliance/tests/smoke.sh`
- Modify: `deploy/appliance/SECRETS.md`

**Interfaces:**
- Consumes: pinned `images.cloudflared` from Task 1.
- Produces: Compose profile `tunnel`.
- Consumes secret: `TUNNEL_TOKEN` from dedicated `secrets/cloudflare.env`.
- Consumes safe configuration: `QUOTEOPS_PUBLIC_HOSTNAME`.
- Produces metrics at `http://cloudflared:2000/metrics` on the internal Compose network.
- Produces direct/local override bound only to `127.0.0.1`.

- [ ] **Step 1: Write the failing production-Compose checks**

Extend `deploy/appliance/tests/smoke.sh` to render production Compose with a dummy secret file and assert:

```bash
rendered="$(docker compose \
  --env-file "$TEST_HOME/.env" \
  --env-file "$TEST_HOME/current/release.env" \
  -f deploy/appliance/docker-compose.yml config)"

grep -q 'cloudflare/cloudflared:2026.7.3@sha256:e39ee8da81ad5e05d77f38d2f51c60ca51bf2a8450ac3abab50c17fdb91d91bf' <<<"$rendered"
grep -q 'TUNNEL_METRICS: 0.0.0.0:2000' <<<"$rendered"
! grep -qE 'published: "(80|443)"' <<<"$rendered"
! grep -q 'TUNNEL_TOKEN:' <<<"$rendered"
cloudflared_block="$(sed -n '/^  cloudflared:/,/^  [a-zA-Z0-9_-][a-zA-Z0-9_-]*:/p' <<<"$rendered")"
! grep -qE 'OPENROUTER|GEMINI|TMS_API_KEY|RESEND|SAKBE' <<<"$cloudflared_block"
```

The fixture must create a complete digest-pinned `current/release.env`; do not copy image references into shared `.env`. Render the direct override with the same two env files and assert that it binds only `127.0.0.1`, never `0.0.0.0`.

- [ ] **Step 2: Run appliance smoke to verify RED**

Run:

```bash
bash deploy/appliance/tests/smoke.sh
```

Expected: FAIL because `cloudflared` and the direct override are absent and Caddy still publishes 80/443.

- [ ] **Step 3: Add the mandatory tunnel profile**

Add this service to `deploy/appliance/docker-compose.yml`:

```yaml
  cloudflared:
    profiles: ["tunnel"]
    image: ${QUOTEOPS_CLOUDFLARED_IMAGE:?QUOTEOPS_CLOUDFLARED_IMAGE is required}
    restart: unless-stopped
    env_file:
      - path: ${QUOTEOPS_CLOUDFLARE_ENV_FILE:-/opt/quoteops-v1/secrets/cloudflare.env}
        required: true
    environment:
      TUNNEL_METRICS: 0.0.0.0:2000
    command: ["tunnel", "--no-autoupdate", "run"]
    depends_on:
      caddy:
        condition: service_healthy
    expose:
      - "2000"
    networks:
      - quoteops_internal
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"
```

Cloudflare’s remotely managed tunnel reads `TUNNEL_TOKEN` from its dedicated env file. Never interpolate the token into `command`, Compose labels, the main `.env`, or `client.env`. `QUOTEOPS_CLOUDFLARED_IMAGE` comes only from the release-local, checksum-verified `release.env`.

- [ ] **Step 4: Remove public host ports from production**

Replace Caddy’s production `ports` with internal `expose: ["80"]`. Keep `QUOTEOPS_SITE_ADDRESS=:80` because TLS terminates at Cloudflare and the remote tunnel route targets `http://caddy:80`.

Create `deploy/appliance/docker-compose.direct.yml`:

```yaml
services:
  caddy:
    ports:
      - "127.0.0.1:${QUOTEOPS_HTTP_PORT:-8080}:80"
```

This override is for local debugging only and must not be included in the generated production command.

- [ ] **Step 5: Add a fail-closed tunnel verifier**

Create `deploy/appliance/verify-install.sh` with these checks and exit codes:

```text
10  core Compose service is not running
11  internal /api/health failed
12  cloudflared metrics endpoint is unavailable
13  cloudflared_tunnel_ha_connections is zero
14  public hostname does not resolve or connect
15  public hostname is not protected by Cloudflare Access
16  running product version differs from QUOTEOPS_VERSION
17  /api/setup-state still contains required steps
18  authenticated public origin does not match this installation/version
```

Fetch metrics from the host through the existing Caddy container on the internal network:

```bash
docker compose \
  --env-file "$QUOTEOPS_HOME/.env" \
  --env-file "$QUOTEOPS_HOME/current/release.env" \
  -f "$QUOTEOPS_HOME/current/docker-compose.yml" \
  exec -T caddy wget -qO- http://cloudflared:2000/metrics
```

Parse `cloudflared_tunnel_ha_connections` and require a numeric value greater than zero. Give each metrics/public request a three-second connect timeout and a five-second total timeout. A timeout maps to `unreachable`; add a never-resolving probe test so `/api/setup-state` cannot hang.

Probe the known `/api/health` path anonymously. A redirect counts as Access only when `Server: cloudflare`, a `CF-Ray` header, and a `Location` under `cloudflareaccess.com/cdn-cgi/access/login/` are all present; a `401` or `403` also requires Cloudflare response evidence. A public `200` is a security failure.

Then build a temporary curl config from `secrets/cloudflare-access-validation.env`, call public `/api/health` and `/api/setup-state` through Access Service Auth, and require the exact release version plus stored client/installation IDs. Do not accept a generic `200`. On success, atomically write the safe matching `settings/cloudflare-public-validation.json`, delete the temporary curl config and ephemeral Access env file, and continue. On failure, retain the `0600` Access env only for `--resume-guided` and return exit `18`. Add wrong-origin, wrong-version, wrong-installation, response-loss retry, and no-secret-in-receipt tests.

The script must print only:

```json
{
  "status": "ready|pending|failed",
  "version": "v0.2.0",
  "public_hostname": "quote.client.example",
  "checks": {
    "core": "ok",
    "tunnel_connections": "ok",
    "cloudflare_access": "ok",
    "authenticated_origin": "ok",
    "setup": "pending"
  }
}
```

It must never print response bodies, request headers, environment dumps, or tokens.

- [ ] **Step 6: Require Cloudflare inputs in guided mode**

After the child onboarding container exits, `install.sh` must read and validate `settings/cloudflare.json`, check only the presence of `TUNNEL_TOKEN` in `secrets/cloudflare.env`, and require `secrets/cloudflare-access-validation.env` until final verification succeeds; it must not expect the parent shell environment to change. If that temporary file is absent on `--resume-guided`, re-run only the Cloudflare credential prompt before verification. Validate the hostname with:

```bash
[[ "$QUOTEOPS_PUBLIC_HOSTNAME" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] ||
  die "public hostname is invalid"
```

Write the hostname to the non-secret settings state and keep the tunnel token only in `secrets/cloudflare.env`.

- [ ] **Step 7: Document the customer-owned Cloudflare prerequisite**

In `deploy/appliance/SECRETS.md`, state that the client must pre-create:

1. a remotely managed named tunnel;
2. a public hostname routed to `http://caddy:80`;
3. a Cloudflare Access application protecting the hostname;
4. an Access policy allowing only the client’s approved users/domain;
5. an Access Service Auth token and policy that explicitly includes that token for the acceptance request;
6. the named-tunnel token, Service Auth client ID, and Service Auth client secret to paste into local onboarding.

Explain that the Service Auth values are transient: QuoteOps deletes them after authenticated-origin verification, never includes them in backup/evidence, and requests them again if a resumed verification has no local temporary file. Do not request a Cloudflare account API token; automatic account/zone mutation is outside this plan.

- [ ] **Step 8: Run Compose and shell checks**

Run:

```bash
bash deploy/appliance/tests/smoke.sh
bash -n deploy/appliance/verify-install.sh
```

The smoke test must create its complete dummy env and tunnel-token inputs under its own `mktemp -d` root, render both production and direct Compose variants there, and remove the root through its exit trap. Do not commit a secret-like fixture env.

Expected: PASS; production has no published ports, and the direct override is loopback-only.

- [ ] **Step 9: Commit**

```bash
git add deploy/appliance/docker-compose.yml deploy/appliance/docker-compose.direct.yml deploy/appliance/Caddyfile deploy/appliance/install.sh deploy/appliance/verify-install.sh deploy/appliance/tests/smoke.sh deploy/appliance/SECRETS.md
git commit -m "feat(appliance): require Cloudflare tunnel exposure"
```

---

### Task 5: Make Guided Onboarding Resumable and Validate the AI Key First

**Files:**
- Create: `apps/api/src/onboard/onboardingFlow.ts`
- Create: `apps/api/src/onboard/aiProviderStep.ts`
- Create: `apps/api/src/onboard/applianceSecretsStep.ts`
- Create: `apps/api/src/onboard/cloudflareStep.ts`
- Create: `apps/api/tests/onboarding-flow.test.ts`
- Modify: `apps/control-plane/src/installPack.ts`
- Modify: `apps/control-plane/tests/install-pack-install.test.ts`
- Modify: `apps/api/src/onboard/cli.ts`
- Modify: `apps/api/src/onboard/onboardConfig.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/tests/api.test.ts`
- Modify: `apps/api/tests/onboard.test.ts`
- Modify: `deploy/appliance/entrypoint.sh`

**Interfaces:**
- Produces: `OnboardingIo`, `OnboardingPhaseId`, `OnboardingContext`, `OnboardingAnswers`, `OnboardingResult`, and `runOnboarding`.
- Produces: `validateAiProviderCredential` and `configureAiProvider`.
- Produces: `configureCloudflareTunnel`.
- Persists non-secret progress at `/opt/quoteops-v1/settings/onboarding-state.json`.
- Consumed by: Tasks 7 and 9.

- [ ] **Step 1: Write the failing ordered-flow test**

Create `apps/api/tests/onboarding-flow.test.ts` with a fake prompt adapter and phase functions:

```ts
const calls: string[] = [];
const result = await runOnboarding({
  phases: [
    phase("ai_provider", calls),
    phase("cloudflare", calls),
    phase("appliance_secrets", calls),
    phase("tms", calls)
  ],
  context: testOnboardingContext(),
  selection: { mode: "all" }
});

expect(calls).toEqual([
  "ai_provider",
  "cloudflare",
  "appliance_secrets",
  "tms"
]);
expect(result.pending_phases).toEqual([]);
```

Add a resume case where `ai_provider.isComplete` and `cloudflare.isComplete` derive true from current config/secret files and assert they are not rerun. Add a stale-state case where the audit file says `tms` completed but its probe receipt is missing; assert `tms.run` executes again. Add selection cases proving `through: knowledge` returns no pending `test_rfq`, `only: test_rfq` refuses an incomplete earlier prerequisite, and unknown/conflicting CLI selectors return exit `2`.

- [ ] **Step 2: Run the flow test to verify RED**

Run:

```bash
npx vitest run apps/api/tests/onboarding-flow.test.ts
```

Expected: FAIL because `runOnboarding` does not exist.

- [ ] **Step 3: Define the resumable flow engine**

Create `apps/api/src/onboard/onboardingFlow.ts`:

```ts
export type OnboardingPhaseId =
  | "ai_provider"
  | "license_activation"
  | "cloudflare"
  | "appliance_secrets"
  | "tms"
  | "units"
  | "authorization"
  | "pricing"
  | "knowledge"
  | "test_rfq";

export type OnboardingIo = {
  ask(prompt: string, initial?: string): Promise<string>;
  askMasked(prompt: string): Promise<string>;
  confirm(prompt: string): Promise<boolean>;
  select<T extends string>(
    prompt: string,
    options: Array<{ value: T; label: string }>
  ): Promise<T>;
  info(message: string): void;
  warn(message: string): void;
};

export type OnboardingContext = {
  io: OnboardingIo;
  env: NodeJS.ProcessEnv;
  paths: OnboardPaths;
  guided: boolean;
  answers: OnboardingAnswers | null;
  fetch: typeof fetch;
  stateStore: OnboardingStateStore;
};

export type OnboardPaths = {
  apiBaseUrl: string;
  agentConfigFile: string;
  clientSecretsFile: string;
  cloudflareSecretsFile: string;
  aiValidationReceiptFile: string;
  mailboxProbeReceiptFile: string;
  knowledgeReceiptFile: string;
  settingsDir: string;
  onboardingStateFile: string;
  tmsAdapterConfigFile: string;
  tmsProbeFile: string;
  testRfqReceiptFile: string;
};

export type SecretFileRef = {
  file: string;
};

export type OnboardingFileRef = {
  file: string;
};

export type OnboardingAnswers = {
  schema_version: 1;
  ai_provider?: {
    provider: "openrouter" | "gemini";
    api_key: SecretFileRef;
  };
  cloudflare?: {
    public_hostname: string;
    tunnel_token: SecretFileRef;
    access_client_id: SecretFileRef;
    access_client_secret: SecretFileRef;
  };
  activation?: {
    authorized_email: string;
  };
  tms?: {
    mode: "quoteops-tms-http-v1";
    base_url: string;
    api_key: SecretFileRef;
    sample_query: HistoricalSearchQuery;
  };
  mailbox?:
    | {
        provider: "resend";
        api_key: SecretFileRef;
        intake_address: string;
        from_address: string;
      }
    | {
        provider: "imap";
        user: string;
        password: SecretFileRef;
        host: string;
        port: number;
      };
  sakbe?: {
    api_key: SecretFileRef;
  };
  embeddings?:
    | {
        provider: "gemini";
        model: string;
        api_key: SecretFileRef;
      }
    | {
        provider: "openai_compatible";
        model: string;
        base_url: string;
        api_key: SecretFileRef;
      };
  knowledge?: {
    sources: OnboardingFileRef[];
    consent_external_embedding_transfer: true;
  };
  accept_generated_profiles?: true;
  accept_default_authorization?: true;
  accept_sample_prices?: true;
};

export type OnboardingPhase = {
  id: OnboardingPhaseId;
  isComplete(context: OnboardingContext): Promise<boolean>;
  run(context: OnboardingContext): Promise<void>;
};

export type OnboardingPhaseSelection =
  | { mode: "all" }
  | { mode: "through"; phase: OnboardingPhaseId }
  | { mode: "only"; phase: OnboardingPhaseId };

export type RunOnboardingInput = {
  phases: OnboardingPhase[];
  context: OnboardingContext;
  selection: OnboardingPhaseSelection;
};

export type OnboardingAuditState = {
  schema_version: 1;
  observed_complete: Array<{
    phase: OnboardingPhaseId;
    observed_at: string;
  }>;
};

export type OnboardingStateStore = {
  load(): Promise<OnboardingAuditState>;
  save(state: OnboardingAuditState): Promise<void>;
};

export type OnboardingResult = {
  selected_phases: OnboardingPhaseId[];
  completed_phases: OnboardingPhaseId[];
  pending_phases: OnboardingPhaseId[];
  public_url: string | null;
};
```

`runOnboarding(input: RunOnboardingInput)` must call every selected phase’s `isComplete(context)` against current files, license, live receipts, and provider readiness. `through` selects the ordered prefix ending at the requested phase; `only` first revalidates every earlier prerequisite and rejects with `onboarding_prerequisite_incomplete` before running the target if any is missing. `completed_phases`, `pending_phases`, and the process exit code apply only to `selected_phases`, so `through: knowledge` succeeds even though `test_rfq` is intentionally deferred until after restart. Reject an unknown phase or conflicting CLI selectors with exit `2`.

The persisted audit state is never authority for skipping a phase. Atomically record observations after each success, stop on the first selected-phase failure, and preserve earlier audit entries. The state file contains phase IDs and timestamps only—never values or secret names.

Parse `--answers-file` through a strict Zod equivalent of `OnboardingAnswers`. Resolve every secret reference only from a regular `0600` file owned by the invoking user or root, reject symlinks and paths outside the acceptance root in test mode, and never place the loaded value back into the parsed answers object.

Route every prompted or file-backed credential through one `readSingleLineSecret` validator before an env merge: maximum 16 KiB, valid UTF-8, non-empty, no NUL/CR/control characters, remove at most one terminal LF, reject any remaining LF, and reject leading/trailing whitespace. Serialize through one allowlisted dotenv writer rather than string concatenation. Its focused tests must round-trip values containing `=`, `$`, `#`, spaces, quotes, and backslashes through the actual Compose env-file parser, and must reject `token\nEVIL_KEY=value` without modifying either secret file. Never log the rejected bytes.

- [ ] **Step 4: Write failing AI validation tests**

Add cases to `apps/api/tests/onboarding-flow.test.ts`:

```ts
it("does not persist a rejected OpenRouter key", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
  await expect(
    configureAiProvider(openRouterInput("bad-key"), testContext({ fetch }))
  ).rejects.toMatchObject({ code: "ai_key_rejected" });
  expect(await readSecrets()).not.toContain("bad-key");
});

it("writes a valid key and matching agent config atomically", async () => {
  const fetch = vi.fn().mockResolvedValue(
    Response.json({ choices: [{ message: { content: "ok" } }] })
  );
  await configureAiProvider(openRouterInput("valid-key"), testContext({ fetch }));
  expect(await mode(secretsPath)).toBe(0o600);
  expect(await readAgentConfig()).toMatchObject({
    model: {
      provider: "openrouter",
      model_name: "openai/gpt-4o-mini",
      api_key_env: "OPENROUTER_API_KEY"
    }
  });
});
```

Add the equivalent Gemini success and 401 cases.

- [ ] **Step 5: Run AI tests to verify RED**

Run:

```bash
npx vitest run apps/api/tests/onboarding-flow.test.ts apps/api/tests/onboard.test.ts
```

Expected: FAIL because current `createCopilot` converts provider failures into static text and writes config independently.

- [ ] **Step 6: Implement fail-closed AI setup**

Create `apps/api/src/onboard/aiProviderStep.ts` with:

```ts
export type OnboardingAiConfig =
  | {
      input_provider: "openrouter";
      provider: "openrouter";
      model_name: "openai/gpt-4o-mini";
      api_key_env: "OPENROUTER_API_KEY";
    }
  | {
      input_provider: "gemini";
      provider: "gemini_sdk";
      model_name: "gemini-2.5-flash";
      api_key_env: "GEMINI_API_KEY";
    };

export type AiProviderValidationReceipt = {
  schema_version: 1;
  input_provider: "openrouter" | "gemini";
  runtime_provider: "openrouter" | "gemini_sdk";
  model_name: string;
  agent_config_sha256: string;
  credential_revision: number;
  validated_at: string;
  live_request: true;
  fallback: false;
};
```

Map the user-facing `gemini` choice to the runtime’s existing `gemini_sdk` discriminator. Do not write `provider: gemini`, which the current agent config rejects. These model slugs are the validated v0.2.0 defaults; provider validation must also distinguish `model_not_available` from an invalid API key.

Reference the provider-owned model pages when implementing the validation fixtures: [Gemini 2.5 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash) and [OpenRouter GPT-4o mini](https://openrouter.ai/openai/gpt-4o-mini).

`validateAiProviderCredential` must send one minimal provider request with an injected `fetch`, require a valid provider-specific response, and return structured safe errors:

```text
ai_key_missing
ai_key_rejected
ai_provider_unreachable
ai_provider_invalid_response
model_not_available
```

Use `AbortSignal.timeout(10_000)` and map timeout/network failure to `ai_provider_unreachable`. Add a never-resolving fetch case and assert no secret/config write occurs.

Only after validation succeeds:

1. write the selected key to a temporary `0600` file;
2. atomically merge it into `client.env`;
3. atomically update `connectors/agent/agent-config.yaml`;
4. increment a non-secret AI credential revision;
5. atomically write `settings/ai-provider-validation.json` with the safe receipt above;
6. create the onboarding copilot.

These separate files cannot be one filesystem transaction. Treat the receipt as the commit marker: `ai_provider.isComplete` requires matching config hash, credential revision, exact env-key presence, and a fresh live provider validation using the already stored key. It may skip prompts but never skips the live request. A crash between renames leaves the phase incomplete; on resume, reconcile the supported provider from the config/single present provider key, revalidate, and finish the missing writes. If the key was revoked, return `ai_key_rejected` and request replacement without deleting unrelated settings. Add crash-after-each-rename and revoked-key-on-resume tests; no result or log may contain the key.

Replace the inaccurate UI text “se guarda cifrada” with “se guarda localmente en un archivo accesible sólo por root (`0600`)”.

Create `apps/api/src/onboard/applianceSecretsStep.ts` to inspect and atomically update the generated `agent-config.yaml`, prompting only for enabled providers. Apply these exact mappings:

- Resend: write `RESEND_API_KEY`, `MAILBOX_USER=intake_address`, and `MAILBOX_FROM=from_address`; generate mailbox config `{provider: "resend", auth: "password", processed_mailbox: null, poll_interval_ms: 60000, imap_host: null, imap_port: null}`.
- IMAP: write `MAILBOX_USER` and `MAILBOX_PASSWORD`; generate mailbox config with `{provider: "imap", auth: "password", imap_host: host, imap_port: port}`.
- SAKBÉ: write `INEGI_SAKBE_KEY`.
- Embeddings: write `QUOTEOPS_EMBEDDING_API_KEY` and generate the matching `embeddings` block with provider/model, `api_key_env: "QUOTEOPS_EMBEDDING_API_KEY"`, and the configured base URL or `null` for Gemini.

Persist only the exact env keys referenced by the active config. Add tests proving that a Resend configuration does not request IMAP values, an IMAP configuration does not request Resend values, knowledge cannot complete without a valid embeddings block/key, and no provider credential is marked complete merely because an unrelated env key exists.

Probe the enabled mailbox before `appliance_secrets` can complete and write a safe `settings/mailbox-probe.json` receipt bound to the mailbox-config hash and credential revision. For Resend, POST one non-sensitive “QuoteOps onboarding validation” message from the configured `from_address` to the configured `intake_address`, use a deterministic installation/config `Idempotency-Key`, require the documented success body, and never store the API response body or message content. This supports send-only keys and makes response-loss retries safe; follow Resend’s official [authentication](https://resend.com/docs/api-reference/introduction), [send-email](https://resend.com/docs/api-reference/emails/send-email), and [idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys) contracts. For IMAP, connect with TLS, authenticate, select the configured mailbox read-only, and logout without fetching message bodies. Bound both probes to 10 seconds and map only safe provider/code/status metadata.

If mailbox integration is enabled in the generated manifest, missing/invalid/stale probe receipt keeps `connect_mailbox` pending; environment-key presence alone is never enough. A disabled mailbox is explicitly optional and must be absent from agent config rather than silently “ready.” Add bad-key, timeout, response-loss retry, IMAP-auth failure, config-rotation, and no-secret-in-receipt tests.

Make knowledge ingestion an explicit source-and-consent step. Add `connectors/knowledge/README.md` to the non-secret install pack with staging instructions. Interactive operators may stage files under `$QUOTEOPS_HOME/connectors/knowledge/`; automation supplies `knowledge.sources` from the read-only input mount. Accept at most 20 regular non-symlink `.md`, `.txt`, or `.json` files, each at most 5 MiB, copy them atomically with mode `0600` into the stable knowledge directory using generated collision-safe names, and reject traversal or unsupported files. Change `listKnowledgeFiles` to exclude the exact shipped `README.md`; it is never an ingestible source.

Before sending content to Gemini or an OpenAI-compatible embeddings endpoint, display and record the explicit `consent_external_embedding_transfer: true` acknowledgement: document text is sent to that configured provider to create embeddings, while the resulting vectors and QuoteOps database remain local. Remove any claim that source chunks never leave the appliance. Never log document text or provider error bodies.

Change `knowledgePhase` to fail closed. It must call `/api/knowledge/ingest`, require `document_count > 0` and the sum of returned `chunk_count > 0`, then atomically store only source hashes, provider-config hash, counts, and consent timestamp in `settings/knowledge-ingest.json`. A warning, HTTP error, or zero-document/zero-chunk response remains pending. Change `hasKnowledgeBase` so merely staged files are not ready; require stored vector chunks plus a matching safe receipt. Add fresh-install, zero-document, zero-chunk, provider-error, and successful-resume tests.

- [ ] **Step 7: Write failing Cloudflare-input tests**

Add:

```ts
await expect(
  configureCloudflareTunnel(
    {
      public_hostname: "",
      tunnel_token: "test-tunnel-token",
      access_client_id: "test.access",
      access_client_secret: "test-access-secret"
    },
    testContext()
  )
).rejects.toMatchObject({ code: "cloudflare_hostname_invalid" });

await configureCloudflareTunnel(
  {
    public_hostname: "quotes.client.example",
    tunnel_token: "test-tunnel-token",
    access_client_id: "test.access",
    access_client_secret: "test-access-secret"
  },
  testContext()
);
expect(await readCloudflareSecrets()).toContain("TUNNEL_TOKEN=");
expect(await readClientSecrets()).not.toContain("TUNNEL_TOKEN=");
expect(await mode(ephemeralAccessFile)).toBe(0o600);
expect(await readSettings()).toEqual({
  provider: "cloudflare",
  public_hostname: "quotes.client.example",
  origin_url: "http://caddy:80"
});
```

Assert no returned/logged object contains any of the three credential values.

- [ ] **Step 8: Implement Cloudflare configuration**

Create `apps/api/src/onboard/cloudflareStep.ts`:

```ts
export type CloudflareTunnelConfig = {
  provider: "cloudflare";
  public_hostname: string;
  origin_url: "http://caddy:80";
};
```

Validate a lowercase ASCII FQDN without scheme/path/port: total length at most 253, at least two labels, every label 1–63 characters with valid DNS edge characters, and no IP literal, `localhost`, `.local`, `.internal`, `.home`, or `.arpa`. Through injected DNS resolution, require at least one A/AAAA answer and reject any loopback, private, carrier-grade NAT, link-local, unique-local, multicast, unspecified, or reserved/documentation address. Re-run the same validation whenever `settings/cloudflare.json` is read and immediately before any public fetch; a stale or newly private answer is `cloudflare_hostname_unsafe`, not a network request.

Require non-empty tunnel and Access Service Auth credentials. Write `TUNNEL_TOKEN` only to dedicated `cloudflare.env`; write the Access client ID/secret only to `secrets/cloudflare-access-validation.env` at `0600`; write the safe config to `settings/cloudflare.json`; and return only the safe config. The final verifier consumes the ephemeral Access file, writes `settings/cloudflare-public-validation.json` with hostname, expected product version, client/installation IDs, timestamp, and `authenticated_origin_verified: true`, then deletes the ephemeral file. A failed/interrupted verification may retain it only for `--resume-guided`; backups/evidence must always exclude it, and resume must prompt again if it is missing. Add tests for IP literals, invalid/oversized labels, internal suffixes, public-looking names resolving privately, a valid public hostname, and no credential in any receipt/log. DNS errors must remain safe and must not disclose resolver details.

- [ ] **Step 9: Rewire the CLI without changing later business steps**

Change `apps/api/src/onboard/cli.ts` to call:

```ts
await runOnboarding({
  phases: [
    aiProviderPhase,
    cloudflarePhase,
    applianceSecretsPhase,
    tmsPhase,
    unitsPhase,
    authorizationPhase,
    pricingPhase,
    knowledgePhase
  ],
  context
});
```

Guided mode must require a valid AI key, Cloudflare inputs, and an embeddings configuration whenever the knowledge-base setup gate is enabled (it is enabled in the generated v0.2.0 pack). A standalone legacy invocation may use `--allow-static-guidance`; generated production installers must never pass that flag.

Keep `--sync-units`, `--map-tms`, and `--ingest`; add `--resume` as an alias for the full completion-aware flow, `--until PHASE` for `through`, `--only PHASE` for `only`, and `--answers-file` for the bounded noninteractive acceptance flow. Missing answers must return `onboarding_pending` with the exact phase name instead of silently skipping it. Task 8 inserts `licenseActivationPhase` immediately after `aiProviderPhase` and `testRfqPhase` after `knowledgePhase`; this task’s initial list stays buildable until those modules exist.

- [ ] **Step 10: Run focused onboarding tests**

Run:

```bash
npx vitest run apps/api/tests/onboarding-flow.test.ts apps/api/tests/onboard.test.ts
```

Expected: PASS; a rejected key is never persisted and resume skips prompts/writes for complete phases while still performing one live provider revalidation.

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/onboard/onboardingFlow.ts apps/api/src/onboard/aiProviderStep.ts apps/api/src/onboard/applianceSecretsStep.ts apps/api/src/onboard/cloudflareStep.ts apps/api/src/onboard/cli.ts apps/api/src/onboard/onboardConfig.ts apps/api/src/index.ts apps/api/tests/onboarding-flow.test.ts apps/api/tests/api.test.ts apps/api/tests/onboard.test.ts apps/control-plane/src/installPack.ts apps/control-plane/tests/install-pack-install.test.ts deploy/appliance/entrypoint.sh
git commit -m "feat(onboarding): add resumable AI-first setup"
```

---

### Task 6: Publish the Minimal Canonical TMS HTTP v1 Contract

**Files:**
- Create: `packages/contracts/src/tmsHttpV1.ts`
- Create: `docs/integrations/tms-http-v1.openapi.yaml`
- Create: `docs/integrations/tms-http-v1.md`
- Create: `tests/regression/tms-openapi-contract.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/connectors/src/tms/TmsAdapter.ts`
- Modify: `packages/connectors/src/tms/historicalAnalysis.ts`
- Modify: `packages/connectors/src/tms/HttpTmsAdapter.ts`
- Modify: `packages/connectors/tests/tms-adapter.test.ts`
- Modify: `deploy/appliance/mock-tms/server.mjs`
- Modify: `deploy/appliance/mock-tms/README.md`
- Modify: `tests/regression/mock-tms-http.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `TMS_HTTP_V1_CONTRACT`, `TMS_HTTP_V1_PATHS`, `tmsHttpV1HealthSchema`, `tmsHttpV1HistoricalSearchRequestSchema`, `historicalQuoteRecordSchema`, `tmsHttpV1HistoricalResponseSchema`, and `tmsHttpV1ErrorSchema`.
- Required customer endpoints:
  - `GET /quoteops/v1/health`
  - `POST /quoteops/v1/historical-quotes/search`
  - `GET /quoteops/v1/units`
  - `GET /quoteops/v1/unit-performance`
  - `GET /quoteops/v1/availability-zones`
  - `POST /quoteops/v1/quotes`
- Preserves: current aggregated `HistoricalAnalysis` response and legacy configurable paths.

- [ ] **Step 1: Write the failing contract-schema tests**

Add to `packages/connectors/tests/tms-adapter.test.ts`:

```ts
expect(TMS_HTTP_V1_CONTRACT).toBe("quoteops-tms-http-v1");
expect(TMS_HTTP_V1_PATHS).toEqual({
  health: "/quoteops/v1/health",
  historical_quotes: "/quoteops/v1/historical-quotes/search",
  units: "/quoteops/v1/units",
  unit_performance: "/quoteops/v1/unit-performance",
  availability_zones: "/quoteops/v1/availability-zones",
  write_quote: "/quoteops/v1/quotes"
});

expect(
  historicalQuoteRecordSchema.parse({
    origin_city: "Monterrey",
    origin_state: "Nuevo León",
    origin_country: "MX",
    destination_city: "Saltillo",
    destination_state: "Coahuila",
    destination_country: "MX",
    vehicle_profile_id: "DRY_VAN_53",
    rate_mxn: 18500,
    quoted_at: "2026-07-29T18:00:00.000Z"
  })
).toBeTruthy();
```

- [ ] **Step 2: Run the schema test to verify RED**

Run:

```bash
npx vitest run packages/connectors/tests/tms-adapter.test.ts
```

Expected: FAIL because TMS HTTP v1 does not exist.

- [ ] **Step 3: Define the canonical v1 source of truth**

Create `packages/contracts/src/tmsHttpV1.ts`:

```ts
import { z } from "zod";
import { locationSchema } from "./rfq.js";
import {
  timeWindowSchema,
  writeQuoteInputSchema,
  writeQuoteResultSchema
} from "./tms.js";
import {
  tmsCanonicalAvailabilityZoneSchema,
  tmsCanonicalPerformanceSchema,
  tmsCanonicalUnitSchema
} from "./tmsCanonical.js";

export const TMS_HTTP_V1_CONTRACT = "quoteops-tms-http-v1" as const;

export const TMS_HTTP_V1_PATHS = {
  health: "/quoteops/v1/health",
  historical_quotes: "/quoteops/v1/historical-quotes/search",
  units: "/quoteops/v1/units",
  unit_performance: "/quoteops/v1/unit-performance",
  availability_zones: "/quoteops/v1/availability-zones",
  write_quote: "/quoteops/v1/quotes"
} as const;

export const tmsHttpV1HistoricalSearchRequestSchema = z
  .object({
    request_id: z.string().min(1),
    origin: locationSchema,
    destination: locationSchema,
    vehicle_profile_id: z.string().min(1).nullable().optional(),
    equipment_request: z.string().min(1).nullable().optional(),
    customer_id: z.string().min(1).nullable().optional(),
    customer_type: z.string().min(1).nullable().optional(),
    cargo: z
      .object({
        commodity: z.string().min(1).nullable().optional(),
        commodity_category: z.string().min(1).nullable().optional(),
        sector: z.string().min(1).nullable().optional(),
        weight_kg: z.number().finite().nonnegative().nullable().optional(),
        hazmat: z.boolean().nullable().optional(),
        temperature_controlled: z.boolean().nullable().optional()
      })
      .strict()
      .optional(),
    service_type: z.string().min(1).nullable().optional(),
    time_window: timeWindowSchema,
    max_results: z.number().int().min(1).max(500).optional()
  })
  .strict();

export type TmsHttpV1HistoricalSearchRequest = z.infer<
  typeof tmsHttpV1HistoricalSearchRequestSchema
>;

export const historicalQuoteRecordSchema = z
  .object({
    quote_id: z.string().min(1).nullable().optional(),
    rfq_id: z.string().min(1).nullable().optional(),
    lane_id: z.string().min(1).nullable().optional(),
    customer_id: z.string().min(1).nullable().optional(),
    origin_city: z.string().min(1),
    origin_state: z.string().min(1),
    origin_country: z.string().length(2),
    destination_city: z.string().min(1),
    destination_state: z.string().min(1),
    destination_country: z.string().length(2),
    vehicle_profile_id: z.string().min(1),
    equipment_request: z.string().min(1).nullable().optional(),
    commodity: z.string().min(1).nullable().optional(),
    commodity_category: z.string().min(1).nullable().optional(),
    sector: z.string().min(1).nullable().optional(),
    weight_kg: z.number().finite().nonnegative().nullable().optional(),
    rate_mxn: z.number().finite().nonnegative(),
    direct_cost_mxn: z.number().finite().nonnegative().nullable().optional(),
    margin_pct: z.number().finite().nullable().optional(),
    quoted_at: z.string().datetime({ offset: true }),
    service_type: z.string().min(1).nullable().optional(),
    status: z.string().min(1).nullable().optional()
  })
  .strict();

export const tmsHttpV1HealthSchema = z
  .object({
    ok: z.literal(true),
    status: z.literal("ok"),
    contract_version: z.literal(TMS_HTTP_V1_CONTRACT),
    capabilities: z
      .object({
        historical_quotes: z.literal(true),
        units: z.literal(true),
        unit_performance: z.literal(true),
        availability_zones: z.literal(true),
        write_quote: z.literal(true)
      })
      .strict()
  })
  .strict();

export const tmsHttpV1HistoricalResponseSchema = z.array(
  historicalQuoteRecordSchema
);

export const tmsHttpV1UnitResponseSchema = z.array(tmsCanonicalUnitSchema);
export const tmsHttpV1PerformanceResponseSchema = z.array(tmsCanonicalPerformanceSchema);
export const tmsHttpV1ZoneResponseSchema = z.array(tmsCanonicalAvailabilityZoneSchema);
export const tmsHttpV1WriteQuoteRequestSchema = writeQuoteInputSchema;
export const tmsHttpV1WriteQuoteResponseSchema = writeQuoteResultSchema;

export const tmsHttpV1ErrorSchema = z
  .object({
    error: z.string().min(1),
    message: z.string().min(1),
    request_id: z.string().min(1).optional()
  })
  .strict();
```

Export the module with `export * from "./tmsHttpV1.js";` in `packages/contracts/src/index.ts`. In `packages/connectors/src/tms/TmsAdapter.ts`, replace the handwritten `HistoricalSearchQuery` interface with a type alias to `TmsHttpV1HistoricalSearchRequest`, so file, SQL, HTTP, OpenAPI, and onboarding cannot drift.

- [ ] **Step 4: Make HTTP historical rows use the existing local analyzer**

Modify `HttpTmsAdapter.searchHistoricalQuotes` to parse the value returned by the existing `request()` helper:

```ts
const historicalHttpResponseSchema = z.union([
  historicalAnalysisSchema,
  tmsHttpV1HistoricalResponseSchema
]);
```

Import the TMS v1 response schema from `@quoteops/contracts` and `analyzeHistoricalQuotes` plus `coerceHistoricalQuoteRecord` from `./historicalAnalysis.js`. The canonical v1 success body is an array. `HttpTmsAdapter.request()` already applies `unwrapData(body)`, so legacy `{ data: [...] }` envelopes remain compatible without entering the public v1 schema and must not be unwrapped a second time. Narrow `HistoricalAnalysis` explicitly before calling `.map()`:

```ts
const parsed = await this.post(
  this.endpoints.searchHistoricalQuotes,
  [],
  query,
  historicalHttpResponseSchema
);
const legacyAnalysis = historicalAnalysisSchema.safeParse(parsed);
if (legacyAnalysis.success) {
  return legacyAnalysis.data;
}

const records = parsed
  .map((row) => coerceHistoricalQuoteRecord(row))
  .filter((row): row is NonNullable<typeof row> => row !== null);

return analyzeHistoricalQuotes(records, query);
```

Catch the Zod failure at the HTTP-adapter boundary and convert it to the connector’s safe error type:

```ts
if (error instanceof z.ZodError) {
  throw new TmsAdapterError("TMS response failed schema validation", {
    code: "invalid_response_schema",
    details: {
      issues: error.issues.map(({ path, code, message }) => ({
        path,
        code,
        message
      }))
    }
  });
}
```

Add `timeoutMs?: number` to `HttpTmsAdapterConfig`, validate it as a positive finite integer, and default it to `10_000`. Both `healthCheck()` and the shared `request()` method must pass `signal: AbortSignal.timeout(this.timeoutMs)` to `fetchFn`; therefore historical, units, performance, zones, quote writeback, and every legacy method share the same bound. Convert `TimeoutError`/`AbortError` from non-health calls to `TmsAdapterError` with code `request_timeout` and no URL, headers, body, or credential details. Health continues to return a safe failed health result.

Keep the current aggregated response behavior for existing customers.

- [ ] **Step 5: Add adapter compatibility tests**

In `packages/connectors/tests/tms-adapter.test.ts`, cover:

1. strict raw-array history → local analysis;
2. `{ data: [...] }` history → local analysis;
3. existing `HistoricalAnalysis` response → unchanged;
4. malformed row → `TmsAdapterError` with safe schema details;
5. bearer header comes from `${TMS_API_KEY}`, never a literal config value;
6. a never-settling injected fetch times out for historical, units, performance, zones, and quote writeback, returning only `request_timeout`.

- [ ] **Step 6: Run connector tests**

Run:

```bash
npx vitest run packages/connectors/tests/tms-adapter.test.ts
```

Expected: PASS.

- [ ] **Step 7: Write the OpenAPI contract with the exact six endpoints**

Create `docs/integrations/tms-http-v1.openapi.yaml` as OpenAPI `3.1.0` with:

```yaml
info:
  title: QuoteOps TMS HTTP Contract
  version: 1.0.0
security:
  - bearerAuth: []
paths:
  /quoteops/v1/health:
    get:
      operationId: health
  /quoteops/v1/historical-quotes/search:
    post:
      operationId: searchHistoricalQuotes
  /quoteops/v1/units:
    get:
      operationId: getUnits
  /quoteops/v1/unit-performance:
    get:
      operationId: getUnitPerformance
  /quoteops/v1/availability-zones:
    get:
      operationId: getAvailabilityZones
  /quoteops/v1/quotes:
    post:
      operationId: writeQuote
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
```

Use these exact component and operation bindings:

| Operation | Request schema | Success schema | Error statuses |
|---|---|---|---|
| `health` | none | `TmsHttpV1Health` | `401`, `500` |
| `searchHistoricalQuotes` | `TmsHttpV1HistoricalSearchRequest` | array of `HistoricalQuoteRecord` | `400`, `401`, `500` |
| `getUnits` | none | array of `TmsCanonicalUnit` | `401`, `500` |
| `getUnitPerformance` | none | array of `TmsCanonicalPerformance` | `401`, `500` |
| `getAvailabilityZones` | none | array of `TmsCanonicalAvailabilityZone` | `401`, `500` |
| `writeQuote` | `WriteQuoteInput` | `WriteQuoteResult` | `400`, `401`, `409`, `500` |

Define each component field-for-field from the strict Zod schema shown in Step 3, set `additionalProperties: false` on every object, and use `TmsHttpV1Error` for every error response. Use these non-secret examples and validate them in the drift test:

```yaml
examples:
  historical_search:
    value:
      request_id: MAC-E2E-PROBE
      origin: {city: Guadalajara, state: Jalisco, country: MX}
      destination: {city: Monterrey, state: Nuevo Leon, country: MX}
      vehicle_profile_id: T3S3_53_DRYVAN
      time_window: {from: "2026-01-01", to: "2026-12-31"}
      max_results: 20
  unit:
    value:
      unit_id: T3S3_53_DRYVAN
      current_lat: 20.6597
      current_lng: -103.3496
      status: Available
      next_destination_city: Monterrey
  performance:
    value:
      unit_type: T3S3_53_DRYVAN
      kpl_yield: 2.8
      real_cost_per_km: 8.5
  zone:
    value:
      zone_id: ZONA-GDL
      city: Guadalajara
      state: Jalisco
      country: MX
      available_units: 4
  quote_write:
    value:
      quote_id: QUOTE-MAC-E2E-001
      rfq_id: RFQ-2026-000001
      lane_id: RFQ-2026-000001-L01
      rate_mxn: 19850
      currency: MXN
      metadata: {}
```

`POST /quoteops/v1/quotes` documents `quote_id` as the idempotency key: repeating the same `quote_id` and body returns the same result; a conflicting body returns `409`.

- [ ] **Step 8: Add OpenAPI/runtime drift tests**

Run `npm install --save-dev zod-to-json-schema` and create `tests/regression/tms-openapi-contract.test.ts`. Parse the YAML, assert the six method/path pairs exactly match `TMS_HTTP_V1_PATHS`, and validate every example through its corresponding Zod schema.

For every request, success, health, and error component, convert the authoritative Zod schema with `zod-to-json-schema`, dereference its local definitions, normalize only semantically identical OpenAPI 3.1 representations, and deep-compare:

```text
type
properties and nested item schemas
required
additionalProperties
const/enum
minimum/maximum
minLength
format
nullable unions
```

Do not compare only path names or example acceptance. Add a negative corpus covering a missing required field, an extra field, wrong nullability, invalid date/date-time, reversed time window, conflicting health `ok/status`, and out-of-range `max_results`. Each invalid value must fail its Zod schema, while normalized component equality prevents the OpenAPI copy from accepting a different shape.

Run:

```bash
npx vitest run tests/regression/tms-openapi-contract.test.ts
```

Expected: PASS.

- [ ] **Step 9: Align the mock TMS**

Add `/quoteops/v1` routes to `deploy/appliance/mock-tms/server.mjs` and require the configured test Bearer token for every canonical route and inspection route. Keep legacy routes unchanged for existing tests.

Add a CLI-only `MOCK_TMS_TOKEN_FILE` interface: validate a regular non-symlink `0600` file owned by the process user, read it internally, and never print its path or value. Let `MOCK_TMS_HOST` select the listen address; Task 10 sets it to `127.0.0.1`, while existing Docker fixtures may retain their explicit internal-network bind.

The v1 historical route must project each liquidation instead of returning the legacy object directly:

```js
const toV1HistoricalQuote = (row) => ({
  quote_id: row.liquidation_id,
  origin_city: row.origin_city,
  origin_state: row.origin_state,
  origin_country: row.origin_country,
  destination_city: row.destination_city,
  destination_state: row.destination_state,
  destination_country: row.destination_country,
  vehicle_profile_id: row.vehicle_profile_id,
  equipment_request: row.equipment_request ?? null,
  commodity: row.commodity ?? null,
  commodity_category: row.commodity_category ?? null,
  sector: row.sector ?? null,
  weight_kg: row.weight_kg ?? null,
  rate_mxn: row.rate_mxn,
  direct_cost_mxn: row.direct_cost_mxn ?? null,
  margin_pct: row.margin_pct ?? null,
  quoted_at: `${row.quoted_at}T00:00:00.000Z`,
  service_type: row.service_type ?? null,
  status: row.status ?? null
});
```

Do not include legacy-only `liquidation_id` or `operator_cost_mxn`. Return a dedicated strict v1 health body with `ok`, `status`, `contract_version`, and `capabilities`; do not reuse the diagnostic-rich legacy health object.

Make `POST /quoteops/v1/quotes` idempotent by `quote_id`: parse first through `writeQuoteInputSchema`, recursively sort every object key—including nested `metadata`—while preserving array order, and compare that canonical JSON representation. The same ID and structurally equal validated body returns the original response without a second stored row; the same ID with a genuinely different canonical body returns `409 quote_id_conflict`. In `tests/regression/mock-tms-http.test.ts`, assert a retry with reordered top-level and metadata keys is identical, assert a changed `rate_mxn` conflicts, and assert authenticated `GET /quote-writebacks` remains length one. Also validate projected historical rows and v1 health through the Task 6 schemas.

Document the minimal customer implementation sequence in `docs/integrations/tms-http-v1.md`:

1. implement health and Bearer auth;
2. implement the three unit/context reads;
3. implement historical search;
4. implement idempotent quote writeback;
5. run the provided conformance probe;
6. provide the base URL and API key to the customer’s VM operator.

- [ ] **Step 10: Run the complete TMS contract set**

Run:

```bash
npx vitest run packages/connectors/tests/tms-adapter.test.ts tests/regression/mock-tms-http.test.ts tests/regression/tms-openapi-contract.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/contracts/src/tmsHttpV1.ts packages/contracts/src/index.ts packages/connectors/src/tms/TmsAdapter.ts packages/connectors/src/tms/historicalAnalysis.ts packages/connectors/src/tms/HttpTmsAdapter.ts packages/connectors/tests/tms-adapter.test.ts docs/integrations/tms-http-v1.openapi.yaml docs/integrations/tms-http-v1.md tests/regression/tms-openapi-contract.test.ts tests/regression/mock-tms-http.test.ts deploy/appliance/mock-tms/server.mjs deploy/appliance/mock-tms/README.md package.json package-lock.json
git commit -m "feat(tms): publish canonical HTTP v1 contract"
```

---

### Task 7: Generate TMS v1 Configuration and Probe the Client Endpoint

**Files:**
- Create: `apps/api/src/onboard/tmsProbe.ts`
- Create: `apps/api/tests/tmsProbe.test.ts`
- Modify: `packages/connectors/src/tms/TmsAdapterConfig.ts`
- Modify: `apps/api/src/onboard/onboardConfig.ts`
- Modify: `apps/api/src/onboard/cli.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/tests/onboard.test.ts`
- Modify: `apps/api/tests/api.test.ts`
- Modify: `apps/control-plane/src/onboarding/createClientManifest.ts`
- Modify: `apps/control-plane/src/onboarding/validateTms.ts`
- Modify: `apps/control-plane/src/installPack.ts`
- Modify: `apps/control-plane/tests/install-pack-install.test.ts`
- Modify: `apps/control-plane/tests/onboarding.test.ts`
- Modify: `deploy/appliance/docker-compose.yml`
- Modify: `deploy/appliance/tests/smoke.sh`
- Modify: `deploy/appliance/mock-tms/tms-adapter.http.yaml`

**Interfaces:**
- Consumes: TMS v1 schemas and paths from Task 6.
- Produces: `contract: "quoteops-tms-http-v1"` in HTTP adapter configuration.
- Produces: `probeTmsHttpV1(input): Promise<TmsHttpV1ProbeReceipt>`.
- Produces: `probeLegacyCustomHttp(input): Promise<LegacyCustomHttpProbeReceipt>` for already configured explicit-path adapters whose outputs are canonical.
- Persists: `/opt/quoteops-v1/settings/tms-probe.json`, containing no credential.
- Changes readiness: every HTTP adapter requires a matching discriminated live-probe receipt; legacy custom HTTP cannot become ready from mapping JSON alone.
- Ships: `connectors/tms-http-v1.openapi.yaml` and `connectors/tms-http-v1.md` inside every install pack.

- [ ] **Step 1: Write the failing canonical YAML test**

Add to `apps/api/tests/onboard.test.ts`:

```ts
const yaml = buildTmsAdapterYaml({
  provider: "http",
  contract: "quoteops-tms-http-v1",
  base_url_env: "TMS_HTTP_BASE_URL",
  api_key_env: "TMS_API_KEY"
});

expect(parseYaml(yaml)).toEqual({
  provider: "http",
  contract: "quoteops-tms-http-v1",
  base_url_env: "TMS_HTTP_BASE_URL",
  headers: {
    authorization: "Bearer ${TMS_API_KEY}"
  },
  health_endpoint_path: "/quoteops/v1/health",
  search_historical_quotes_endpoint_path:
    "/quoteops/v1/historical-quotes/search",
  get_units_endpoint_path: "/quoteops/v1/units",
  get_unit_performance_endpoint_path: "/quoteops/v1/unit-performance",
  get_availability_zones_endpoint_path:
    "/quoteops/v1/availability-zones",
  write_quote_endpoint_path: "/quoteops/v1/quotes"
});
expect(yaml).not.toContain("actual-api-key");
```

- [ ] **Step 2: Run the onboarding config test to verify RED**

Run:

```bash
npx vitest run apps/api/tests/onboard.test.ts
```

Expected: FAIL because the config has no `contract` or canonical profile.

- [ ] **Step 3: Add the optional contract discriminator**

Extend the HTTP Zod schema in `TmsAdapterConfig.ts`:

```ts
contract: z.literal("quoteops-tms-http-v1").optional()
```

Add a `buildTmsHttpV1AdapterYaml` branch that obtains every path from `TMS_HTTP_V1_PATHS`. Keep the existing explicit-path branch for custom REST TMS configurations.

- [ ] **Step 4: Write failing endpoint-probe tests**

Create `apps/api/tests/tmsProbe.test.ts` with one passing fixture and focused failures:

```ts
const receipt = await probeTmsHttpV1({
  adapter,
  resolvedBaseUrl: "https://tms.client.example",
  resolvedHeaders: { authorization: "Bearer test-token" },
  adapterConfigPath,
  credentialRevision: 1,
  receiptPath,
  sampleQuery,
  fetch,
  now: () => new Date("2026-07-29T18:00:00.000Z")
});

expect(receipt).toEqual({
  contract: "quoteops-tms-http-v1",
  adapter_config_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  credential_revision: 1,
  base_url_origin: "https://tms.client.example",
  validated_at: "2026-07-29T18:00:00.000Z",
  checks: {
    health: "ok",
    historical_quotes: "ok",
    units: "ok",
    unit_performance: "ok",
    availability_zones: "ok",
    write_quote_declared: "ok"
  }
});
```

Add separate cases for `401`, an invalid contract version, contradictory `{ ok: false, status: "ok" }`, malformed historical rows, empty units, unmatched performance profile IDs, unavailable zones, a health response that does not declare `write_quote`, and a never-settling request.

Add a legacy explicit-path fixture that calls `probeLegacyCustomHttp`, proves `adapter.healthCheck()` plus historical/unit/performance/zone canonical outputs, and yields `contract: "legacy-custom-http-canonical-output-v1"`. Add negative tests for a failed health check, missing configured write endpoint, malformed canonical output, a stale config hash, and a v1 receipt presented for a legacy config.

- [ ] **Step 5: Run probe tests to verify RED**

Run:

```bash
npx vitest run apps/api/tests/tmsProbe.test.ts
```

Expected: FAIL because `probeTmsHttpV1` does not exist.

- [ ] **Step 6: Implement the live, non-destructive probe**

Create `apps/api/src/onboard/tmsProbe.ts`:

```ts
type TmsProbeReceiptBase = {
  adapter_config_sha256: string;
  credential_revision: number;
  base_url_origin: string;
  validated_at: string;
};

export type TmsHttpV1ProbeReceipt = TmsProbeReceiptBase & {
  contract: "quoteops-tms-http-v1";
  checks: {
    health: "ok";
    historical_quotes: "ok";
    units: "ok";
    unit_performance: "ok";
    availability_zones: "ok";
    write_quote_declared: "ok";
  };
};

export type LegacyCustomHttpProbeReceipt = TmsProbeReceiptBase & {
  contract: "legacy-custom-http-canonical-output-v1";
  checks: {
    health: "ok";
    historical_quotes: "ok";
    units: "ok";
    unit_performance: "ok";
    availability_zones: "ok";
    write_quote_configured: "ok";
  };
};

export type TmsProbeReceipt =
  | TmsHttpV1ProbeReceipt
  | LegacyCustomHttpProbeReceipt;

export type TmsProbeInput = {
  adapter: TmsAdapter;
  resolvedBaseUrl: string;
  resolvedHeaders: Record<string, string>;
  adapterConfigPath: string;
  credentialRevision: number;
  receiptPath: string;
  sampleQuery: HistoricalSearchQuery;
  fetch?: typeof fetch;
  now?: () => Date;
};
```

Define the input with the adapter, resolved base URL, resolved headers, config path, non-secret credential revision, receipt path, sample query, injected `fetch`, and clock. Fetch `TMS_HTTP_V1_PATHS.health` directly, pass `resolvedHeaders`, and validate the remote body with `tmsHttpV1HealthSchema`; `HttpTmsAdapter.healthCheck()` discards the remote contract fields and cannot prove conformance. Invoke the adapter for historical rows, units, performance, and zones. Do not call the quote write endpoint during customer onboarding; the health declaration plus the final controlled RFQ prove writeback safely.

Implement the core in this order:

```ts
const fetchFn = input.fetch ?? fetch;
const healthUrl = new URL(
  TMS_HTTP_V1_PATHS.health,
  `${input.resolvedBaseUrl.replace(/\/$/, "")}/`
);
const healthResponse = await fetchFn(healthUrl, {
  headers: input.resolvedHeaders,
  signal: AbortSignal.timeout(10_000)
});
if (!healthResponse.ok) {
  throw safeProbeHttpError("health", healthResponse.status);
}
const health = tmsHttpV1HealthSchema.parse(await healthResponse.json());
if (!health.capabilities.write_quote) {
  throw new TmsProbeError("write_quote_not_declared");
}

const [historical, units, performance, zones] = await Promise.all([
  input.adapter.searchHistoricalQuotes(input.sampleQuery),
  input.adapter.getUnits(),
  input.adapter.getUnitPerformance(),
  input.adapter.getAvailabilityZones()
]);

requireProbeData({ historical, units, performance, zones });
const receipt = buildProbeReceipt({
  input,
  adapterConfigBytes: await readFile(input.adapterConfigPath),
  now: (input.now ?? (() => new Date()))()
});
await writeJsonAtomic(input.receiptPath, receipt, 0o600);
return receipt;
```

`safeProbeHttpError` may retain only endpoint name and status code. `requireProbeData` enforces the unit/performance/zone conditions below and checks that a no-comparable historical result contains at least one `insufficient_data` reason.

Require at least one unit, a performance row whose `unit_type` equals one returned unit’s `unit_id`, and one availability zone. A valid empty historical result is allowed only when the returned local `HistoricalAnalysis.insufficient_data` explains why.

Implement `probeLegacyCustomHttp` through the same `TmsProbeInput`, but call the bounded `adapter.healthCheck()` instead of pretending the remote body implements the v1 contract. Require `ok/status`, `capabilities.write_quote`, a configured explicit write-quote endpoint, and the same historical/unit/performance/zone canonical-output checks. Emit only the legacy discriminator shown above. It must not call writeback; the controlled test RFQ in Task 8 proves that mutation. Both probe functions share receipt writing and matching code.

Write the receipt atomically with mode `0600`. Hash the adapter config bytes; setup readiness accepts a receipt only when both its hash and `credential_revision` still match. Increment `settings/tms-credential-revision` atomically whenever onboarding changes the base URL or API key, so key rotation always invalidates the old receipt without persisting a key fingerprint.

- [ ] **Step 7: Make canonical HTTP the default onboarding choice**

Change the TMS phase to offer:

```text
1. API REST QuoteOps v1 (recommended)
2. Configuración REST avanzada existente
3. Exportaciones CSV
4. SQL
```

For canonical v1:

1. ask for one HTTPS base URL;
2. ask for one Bearer token masked;
3. write `TMS_HTTP_BASE_URL` and `TMS_API_KEY` to `client.env`;
4. generate the fixed config;
5. ask for one safe historical test lane/window;
6. run the probe;
7. persist the redacted receipt;
8. continue to unit synchronization only after success.

After writing the URL/key, do not read them back from the original `process.env` snapshot. Carry them through the same onboarding run:

```ts
const tmsEnv = {
  ...context.env,
  TMS_HTTP_BASE_URL: baseUrl,
  TMS_API_KEY: apiKey
};
const adapter = createTmsAdapterFromConfig({ configPath, env: tmsEnv });
```

Use `tmsEnv` for adapter creation, direct health headers, probe, and immediate unit synchronization; do not mutate global `process.env`.

`validateTmsBaseUrl` must parse an origin-only URL: require HTTPS; reject username/password, a pathname other than `/`, query, and fragment; normalize once to `url.origin`; and persist that normalized origin. This matches the root-relative canonical paths, so an operator cannot enter `https://host/prefix` and have `/prefix` silently discarded by `new URL`. Its only HTTP exception is the exact normalized origin `http://host.docker.internal:19091` when the one-shot container receives `QUOTEOPS_ACCEPTANCE_MODE=macbook` from the bounded temporary override in Task 8. Production Compose and persistent env files must never contain that variable.

For existing custom REST configurations, retain explicit paths and run `probeLegacyCustomHttp` before readiness. The advanced option edits only paths/headers already supported by the runtime; it does not accept a response-mapping document. Do not present mapping JSON as a runtime transformer and do not offer new AI-mapped arbitrary response shapes in this delivery. Do not offer OAuth because the runtime does not implement it.

- [ ] **Step 8: Make setup readiness use the receipt**

Change API readiness rules:

```ts
if (adapterConfig.provider === "http") {
  const expectedProbeContract =
    adapterConfig.contract === "quoteops-tms-http-v1"
      ? "quoteops-tms-http-v1"
      : "legacy-custom-http-canonical-output-v1";

  if (!(await hasMatchingTmsProbeReceipt({
    adapterConfigPath,
    receiptPath: tmsProbeReceiptPath,
    credentialRevision,
    expectedContract: expectedProbeContract
  }))) {
    requiredSteps.push(
      expectedProbeContract === "quoteops-tms-http-v1"
        ? "connect_tms"
        : "map_tms"
    );
  }
}
```

`hasMatchingTmsProbeReceipt` is the single implemented matcher: it parses the discriminated receipt, compares the expected contract, current config SHA-256, and current credential revision, and rejects corrupt or unknown fields. File/SQL/CSV adapters retain their existing non-HTTP readiness rules. Do not mark any HTTP endpoint connected because its URL/key env variables or mapping JSON merely exist.

- [ ] **Step 9: Align control-plane questionnaire and validation**

Use granular capabilities:

```ts
export type TmsCapability =
  | "historical_quotes"
  | "units"
  | "unit_performance"
  | "availability_zones"
  | "writeback"
  | "health_check";
```

For `quoteops-tms-http-v1`, require all six. Copy the exact OpenAPI and implementation guide into `pack.files` as `connectors/tms-http-v1.openapi.yaml` and `connectors/tms-http-v1.md`; assert both byte-for-byte in `apps/control-plane/tests/install-pack-install.test.ts`. Remove the current incorrect claim that HTTP historical search must return an aggregated `HistoricalAnalysis`.

Wire `QUOTEOPS_TMS_PROBE_PATH=/opt/quoteops-v1/settings/tms-probe.json` into Compose, mount `settings/` read-write for the API/onboarding services, and cover the path in `deploy/appliance/tests/smoke.sh`.

- [ ] **Step 10: Run focused TMS onboarding/readiness tests**

Run:

```bash
npx vitest run \
  apps/api/tests/onboard.test.ts \
  apps/api/tests/tmsProbe.test.ts \
  apps/api/tests/api.test.ts \
  apps/control-plane/tests/onboarding.test.ts \
  apps/control-plane/tests/install-pack-install.test.ts \
  packages/connectors/tests/tms-adapter.test.ts
bash deploy/appliance/tests/smoke.sh
```

Expected: PASS; canonical mode needs no mapping file, custom HTTP remains fail-closed without one.

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/onboard/tmsProbe.ts apps/api/src/onboard/onboardConfig.ts apps/api/src/onboard/cli.ts apps/api/src/index.ts apps/api/tests/tmsProbe.test.ts apps/api/tests/onboard.test.ts apps/api/tests/api.test.ts packages/connectors/src/tms/TmsAdapterConfig.ts apps/control-plane/src/onboarding/createClientManifest.ts apps/control-plane/src/onboarding/validateTms.ts apps/control-plane/src/installPack.ts apps/control-plane/tests/onboarding.test.ts apps/control-plane/tests/install-pack-install.test.ts deploy/appliance/docker-compose.yml deploy/appliance/tests/smoke.sh deploy/appliance/mock-tms/tms-adapter.http.yaml
git commit -m "feat(onboarding): validate canonical TMS endpoints"
```

---

### Task 8: Join License Activation, Tunnel Readiness, and Guided Install Completion

**Files:**
- Create: `apps/api/src/onboard/licenseActivationStep.ts`
- Create: `apps/api/src/onboard/testRfqStep.ts`
- Modify: `apps/api/src/onboard/onboardingFlow.ts`
- Modify: `apps/api/src/onboard/cli.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/tests/onboarding-flow.test.ts`
- Modify: `apps/api/tests/api.test.ts`
- Modify: `apps/web/src/api/quoteOpsApi.ts`
- Modify: `apps/web/src/pages/clientSetupWizard.tsx`
- Modify: `apps/web/tests/portalUi.test.tsx`
- Modify: `deploy/appliance/install.sh`
- Modify: `deploy/appliance/quoteops.sh`
- Modify: `deploy/appliance/verify-install.sh`
- Modify: `deploy/appliance/tests/smoke.sh`
- Modify: `apps/control-plane-api/src/index.ts`
- Modify: `apps/control-plane-api/src/installerScript.ts`
- Modify: `apps/control-plane-api/tests/control-plane-api.test.ts`

**Interfaces:**
- Produces onboarding phase: `license_activation`.
- Produces onboarding phase: `test_rfq` and safe `settings/test-rfq.json`.
- Produces setup step: `connect_cloudflare`.
- Produces safe `TunnelSetupState`.
- Produces installer flags: `--guided`, `--resume-guided`, and host-side `--answers-dir`; the onboarding CLI receives `--resume` plus fixed container-side `--answers-file /run/quoteops-onboard-input/answers.json`.
- Produces local resume command: `sudo quoteops onboard --resume`.

- [ ] **Step 1: Add failing license-phase order tests**

Update the ordered-flow expectation:

```ts
expect(calls).toEqual([
  "ai_provider",
  "license_activation",
  "cloudflare",
  "appliance_secrets",
  "tms",
  "units",
  "authorization",
  "pricing",
  "knowledge",
  "test_rfq"
]);
```

Update the concrete CLI phase list to insert `licenseActivationPhase` immediately after `aiProviderPhase` and `testRfqPhase` immediately after `knowledgePhase`. Add an activation test that posts the authorized email to the internal API and requires a persisted valid license before completing the phase. Add a `test_rfq` resume case proving an already approved stored run is reused and no second POST occurs.

- [ ] **Step 2: Run the flow tests to verify RED**

Run:

```bash
npx vitest run apps/api/tests/onboarding-flow.test.ts
```

Expected: FAIL because terminal onboarding does not activate the license.

- [ ] **Step 3: Implement terminal license activation**

Create `apps/api/src/onboard/licenseActivationStep.ts`:

```ts
const ONBOARD_INTERNAL_API_ORIGIN = "http://quoteops-api:8080" as const;

export async function activateLicenseFromOnboarding(input: {
  email: string;
  fetch?: typeof fetch;
}): Promise<{
  activated: true;
  client_id: string;
  installation_id: string;
}> {
  const fetchFn = input.fetch ?? fetch;
  const response = await fetchFn(
    new URL("/api/onboarding/activate", ONBOARD_INTERNAL_API_ORIGIN),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: input.email }),
      signal: AbortSignal.timeout(10_000)
    }
  );
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw safeActivationError(response.status, body);
  }
  return activationOnboardingResponseSchema.parse(body);
}
```

Define `activationOnboardingResponseSchema` as a strict object with `activated: z.literal(true)`, `client_id`, and `installation_id`. The one-shot onboarding container is a different network namespace, so it must use the fixed Compose-service origin `http://quoteops-api:8080`, never loopback. Do not accept this origin from answers or CLI; if the existing `QUOTEOPS_ONBOARD_API_URL` env is retained, validate that it equals the constant before use. Map timeout/network failure to `activation_unreachable` and retain only status plus safe error code. Use the already stored registration token through the local API; never pass it from the CLI request or print it. If the license is already valid for the same `client_id + installation_id`, mark the phase complete without a network mutation. Add a never-resolving fetch test and an SSRF test proving a supplied alternate origin cannot be used.

Make the control-plane `/api/onboarding/activate` retry-safe across response loss. After authorizing the email and matching token/client/installation, handle a used token as follows: if `used_at` is set and that same installation is already licensed, re-create the license response from the stored `used_at` without another state mutation; if the token is used but the installation is not licensed, return a safe conflict. Apply expiry only to an unused token. Add a control-plane test that completes activation, discards the first response, retries with the same inputs, receives a valid license, and observes one token-consumption transition.

- [ ] **Step 4: Implement the post-restart test-RFQ phase**

Create `apps/api/src/onboard/testRfqStep.ts` with a fixed `MAC/VM readiness` request matching the v1 fixture:

```ts
export const readinessRfqRequest = {
  origin_city: "Guadalajara",
  origin_state: "Jalisco",
  destination_city: "Monterrey",
  destination_state: "Nuevo Leon",
  equipment_request: "caja seca 53",
  vehicle_profile_id: "T3S3_53_DRYVAN",
  weight_kg: 18000,
  commodity: "general",
  sector: "industrial",
  value_mxn: 250000,
  business_unit_id: "general"
} as const;

export type TestRfqReceipt = {
  schema_version: 1;
  run_id: string;
  request_sha256: string;
  state: "submitted" | "complete";
  submitted_at: string;
  completed_at?: string;
  base_quote_status?: "APPROVED";
  approval_required?: false;
};
```

Derive one deterministic `run_id` from the installation ID plus a versioned hash of `readinessRfqRequest`. Before any mutation, atomically write the safe `submitted` receipt. On every first run or resume, GET that run from the fixed internal origin `http://quoteops-api:8080`; POST to `/api/playground/rfqs` only on `404`, including the deterministic `run_id` and request hash. Make that API route idempotent: the same `run_id` plus structurally identical request returns the existing workflow, while a conflicting request returns `409`.

`runTestRfqPhase` then polls `/api/rfqs/:runId` every two seconds for at most two minutes, requires a priced terminal run with `base_quote.status === "APPROVED"` and `approval_required === false`, and atomically upgrades the receipt to `complete`. Its `isComplete` must load the final receipt, match the current request hash, and confirm the referenced run still satisfies the API’s existing `hasPassingTestRfq` semantic. A missing receipt creates the intent; a corrupt/mismatched receipt fails closed for operator repair; a valid receipt never posts again.

Add interruption tests for: crash after intent write but before POST, crash after accepted POST but before the response is observed, and crash while polling. Every resume must GET first, create at most one workflow, and produce at most one TMS writeback.

Ensure the generated v0.2.0 manifest contains business unit `general`, vehicle profile `T3S3_53_DRYVAN`, and deterministic approval/pricing defaults under which this fixture auto-approves. Add a focused test that a review-required or failed run remains pending.

- [ ] **Step 5: Write failing tunnel setup-state tests**

In `apps/api/tests/api.test.ts`, assert:

```ts
expect(state.tunnel).toEqual({
  provider: "cloudflare",
  required: true,
  status: "missing_config",
  public_hostname: null,
  last_checked_at: expect.any(String)
});
expect(state.required_steps).toContain("connect_cloudflare");
expect(JSON.stringify(state)).not.toContain("TUNNEL_TOKEN");
```

Add configured-but-zero-connections, connected-but-public-200-without-Access, Access-protected-but-missing authenticated-origin receipt, wrong-version/wrong-installation receipt, and fully ready matching-receipt cases.

- [ ] **Step 6: Run API tests to verify RED**

Run:

```bash
npx vitest run apps/api/tests/api.test.ts
```

Expected: FAIL because setup state has no tunnel field or step.

- [ ] **Step 7: Add safe tunnel readiness**

Extend `SetupStepId`:

```ts
export type SetupStepId =
  | "activate_license"
  | "configure_secrets"
  | "connect_cloudflare"
  | "connect_tms"
  | "map_tms"
  | "connect_knowledge_base"
  | "connect_mailbox"
  | "connect_sakbe"
  | "run_test_rfq";
```

Add:

```ts
export type TunnelSetupState = {
  provider: "cloudflare";
  required: true;
  status:
    | "missing_config"
    | "missing_token"
    | "starting"
    | "ready"
    | "unreachable"
    | "access_unprotected";
  public_hostname: string | null;
  last_checked_at: string;
};
```

Derive readiness from:

1. valid `settings/cloudflare.json`;
2. presence—not value—of `TUNNEL_TOKEN`;
3. `cloudflared_tunnel_ha_connections > 0` from internal metrics;
4. an unauthenticated public request denied/redirected by Cloudflare Access;
5. a matching `cloudflare-public-validation.json` proving one prior Service Auth request returned this release plus client/installation IDs.

Inject `TunnelReadinessProbe` into `buildLocalSetupState` rather than calling global fetch directly. Its public probe uses `AbortSignal.timeout(3_000)`, validates the Cloudflare-specific Access evidence from Task 4, catches timeout/network failures as `unreachable`, and never includes a response body in state or logs. Parse and match the safe authenticated-origin receipt; a missing/mismatched receipt yields `pending_manual_public_validation`. Test a never-settling injected fetch.

Do not send tunnel status or hostname in the minimal heartbeat beyond the existing aggregate onboarding status.

- [ ] **Step 8: Update the setup wizard**

Add `connect_cloudflare` copy to `clientSetupWizard.tsx`:

```ts
{
  id: "connect_cloudflare",
  title: "Publicar con Cloudflare",
  detail:
    "Conecta el túnel nombrado del cliente y confirma que Cloudflare Access protege el dominio."
}
```

Show the safe public hostname and tunnel status; never render env names, tokens, metrics bodies, or headers.

- [ ] **Step 9: Add failing guided-installer sequence checks**

In `deploy/appliance/tests/smoke.sh`, use fake Docker commands and assert this exact sequence:

```text
compose up -d postgres redis quoteops-agent quoteops-api quoteops-web caddy
compose --profile onboarding run --rm quoteops-onboard --resume --until knowledge
compose up -d postgres redis quoteops-agent quoteops-api quoteops-web caddy
compose --profile onboarding run --rm quoteops-onboard --resume --only test_rfq
compose --profile tunnel up -d cloudflared
verify-install.sh
```

Assert that an onboarding failure does not start `cloudflared`, does not switch to ready, and prints:

```text
Onboarding pendiente. Reanuda con:
sudo quoteops onboard --resume
```

Also execute the generated `quoteops onboard --resume` command in the fake-Docker fixture and assert that it enters the same guided resume orchestration—core start, onboarding, core restart, test RFQ, tunnel start, and verification—instead of invoking only the one-shot onboarding container.

- [ ] **Step 10: Run smoke to verify RED**

Run:

```bash
bash deploy/appliance/tests/smoke.sh
```

Expected: FAIL because guided install still stops after printing the onboarding command.

- [ ] **Step 11: Orchestrate the complete guided sequence**

In `install.sh`, guided mode must:

1. activate the release layout;
2. start core services without the `tunnel` profile;
3. wait for internal `/api/health`;
4. run `quoteops-onboard --resume --until knowledge` attached to `/dev/tty` or with `-T` in automation mode;
5. restart core services so new env values are loaded;
6. run `quoteops-onboard --resume --only test_rfq` so the one controlled readiness RFQ uses the reloaded config;
7. start `cloudflared` with the `tunnel` profile;
8. run `verify-install.sh`;
9. print the public URL only when every setup step, including `run_test_rfq`, passes.

Add a distinct `--resume-guided` branch that requires an existing valid `$QUOTEOPS_HOME/current` release plus the stored client/installation identity, skips archive installation and registration-token handling, and repeats steps 2–9 idempotently. In `quoteops.sh`, change the `onboard` route to remove one optional user-facing `--resume` argument and execute:

```bash
exec "$SCRIPT_DIR/install.sh" --resume-guided "$@"
```

This makes the printed `sudo quoteops onboard --resume` command capable of finishing Cloudflare startup and final verification after any interruption; it must not merely finish CLI prompts.

On interruption or external dependency failure, leave the release and data intact and exit `20` with the local resume command.

- [ ] **Step 12: Add a secure automation input for acceptance tests**

Support `install.sh --answers-dir HOST_DIR` only when:

- `HOST_DIR` is a physical non-symlink directory beneath the bounded acceptance root with mode `0700`;
- before mounting, host-side `install.sh` proves `answers.json` and every referenced input are regular non-symlink files, mode `0600`, and owned by the host operator (or root under `sudo`);
- guided stdin is noninteractive;
- the installer generates a temporary Compose override containing one bind from the canonical host directory to `/run/quoteops-onboard-input` with `read_only: true`;
- only after the host’s bounded Mac path checks pass, that same temporary override sets `QUOTEOPS_ACCEPTANCE_MODE=macbook` on `quoteops-onboard` and nowhere else;
- the one-shot onboarding container runs with `-T` and receives only `--answers-file /run/quoteops-onboard-input/answers.json`;
- the host input directory is removed by the Mac acceptance harness immediately after use.

Use the single `OnboardingAnswers` schema defined in Task 5; do not create a second automation type. Every credential field remains a `SecretFileRef`, and all referenced files must be regular `0600` files in the same bounded input directory as the answers file. Mount that directory at `/run/quoteops-onboard-input:ro`, require all JSON paths to resolve beneath that mount, and reject symlinks or path traversal.

Docker Desktop may present bind-mounted Mac files as root-owned inside the Linux container. Ownership is therefore enforced on the host before Compose; inside the one-shot container, validate the known read-only mount, canonical containment, regular-file type, and absence of group/other write bits, but do not compare the container UID to the Mac UID. Add a real bind-mount test that records both observed UIDs and passes only because the host-side ownership check already succeeded.

Do not support inline JSON or individual secret command-line flags. Delete the temporary override on exit and assert `QUOTEOPS_ACCEPTANCE_MODE` is absent from `$QUOTEOPS_HOME/.env`, `secrets/client.env`, `secrets/cloudflare.env`, `secrets/cloudflare-access-validation.env`, `release.env`, and production Compose rendering.

Add smoke assertions that interactive mode has no onboarding bind and retains TTY, automation mode uses `-T`, the generated override is read-only, `"$@"` reaches `install.sh`, and neither host credential values nor host credential filenames appear in Compose logs or command traces.

- [ ] **Step 13: Run focused integration checks**

Run:

```bash
npx vitest run \
  apps/api/tests/onboarding-flow.test.ts \
  apps/api/tests/api.test.ts \
  apps/web/tests/portalUi.test.tsx \
  apps/control-plane-api/tests/control-plane-api.test.ts
bash deploy/appliance/tests/smoke.sh
```

Expected: PASS; ready is impossible without activation, AI, tunnel+Access, TMS receipt, and the existing remaining setup gates.

- [ ] **Step 14: Commit**

```bash
git add apps/api/src/onboard/licenseActivationStep.ts apps/api/src/onboard/testRfqStep.ts apps/api/src/onboard/onboardingFlow.ts apps/api/src/onboard/cli.ts apps/api/src/index.ts apps/api/tests/onboarding-flow.test.ts apps/api/tests/api.test.ts apps/web/src/api/quoteOpsApi.ts apps/web/src/pages/clientSetupWizard.tsx apps/web/tests/portalUi.test.tsx deploy/appliance/install.sh deploy/appliance/quoteops.sh deploy/appliance/verify-install.sh deploy/appliance/tests/smoke.sh apps/control-plane-api/src/index.ts apps/control-plane-api/src/installerScript.ts apps/control-plane-api/tests/control-plane-api.test.ts
git commit -m "feat(appliance): complete guided install through public readiness"
```

---

### Task 9: Make Update, Rollback, Backup, and Restore Version-Safe

**Files:**
- Create: `deploy/appliance/tests/lifecycle.sh`
- Create: `deploy/appliance/tests/n-minus-one-schema.sh`
- Modify: `deploy/appliance/upgrade.sh`
- Modify: `deploy/appliance/backup.sh`
- Modify: `deploy/appliance/restore.sh`
- Modify: `deploy/appliance/quoteops.sh`
- Modify: `apps/control-plane-api/src/index.ts`
- Modify: `apps/control-plane-api/tests/control-plane-api.test.ts`
- Modify: `.github/workflows/release.yml`
- Modify: `vercel.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: authenticated `GET /api/releases/:version/appliance`.
- Produces: machine-authenticated `POST /api/internal/releases/sync-bundled`.
- Produces: semver-pinned updates such as `quoteops update --to v0.2.1`.
- Produces: `quoteops rollback`.
- Produces backup metadata: `backup-manifest.json` and `SHA256SUMS`.
- Produces deployment metadata: `state/deployment.json` with `active_version` and `previous_version`.
- Guarantees: failed target health returns to the prior `current` symlink and running release.

- [ ] **Step 1: Write failing release-download API tests**

In `apps/control-plane-api/tests/control-plane-api.test.ts`, assert:

```ts
await request(app)
  .get("/api/releases/v0.2.0/appliance")
  .expect(401);

const response = await request(app)
  .get("/api/releases/v0.2.0/appliance")
  .set("authorization", `Bearer ${installationToken}`)
  .expect(200);

expect(response.headers["content-type"]).toMatch(/application\/gzip/);
expect(response.headers["x-quoteops-version"]).toBe("v0.2.0");
expect(response.headers["x-quoteops-sha256"]).toMatch(/^[a-f0-9]{64}$/);
```

Seed both `v0.2.0` and `v0.2.1` through the Task 2 data interface, assert each exact version remains downloadable, and assert an unregistered version returns `404 release_not_available`.

- [ ] **Step 2: Run the API test to verify RED**

Run:

```bash
npx vitest run apps/control-plane-api/tests/control-plane-api.test.ts
```

Expected: FAIL because the release download endpoint is absent.

- [ ] **Step 3: Sync deployed bytes and serve only registered release artifacts**

Add `POST /api/internal/releases/sync-bundled`, outside user-admin session auth. Require a dedicated random `QUOTEOPS_RELEASE_SYNC_TOKEN` of at least 32 bytes, compare its Bearer value in constant time, fail closed when absent, and allow it on this route only. The same secret is stored as a protected GitHub Actions environment secret and rotated independently of installation/admin credentials; never log its value or authorization header.

The route reads the current deployment’s tarball, detached checksum, and manifest from `dist/appliance/$QUOTEOPS_APPLIANCE_RELEASE_VERSION`, verifies all three plus the 2 MiB raw bound, and calls immutable `upsertRelease`. A same-version/same-hash retry is idempotent; a same-version/different-hash conflict is `409`.

Add `GET /api/releases/:version/appliance` using the existing installation Bearer-token verifier. Resolve the exact row with `data.getRelease(version)`, re-hash its archive, validate its stored manifest, require the URL version to match, stream those immutable bytes, and set:

```text
Content-Type: application/gzip
Cache-Control: private, no-store
X-QuoteOps-Version: v0.2.0
X-QuoteOps-Sha256: 64 lowercase hexadecimal characters
```

Make `/api/releases/latest` return only `{ version, notes, bundle_sha256, manifest }`, never archive bytes. Never build an archive on request and never serve files from the live repository checkout.

- [ ] **Step 4: Write failing lifecycle shell tests**

Create `deploy/appliance/tests/lifecycle.sh` with fake `curl`, `docker`, and `docker compose` binaries. Cover:

```text
successful update:
  release-curl-config -> download -> checksum -> stage -> access-preflight -> backup -> pull -> switch -> up -> authenticated-origin-verify -> deployment-state

failed checksum:
  reject before backup/switch

missing/unsafe Cloudflare Access input:
  reject before backup/switch when the tunnel profile is configured

failed target health:
  switch back -> load previous release.env -> up previous -> verify previous authenticated origin -> delete transient Access secret -> exit non-zero

explicit rollback:
  read deployment.json.previous_version -> access-preflight -> switch -> up prior images/tunnel -> verify authenticated origin

corrupt backup:
  reject before stopping services

restore failure:
  restore pre-restore files and PostgreSQL dump -> relaunch active release
```

Record the fake command order and compare it to an exact expected array. Assert the installation token appears only inside a temporary release-download curl config, the Service Auth credential appears only inside a caller-owned `0600` source file and `secrets/cloudflare-access-validation.env`, all Compose calls load the active `release.env`, and a configured tunnel is recreated under the target/rolled-back release. Assert both temporary curl configs and the copied Access secret are deleted after either successful target verification or verified rollback, and that backup fixtures never include them.

- [ ] **Step 5: Run lifecycle tests to verify RED**

Run:

```bash
bash deploy/appliance/tests/lifecycle.sh
```

Expected: FAIL because update has no bundle staging or health rollback.

- [ ] **Step 6: Implement staged, health-gated update**

Change `upgrade.sh` so an invocation such as `quoteops update --to v0.2.1`:

1. rejects the active version and any non-semver target;
2. downloads the requested `/api/releases/:version/appliance` route using `--proto "=https" --proto-redir "=https" --tlsv1.2` and a temporary `0600` curl-config file that carries the installation Bearer credential;
3. validates the response version and SHA-256;
4. extracts into a temporary sibling of the requested version directory with path-traversal checks;
5. requires the exact archive inventory, verifies in-archive `PAYLOAD_SHA256SUMS` with the portable SHA helper, parses `release.json` with bootstrap-installed `jq`, compares its version/platform/inventory to the request and `release.env`, and verifies every `files_sha256` entry;
6. when `settings/cloudflare.json` enables the tunnel profile, obtains Access Service Auth values securely from `/dev/tty` or accepts only `--cloudflare-access-file /absolute/path` pointing to a caller-owned regular `0600` file, validates single-line values, and copies them atomically to `secrets/cloudflare-access-validation.env` before any backup or switch; a non-interactive run without that safe input fails closed with a resume command;
7. runs a pre-update backup, which excludes the entire `secrets/` directory;
8. records the previous `current` target;
9. pulls only exact version/digest references;
10. atomically switches `current`;
11. starts the target release using shared `.env` plus target `release.env`, including `--profile tunnel` when `settings/cloudflare.json` is configured;
12. runs internal version health first, then anonymous Access protection and authenticated-origin checks for the target version/client/installation, writes a fresh safe receipt, and deletes the transient Service Auth file;
13. atomically writes `state/deployment.json` with `{active_version: target, previous_version: prior}` only on success.

On any post-switch failure, restore the prior symlink, load the prior `release.env`, recreate core services plus the tunnel profile when configured, verify prior internal health and the prior authenticated public identity with the same still-transient Access credential, rewrite the safe prior-version receipt, delete the credential, and exit non-zero with both target and restored version. If public verification cannot prove the restored installation, retain the credential only for bounded `quoteops onboard --resume` recovery and report that rollback health is unresolved; never claim a successful rollback from internal health alone. Do not automatically restore the database during an application rollback; the release gate below proves every migration is additive and N-1 compatible.

`quoteops rollback` must read `deployment.json.previous_version`, verify that release locally, perform the same Access-credential preflight and health-gated switch, refresh the authenticated-origin receipt, delete the transient credential, and then swap active/previous values. It must never guess from directory sort order. Do not accept the Service Auth client secret as a command-line value or environment variable.

At the start of update/rollback/backup/restore, require `jq` and validate every JSON file with `jq -e` against an exact key/type/enum predicate before using a value. Add real Ubuntu and Mac lifecycle cases with host-side Node absent to prove update depends only on Bash, `jq`, tar, and checksum tools.

- [ ] **Step 7: Expand backup contents without copying secret values**

Add:

```json
{
  "schema_version": 1,
  "client_id": "CLIENT",
  "installation_id": "CLIENT-local-001",
  "quoteops_version": "v0.2.0",
  "created_at": "2026-07-29T18:00:00.000Z",
  "includes": [
    "postgres.sql",
    "manifests",
    "criteria",
    "connectors",
    "settings",
    "state"
  ],
  "required_secret_keys": [
    "POSTGRES_PASSWORD",
    "QUOTEOPS_REGISTRATION_TOKEN",
    "OPENROUTER_API_KEY",
    "TMS_API_KEY",
    "TUNNEL_TOKEN"
  ]
}
```

Store this as `backup-manifest.json`, include connectors/settings and non-deployment state, exclude `.env`, the entire `secrets/` directory (including the transient Access credential), onboarding answer inputs, evidence, and `state/deployment.json`, add an internal `SHA256SUMS` that does not list itself, and set the final archive mode to `0600`. Restore must preserve or regenerate deployment state from the actually active local release; it must never import a stale release pointer from data backup.

Derive `required_secret_keys` from the active agent/TMS/Cloudflare configuration rather than hard-coding only the example keys. It must always include `POSTGRES_PASSWORD` and `QUOTEOPS_REGISTRATION_TOKEN`, then include the selected AI provider, TMS, tunnel, configured mailbox provider, SAKBÉ, and embeddings when enabled. Resolve presence across `client.env` and `cloudflare.env` without copying values. Never include the transient Cloudflare Access credential in the manifest; a restore/update that needs public revalidation requests a fresh Service Auth source file.

- [ ] **Step 8: Make restore fail safely**

Before stopping anything, `restore.sh` must:

1. validate archive member paths;
2. validate `backup-manifest.json` with an exact `jq -e` schema—no unknown keys, correct scalar/array types, valid semver/date, and allowlisted relative `includes` entries;
3. verify every internal checksum;
4. require the same `client_id + installation_id`;
5. require all `required_secret_keys` to exist locally;
6. create a pre-restore backup.

Parse `state/deployment.json` through the same exact-schema approach before rollback or recovery. Never use regex/`source`/`eval` to read JSON, and never treat a parse failure as permission to guess a version or secret requirement.

If PostgreSQL import or file replacement fails, restore both the pre-restore directories and the pre-restore PostgreSQL dump, relaunch the previously active release with its `release.env`, verify health, and print a redacted failure summary. Test an import that fails after creating partial tables and prove the original row counts return. It must never leave the stack deliberately stopped after returning.

- [ ] **Step 9: Run lifecycle verification**

Run:

```bash
bash deploy/appliance/tests/lifecycle.sh
bash deploy/appliance/tests/smoke.sh
```

Expected: PASS.

- [ ] **Step 10: Add a real N-1 database compatibility gate**

Create `deploy/appliance/tests/n-minus-one-schema.sh` to:

1. start a uniquely named PostgreSQL 16 test container on a temporary volume;
2. start the previous stable API image from its digest-pinned prior `release.json`;
3. create representative workflow, quote, heartbeat, knowledge, and licensing rows through the previous API/test seed;
4. stop the previous API, run current migrations/current API against the same database, and verify the seeded rows;
5. stop current API, restart the previous digest-pinned API against the migrated database, and require `/api/health` plus seeded-row reads to pass;
6. remove only its named containers/volume through a validated trap.

The script accepts previous/current release manifests by file path, rejects mutable images, and prints only version/status. Add it to release CI after current image publication and candidate appliance packaging but before artifact publication. A schema change that prevents the previous API from starting blocks release.

Resolve the previous input deterministically. Prefer the newest lower SemVer GitHub Release that contains `release.json` plus `SHA256SUMS`, download both, and verify the manifest checksum before use. For the first appliance release `v0.2.0` only, when no prior appliance artifact exists, resolve the public `ghcr.io/alejandroc-bit/quote-ops-api:v0.1.7` tag to its immutable registry digest and generate an ephemeral minimal previous-API manifest recorded in workflow evidence. Any later release with no prior appliance manifest fails rather than silently skipping N-1.

- [ ] **Step 11: Include shell and publication gates in CI**

Add to `.github/workflows/ci.yml` after Vitest:

```yaml
      - run: bash deploy/appliance/tests/smoke.sh
      - run: bash deploy/appliance/tests/lifecycle.sh
      - run: bash -n deploy/appliance/*.sh
```

The tag-only release workflow uses this order; ordinary pull-request CI continues to run fixture/unit shell gates without requiring published images:

1. `build-and-push` publishes current application images and outputs their digests;
2. `package-appliance` consumes those digests, resolves the manifest-list digests for `postgres:16-alpine`, `redis:7-alpine`, and `caddy:2-alpine`, runs the packager with `SOURCE_DATE_EPOCH="$(git show -s --format=%ct HEAD)"`, verifies inventory/modes/checksums, and uploads a private Actions artifact containing the candidate tarball, `release.json`, `bootstrap.sh`, and `SHA256SUMS`;
3. `n-minus-one-schema` downloads that candidate artifact plus the verified previous manifest and runs the real compatibility script;
4. `anonymous-pull` runs on a fresh runner without registry login and pulls every candidate image by semver-plus-digest;
5. `publish-appliance`, gated by both prior jobs, publishes the exact candidate bytes to the GitHub Release with `contents: write`;
6. `deploy-control-plane` downloads the already published/verified artifact and deploys it.

The Actions artifact root must contain the version directory itself (`v0.2.0/{quoteops-appliance-v0.2.0.tar.gz,release.json,bootstrap.sh,SHA256SUMS}`). Downloading it to `dist/appliance` therefore produces exactly `dist/appliance/$GITHUB_REF_NAME/...`, matching the sync and bootstrap loaders; add a workflow fixture assertion before `vercel build`.

Update `vercel.json` to include `dist/appliance/**`, `docs/integrations/tms-http-v1.openapi.yaml`, and `docs/integrations/tms-http-v1.md` in the control-plane API function. The first glob carries the separately packaged `bootstrap.sh`; the documentation assets feed client-specific `pack.files`. Add a post-`vercel build` artifact assertion that all four versioned release files plus both TMS documents exist in the function bundle. Use this release-workflow shape so production control-plane deployment uses the same checked-out tag and downloaded appliance artifact:

```yaml
  deploy-control-plane:
    needs: [verify, publish-appliance]
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.ref }}
      - uses: actions/download-artifact@v4
        with:
          name: appliance-release
          path: dist/appliance
      - run: npm ci
      - run: npx vercel pull --yes --environment=production --token="$VERCEL_TOKEN"
      - run: npx vercel build --prod --token="$VERCEL_TOKEN"
        env:
          QUOTEOPS_APPLIANCE_RELEASE_VERSION: ${{ github.ref_name }}
      - run: npx vercel deploy --prebuilt --prod --token="$VERCEL_TOKEN"
    env:
      VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
      VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
      VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
```

After deployment, use the protected release-sync machine token to POST `/api/internal/releases/sync-bundled`, then use the workflow’s installation test credential to request `/api/releases/latest`. Parse JSON and fail unless `version === github.ref_name`, `bundle_sha256` matches the detached checksum from `SHA256SUMS`, and a download of that exact version re-hashes to the same value. Add a regression test/deploy smoke proving an older stored version remains downloadable after syncing the new one.

- [ ] **Step 12: Run all lifecycle/API checks**

Run:

```bash
npx vitest run apps/control-plane-api/tests/control-plane-api.test.ts
bash deploy/appliance/tests/smoke.sh
bash deploy/appliance/tests/lifecycle.sh
```

Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add deploy/appliance/upgrade.sh deploy/appliance/backup.sh deploy/appliance/restore.sh deploy/appliance/quoteops.sh deploy/appliance/tests/lifecycle.sh deploy/appliance/tests/n-minus-one-schema.sh apps/control-plane-api/src/index.ts apps/control-plane-api/tests/control-plane-api.test.ts .github/workflows/ci.yml .github/workflows/release.yml vercel.json
git commit -m "feat(appliance): add health-gated update and recovery"
```

---

### Task 10: Document the Customer Handoff, Prove the Ubuntu Bootstrap, and Run Final MacBook Acceptance

**Files:**
- Create: `deploy/appliance/tests/ubuntu-vm-bootstrap-acceptance.sh`
- Create: `deploy/appliance/tests/macbook-acceptance.sh`
- Create: `deploy/appliance/tests/fixtures/readiness-knowledge.md`
- Create: `docs/runbooks/customer-vm-install.md`
- Modify: `deploy/appliance/README.md`
- Modify: `deploy/appliance/CONTROL_PLANE.md`
- Modify: `deploy/appliance/SECRETS.md`
- Modify: `package.json`
- Create at execution time: `docs/evidence/$(date -u +%Y%m%dT%H%M%SZ)-macbook-appliance/`

**Interfaces:**
- Consumes: a staging control-plane URL, expected client/installation IDs plus single-use registration token from the issued install pack, real AI key, real Cloudflare named-tunnel token/hostname, Cloudflare Access service token, authorized onboarding email, Resend test-mailbox credentials, a SAKBÉ test key, and an embeddings provider/key.
- Produces: a redacted acceptance bundle and pass/fail exit code.
- Produces: `npm run test:appliance:ubuntu-vm`, the real Ubuntu 24.04 `linux/amd64` bootstrap/apt gate executed through QEMU on this Mac.
- Produces: `npm run test:appliance:mac`.

- [ ] **Step 1: Write the customer prerequisite checklist**

Create `docs/runbooks/customer-vm-install.md` with a pre-install form containing these exact fields:

```text
VM
- Ubuntu Server 24.04 LTS, x86_64
- sudo/root access
- bash, curl, and sudo installed for the displayed operator command
- outbound HTTPS, DNS, and NTP
- no inbound public ports required

Cloudflare, owned by client
- public hostname
- named tunnel route: http://caddy:80
- named tunnel token
- Access application and human-user allow policy
- Access Service Auth policy that explicitly includes the acceptance service token
- acceptance Service Auth client ID and secret, entered transiently and deleted after verification
- ability to re-enter those Service Auth values if verification must be resumed

AI
- provider: OpenRouter or Gemini
- API key

TMS
- contract: quoteops-tms-http-v1
- HTTPS base URL
- Bearer API key
- completed OpenAPI conformance test
- non-production lane/window for onboarding probe

Identity
- authorized activation email

Workflow integrations required when enabled in the generated pack
- mailbox credentials
- INEGI SAKBÉ key
- embeddings key
```

State explicitly that the VM receives containers and a versioned runtime bundle, not a Git clone.

- [ ] **Step 2: Document the one-command and operator flow**

Document that the control plane displays:

```bash
bash -c 'set -Eeuo pipefail; f="$(mktemp)"; trap '\''rm -f "$f"'\'' EXIT; curl --proto "=https" --proto-redir "=https" --tlsv1.2 -fsSL "$1" -o "$f"; sudo bash "$f"' quoteops "${CONTROL_PLANE_URL}/install/quoteops"
```

The command prompts for the registration token through `/dev/tty`; it is not pasted into the command. Document:

```bash
sudo quoteops status
sudo quoteops doctor
sudo quoteops onboard --resume
sudo quoteops update --to v0.2.1
sudo quoteops rollback
sudo quoteops backup
sudo quoteops restore /opt/quoteops-v1/backups/quoteops-client-v0.2.0-date.tar.gz
sudo quoteops logs --tail 200
```

Explain the stable data layout, release symlink, what a rollback does, and that restoring onto another VM requires re-entering local secrets.
Explain that `update` and `rollback` securely prompt for transient Cloudflare Service Auth values when the tunnel is configured, or accept only `--cloudflare-access-file /absolute/0600/path`; they refresh the version-bound public-origin receipt and delete the local credential after verification.

- [ ] **Step 3: Write the failing Mac acceptance preflight**

Create `deploy/appliance/tests/macbook-acceptance.sh` and make its preflight require:

```text
uname -m == arm64
curl, jq, openssl, node, tar, shasum, and bash are on PATH
docker info succeeds
docker compose version is at least 2.24.0
E2E_CONTROL_PLANE_URL is HTTPS
E2E_EXPECTED_CLIENT_ID matches the production client-ID schema
E2E_EXPECTED_INSTALLATION_ID matches the installation-ID schema
E2E_REGISTRATION_TOKEN_FILE exists and is 0600
E2E_AI_PROVIDER is openrouter or gemini
E2E_AI_KEY_FILE exists and is 0600
E2E_TUNNEL_TOKEN_FILE exists and is 0600
E2E_CF_ACCESS_CLIENT_ID_FILE exists and is 0600
E2E_CF_ACCESS_CLIENT_SECRET_FILE exists and is 0600
E2E_RESEND_API_KEY_FILE exists and is 0600
E2E_SAKBE_KEY_FILE exists and is 0600
E2E_EMBEDDING_PROVIDER is gemini or openai_compatible
E2E_EMBEDDING_MODEL is non-empty
E2E_EMBEDDING_KEY_FILE exists and is 0600
E2E_EMBEDDING_BASE_URL is HTTPS when provider is openai_compatible
E2E_PUBLIC_HOSTNAME is a hostname without scheme/path
E2E_AUTHORIZED_EMAIL is non-empty
E2E_RESEND_INTAKE_ADDRESS is a valid email
E2E_RESEND_FROM_ADDRESS is a valid email
```

Run with no environment:

```bash
bash deploy/appliance/tests/macbook-acceptance.sh
```

Expected: exit `2` and print only the missing variable/file names, never their values.

- [ ] **Step 4: Bound every destructive target**

The acceptance harness must generate:

```bash
E2E_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/quoteops-mac-e2e.XXXXXX")"
COMPOSE_PROJECT_NAME="quoteops_mac_e2e_$(date +%s)"
QUOTEOPS_HOME="$E2E_ROOT/quoteops-v1"
QUOTEOPS_BIN_DIR="$E2E_ROOT/bin"
QUOTEOPS_PLATFORM="linux/amd64"
E2E_STATE_FILE="${TMPDIR:-/tmp}/quoteops-macbook-acceptance-${UID}.json"
```

Before cleanup, require:

```bash
[[ "$E2E_ROOT" == "${TMPDIR:-/tmp}"/quoteops-mac-e2e.* ]]
[[ "$COMPOSE_PROJECT_NAME" == quoteops_mac_e2e_* ]]
[[ "$QUOTEOPS_HOME" == "$E2E_ROOT/quoteops-v1" ]]
[[ "$QUOTEOPS_BIN_DIR" == "$E2E_ROOT/bin" ]]
```

Write `E2E_STATE_FILE` atomically with mode `0600`, containing only the canonical root, project name, active Compose file paths, and creation timestamp. Refuse a new run when that state file describes a retained project. Never target another Compose project, `/opt/quoteops-v1`, the repository root, a home directory, or `/`.

Install one cleanup trap immediately after state creation. It always terminates and waits for the recorded mock-TMS child PID and deletes transient curl/answer files. Unless `--keep` was explicitly set after a failed run, it invokes exactly:

```bash
docker compose \
  --project-name "$COMPOSE_PROJECT_NAME" \
  --env-file "$QUOTEOPS_HOME/.env" \
  --env-file "$QUOTEOPS_HOME/current/release.env" \
  -f "$QUOTEOPS_HOME/current/docker-compose.yml" \
  --profile tunnel \
  down --volumes --remove-orphans
```

Run that command only after revalidating all bounded paths and only when both env files plus the recorded Compose file exist. This removes cloudflared and orphans as well as core services. Then remove the bounded root and state file on success/default cleanup; never infer a Compose project from `docker ps`.

- [ ] **Step 5: Generate a temporary noninteractive answer file**

Create the checked-in fixture with no customer data:

```md
# Readiness pricing policy

For the controlled Guadalajara to Monterrey dry-van request, use the generated
deterministic pricing profile and require no manual approval below MXN 25,000.
```

Create `$E2E_ROOT/onboarding-input` with mode `0700`. Copy each caller-supplied credential into a predictably named `0600` file in that directory, generate a random mock-TMS key into `tms-key`, and never export credential values. Then write `$E2E_ROOT/onboarding-input/answers.json` with mode `0600` using only safe values and container-visible file references:

```bash
INPUT_DIR="$E2E_ROOT/onboarding-input"
install -d -m 0700 "$INPUT_DIR"
install -m 0600 "$E2E_AI_KEY_FILE" "$INPUT_DIR/ai-key"
install -m 0600 "$E2E_TUNNEL_TOKEN_FILE" "$INPUT_DIR/tunnel-token"
install -m 0600 "$E2E_CF_ACCESS_CLIENT_ID_FILE" "$INPUT_DIR/access-client-id"
install -m 0600 \
  "$E2E_CF_ACCESS_CLIENT_SECRET_FILE" \
  "$INPUT_DIR/access-client-secret"
install -m 0600 "$E2E_RESEND_API_KEY_FILE" "$INPUT_DIR/resend-key"
install -m 0600 "$E2E_SAKBE_KEY_FILE" "$INPUT_DIR/sakbe-key"
install -m 0600 "$E2E_EMBEDDING_KEY_FILE" "$INPUT_DIR/embedding-key"
install -m 0600 \
  "$REPO_ROOT/deploy/appliance/tests/fixtures/readiness-knowledge.md" \
  "$INPUT_DIR/readiness-knowledge.md"
openssl rand -hex 32 >"$INPUT_DIR/tms-key"
chmod 0600 "$INPUT_DIR/tms-key"
E2E_TMS_CURL_CONFIG="$E2E_ROOT/tms-curl.conf"
write_curl_bearer_config_from_file \
  "$INPUT_DIR/tms-key" \
  "$E2E_TMS_CURL_CONFIG"
chmod 0600 "$E2E_TMS_CURL_CONFIG"
E2E_ACCESS_CURL_CONFIG="$E2E_ROOT/access-curl.conf"
write_cloudflare_access_config_from_files \
  "$INPUT_DIR/access-client-id" \
  "$INPUT_DIR/access-client-secret" \
  "$E2E_ACCESS_CURL_CONFIG"
chmod 0600 "$E2E_ACCESS_CURL_CONFIG"
E2E_ANSWERS_FILE="$INPUT_DIR/answers.json"
export E2E_ANSWERS_FILE E2E_TMS_CURL_CONFIG E2E_ACCESS_CURL_CONFIG
```

```js
import fs from "node:fs";

const inputPath = "/run/quoteops-onboard-input";
const answers = {
  schema_version: 1,
  ai_provider: {
    provider: process.env.E2E_AI_PROVIDER,
    api_key: { file: `${inputPath}/ai-key` }
  },
  cloudflare: {
    public_hostname: process.env.E2E_PUBLIC_HOSTNAME,
    tunnel_token: { file: `${inputPath}/tunnel-token` },
    access_client_id: { file: `${inputPath}/access-client-id` },
    access_client_secret: { file: `${inputPath}/access-client-secret` }
  },
  activation: {
    authorized_email: process.env.E2E_AUTHORIZED_EMAIL
  },
  tms: {
    mode: "quoteops-tms-http-v1",
    base_url: "http://host.docker.internal:19091",
    api_key: { file: `${inputPath}/tms-key` },
    sample_query: {
      request_id: "MAC-E2E-PROBE",
      origin: {
        city: "Guadalajara",
        state: "Jalisco",
        country: "MX"
      },
      destination: {
        city: "Monterrey",
        state: "Nuevo Leon",
        country: "MX"
      },
      vehicle_profile_id: "T3S3_53_DRYVAN",
      cargo: {
        commodity: "general",
        sector: "industrial",
        weight_kg: 18000
      },
      time_window: {
        from: "2026-01-01",
        to: "2026-12-31"
      },
      max_results: 20
    }
  },
  mailbox: {
    provider: "resend",
    api_key: { file: `${inputPath}/resend-key` },
    intake_address: process.env.E2E_RESEND_INTAKE_ADDRESS,
    from_address: process.env.E2E_RESEND_FROM_ADDRESS
  },
  sakbe: {
    api_key: { file: `${inputPath}/sakbe-key` }
  },
  embeddings:
    process.env.E2E_EMBEDDING_PROVIDER === "gemini"
      ? {
          provider: "gemini",
          model: process.env.E2E_EMBEDDING_MODEL,
          api_key: { file: `${inputPath}/embedding-key` }
        }
      : {
          provider: "openai_compatible",
          model: process.env.E2E_EMBEDDING_MODEL,
          base_url: process.env.E2E_EMBEDDING_BASE_URL,
          api_key: { file: `${inputPath}/embedding-key` }
        },
  knowledge: {
    sources: [{ file: `${inputPath}/readiness-knowledge.md` }],
    consent_external_embedding_transfer: true
  },
  accept_generated_profiles: true,
  accept_default_authorization: true,
  accept_sample_prices: true
};

fs.writeFileSync(
  process.env.E2E_ANSWERS_FILE,
  `${JSON.stringify(answers, null, 2)}\n`,
  { mode: 0o600 }
);
```

Both curl-config writers must reuse the single-line-secret validation and never print values. Run this checked-in helper logic from the acceptance script rather than accepting arbitrary JavaScript. Delete the entire onboarding-input directory immediately after onboarding has copied the validated values into the appliance’s stable files. Keep only the separate `0600` TMS and Access curl configs for authenticated acceptance checks, and delete both before evidence scanning/publication.

- [ ] **Step 6: Exercise the real installation path**

The harness must:

1. start `deploy/appliance/mock-tms/server.mjs` with `MOCK_TMS_HOST=127.0.0.1`, `PORT=19091`, and `MOCK_TMS_TOKEN_FILE="$INPUT_DIR/tms-key"` as a bounded child process;
2. read the staged release manifest with the staging service credential, obtain its digest-pinned multiarch Caddy image, and run a disposable Caddy container that uses `wget` plus a temporary `0600` Docker env file to authenticate `GET http://host.docker.internal:19091/quoteops/v1/health`; fail before onboarding if the container cannot reach the loopback-bound host fixture;
3. fetch the stable bootstrap from `E2E_CONTROL_PLANE_URL`;
4. supply the registration token through `QUOTEOPS_REGISTRATION_TOKEN_FILE`;
5. invoke the bootstrap with `QUOTEOPS_BOOTSTRAP_TEST_MODE=macbook`, `QUOTEOPS_AUTOMATION_MODE=1`, the temporary `QUOTEOPS_HOME`, unique Compose project, `QUOTEOPS_PLATFORM=linux/amd64`, and host argument `--answers-dir "$INPUT_DIR"`;
6. pull the published release images, not build local images;
7. wait for Cloudflare Access to block an unauthenticated request;
8. use a temporary `0600` curl config containing the Access service-token headers to make authenticated public requests.

The bootstrap must support `QUOTEOPS_REGISTRATION_TOKEN_FILE`, forward `"$@"`, and reject a token file not owned by the caller or not mode `0600`. `install.sh` validates and mounts the host answers directory, then the one-shot container receives `--answers-file /run/quoteops-onboard-input/answers.json`; no secret value is passed through the bootstrap/installer process environment or arguments.

The canonical probe repeats the same path inside the actual onboarding container. Map a later connection failure to `docker_desktop_host_gateway_unreachable` in Mac test mode and never widen the listener to `0.0.0.0`.

- [ ] **Step 7: Assert the complete public workflow**

Through `https://$E2E_PUBLIC_HOSTNAME`, using the temporary Access curl config:

```text
GET  /api/health
  ok is true
  product_version equals the release pin

GET  /api/setup-state
  activation.client_id and activation.installation_id match the install pack
  required_steps is []
  tunnel.status is ready

GET  /api/rfqs/:runId
  uses runId from settings/test-rfq.json created during installation
  the original controlled request was:
  {
    "origin_city": "Guadalajara",
    "origin_state": "Jalisco",
    "destination_city": "Monterrey",
    "destination_state": "Nuevo Leon",
    "equipment_request": "caja seca 53",
    "vehicle_profile_id": "T3S3_53_DRYVAN",
    "weight_kg": 18000,
    "commodity": "general",
    "sector": "industrial",
    "value_mxn": 250000,
    "business_unit_id": "general"
  }

  reaches priced/approval-complete state

mock TMS
  authenticated GET http://127.0.0.1:19091/quote-writebacks returns one row
  authenticated POST http://127.0.0.1:19091/quoteops/v1/quotes with the stored
    original write body, excluding mock-only received_at and with reordered keys,
    returns the same result and still one row
  authenticated POST http://127.0.0.1:19091/quoteops/v1/quotes with the same
    quote_id and a changed rate_mxn returns 409

restart
  docker compose --project-name "$COMPOSE_PROJECT_NAME"
    --env-file "$QUOTEOPS_HOME/.env"
    --env-file "$QUOTEOPS_HOME/current/release.env"
    -f "$QUOTEOPS_HOME/current/docker-compose.yml"
    --profile tunnel restart
  preserves the run and setup state

operator
  quoteops status returns ready and the pinned version
```

Do not submit a second RFQ in the acceptance harness: installation already created the single readiness run. Fail on a terminal `failed` state, missing quote, or missing approval decision. Authenticate every mock inspection/replay request with the temporary TMS curl-config file; the inspection route must never be unauthenticated.

The install summary must include:

```json
{
  "ai_validation": {
    "provider": "openrouter",
    "live_request": true,
    "fallback": false
  },
  "mailbox_probe": {
    "provider": "resend",
    "validated": true,
    "idempotent": true
  },
  "knowledge_ingest": {
    "document_count": 1,
    "chunk_count_minimum": 1,
    "external_embedding_consent": true
  }
}
```

For a Gemini run, `provider` is `gemini`. A static copilot fallback, skipped provider call, provider different from `E2E_AI_PROVIDER`, missing mailbox receipt, or zero-document/zero-chunk knowledge result fails acceptance.

- [ ] **Step 8: Write redacted evidence**

Write only these artifacts:

```text
00-environment.json
01-release.json
02-install-summary.json
03-setup-state.json
04-rfq-result.json
05-tms-writeback.json
06-restart-persistence.json
07-final-status.json
```

Before moving them into `docs/evidence/$(date -u +%Y%m%dT%H%M%SZ)-macbook-appliance/`, scan for:

```text
Bearer
TUNNEL_TOKEN
API_KEY
registration_token
CF-Access-Client-Secret
sk-
eyJ
```

If a pattern is present, abort evidence publication and leave the source file only inside the bounded temporary directory for manual inspection.

Also build a temporary `0600` literal-pattern file from every input credential and the registration token, scan all evidence with fixed-string matching, and delete that pattern file before any move. Never print the matching line or secret.

- [ ] **Step 9: Add the disposable Ubuntu 24.04 AMD64 bootstrap gate**

Create `deploy/appliance/tests/ubuntu-vm-bootstrap-acceptance.sh`. It is a separate OS/bootstrap gate before the complete Mac runtime journey, because Mac test mode intentionally skips Ubuntu detection and apt. Require explicit `--run`, Darwin `arm64`, `limactl`, QEMU, HTTPS `E2E_CONTROL_PLANE_URL`, a dedicated unused registration token with a maximum 15-minute TTL in `E2E_UBUNTU_REGISTRATION_TOKEN_FILE` at `0600`, expected client/installation IDs, and:

```text
E2E_UBUNTU_IMAGE_URL
E2E_UBUNTU_IMAGE_SHA256
```

Generate a minimal Lima configuration under a bounded `mktemp -d` `LIMA_HOME` with `vmType: qemu`, `arch: x86_64`, no Docker provisioning, Ubuntu 24.04 cloud-image URL, and `digest: sha256:${E2E_UBUNTU_IMAGE_SHA256}`. Reject a non-64-hex checksum, any image that boots as something other than Ubuntu 24.04/x86_64, and a base VM where `docker` already exists. Give the VM a unique `quoteops-ubuntu-e2e-*` instance name recorded in a `0600` state file; cleanup may stop/delete only that exact instance and bounded Lima root.

Copy—not interpolate—the dedicated token source file and a deliberately invalid, non-secret AI probe file into the VM with owner-only permissions. Invoke the real staging `GET /install/quoteops` bootstrap with the secure token-file automation branch and a bounded answers directory; no repository checkout, bind mount, preinstalled Docker, `QUOTEOPS_BOOTSTRAP_TEST_MODE`, or locally built application image is allowed. Expect onboarding to stop specifically at the live AI validation and assert the fake key was not persisted. Before cleanup, assert:

```text
/etc/os-release is Ubuntu 24.04
uname -m is x86_64
Docker Engine was installed from the signed Docker apt repository
docker.service is enabled and active
docker compose version is >= 2.24.0
/opt/quoteops-v1/releases/<pinned-version> is root-owned and immutable to non-root
/opt/quoteops-v1/current selects that pinned release
/usr/local/bin/quoteops is the stable root-owned executable wrapper
client.env and cloudflare.env are regular root-owned 0600 files
POSTGRES_PASSWORD and the registration token are absent from argv, journal output, and test evidence
the installed release came from the control plane and matches the expected client/installation IDs
```

The harness must redact output, cap boot/bootstrap waits, collect only safe assertions, destroy the VM by default even after failure, and tell the operator to revoke the dedicated staging token immediately if the run ends before activation consumes it; its short TTL remains the fallback. `--keep` is allowed only with a printed exact instance name and cleanup command; invalid/missing state is a non-destructive error. Add `test:appliance:ubuntu-vm` to `package.json`. Its expected terminal line is:

```text
UBUNTU VM BOOTSTRAP ACCEPTANCE: PASS
```

- [ ] **Step 10: Run all local verification before the live acceptance**

Run:

```bash
npm run build
npm test -- --run
bash deploy/appliance/tests/smoke.sh
bash deploy/appliance/tests/lifecycle.sh
npm run test:appliance:ubuntu-vm -- --run
```

Expected: PASS.

- [ ] **Step 11: Run the live MacBook acceptance**

With Docker Desktop running and every preflight input from Step 3 available:

```bash
npm run test:appliance:mac
```

Expected:

```bash
test "$pass_line" = "MACBOOK APPLIANCE ACCEPTANCE: PASS"
test "$public_url_line" = "public_url=https://${E2E_PUBLIC_HOSTNAME}"
[[ "$version_line" =~ ^version=v[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "$evidence_line" =~ ^evidence=/.*-macbook-appliance$ ]]
```

The four emitted lines contain only the actual safe hostname, pinned semver, and absolute redacted evidence path.

- [ ] **Step 12: Clean up safely and support explicit debugging retention**

On success, the script stops only its unique Compose project, removes the bounded temporary root, and retains only the redacted evidence directory. `--keep` may retain the exact temporary root and Compose project for a failed-run investigation, but it must warn that local `client.env` still contains test credentials.

To clean an explicitly retained run, use:

```bash
bash deploy/appliance/tests/macbook-acceptance.sh --cleanup
```

Cleanup must load the deterministic `0600` state file, revalidate every canonical path and both bounded prefixes, resolve and print the exact temporary root and Compose project, stop only that project using the recorded Compose files, remove only that temporary root, and finally delete the state file. A missing/invalid state file is a non-destructive error.

- [ ] **Step 13: Commit documentation and the acceptance harness**

```bash
git add deploy/appliance/tests/ubuntu-vm-bootstrap-acceptance.sh deploy/appliance/tests/macbook-acceptance.sh deploy/appliance/tests/fixtures/readiness-knowledge.md deploy/appliance/README.md deploy/appliance/CONTROL_PLANE.md deploy/appliance/SECRETS.md docs/runbooks/customer-vm-install.md package.json
git commit -m "test(appliance): add MacBook VM acceptance journey"
```

---

### Task 11: Run the Live Chrome Acceptance on Azure, Hostinger Supabase, and Cloudflare

**Files:**
- Create: `docs/runbooks/azure-hostinger-cloudflare-browser-e2e.md`
- Create: `docs/evidence/templates/browser-e2e-report.md`
- Create: `scripts/validate-browser-evidence.mjs`
- Create: `tests/regression/browser-evidence.test.ts`
- Modify: `package.json`
- Create at execution time: `docs/evidence/<UTC_RUN_ID>-azure-hostinger-cloudflare-e2e/report.md`
- Create at execution time: `docs/evidence/<UTC_RUN_ID>-azure-hostinger-cloudflare-e2e/screenshots/*.png`
- Create at execution time: `docs/evidence/<UTC_RUN_ID>-azure-hostinger-cloudflare-e2e/screenshots.json`
- Create at execution time: `docs/evidence/<UTC_RUN_ID>-azure-hostinger-cloudflare-e2e/SHA256SUMS`

**Interfaces:**
- Consumes the user’s existing authenticated Chrome sessions for [Azure Virtual Machines](https://portal.azure.com/#view/Microsoft_Azure_ComputeHub/ComputeHubMenuBlade/~/virtualMachinesBrowse), the user-supplied Hostinger VPS Docker Manager URL, and Cloudflare Dashboard. Keep the account-specific Hostinger URL as a local execution input outside Git and the evidence bundle.
- Consumes one user-approved Azure subscription/resource group/region/VM choice, or an existing non-production Ubuntu 24.04 AMD64 VM selected by the user.
- Consumes the immutable appliance release, one installation pack/token, AI/integration test credentials, and the canonical `quoteops-tms-http-v1` contract from earlier tasks.
- Produces a live Azure QuoteOps installation, an isolated Supabase-backed TMS mock on Hostinger, a test-scoped Cloudflare named tunnel/Access application, and a Spanish Markdown report with Chrome screenshots.
- Produces `npm run evidence:browser:validate -- <absolute-evidence-directory>`.
- Does not use the in-app browser, Appium, headless Chrome, Azure/Hostinger/Cloudflare management APIs or CLIs, Terraform, local SSH, or direct local database connections.

- [ ] **Step 1: Write the failing browser-evidence contract test**

Create `tests/regression/browser-evidence.test.ts` around a temporary fixture and assert that validation fails when:

```text
report.md is absent
a required screenshot is absent or not referenced
screenshots.json has an unknown/missing field
a screenshot path is absolute or escapes the evidence directory
SHA256SUMS does not match the PNG bytes
report/screenshots.json contains Bearer, API keys, tunnel tokens, service secrets,
subscription IDs, tenant IDs, database passwords, or source credential filenames
the report omits commit SHA, release version, image digests, UTC run ID, result,
resource-retention state, or a screenshot assertion
```

Use safe fake values only. The validator does not claim OCR-based secrecy; pixel secrecy is enforced by clipped capture plus mandatory visual review in Step 10.

- [ ] **Step 2: Run the evidence test to verify RED**

Run:

```bash
npx vitest run tests/regression/browser-evidence.test.ts
```

Expected: FAIL because the report template and validator do not exist.

- [ ] **Step 3: Implement the report template and evidence validator**

Create `docs/evidence/templates/browser-e2e-report.md` in Spanish with these sections:

```text
# Aceptación E2E en Azure, Hostinger y Cloudflare
## Resultado ejecutivo
## Release y trazabilidad
## Entorno Azure
## Mock TMS en Hostinger/Supabase
## Cloudflare Tunnel y Access
## Onboarding de QuoteOps
## Cotización y writeback
## Reinicio y persistencia
## Evidencia visual
## Hallazgos e incidencias
## Seguridad y datos omitidos
## Recursos retenidos y limpieza pendiente
```

Implement `scripts/validate-browser-evidence.mjs` with an explicit manifest schema, bounded relative paths, PNG signature checks, SHA-256 verification, Markdown-link verification, exact required screenshot IDs, and fixed-string secret-pattern scanning over textual artifacts. Add `evidence:browser:validate` to `package.json`. It must print only a pass/fail summary and filenames, never matching lines.

- [ ] **Step 4: Preflight the authenticated Chrome-only workflow**

From this MacBook, connect to the user’s existing Chrome session and open the three supplied portals plus Cloudflare Dashboard in separate tabs. Do not inspect cookies, local storage, saved passwords, profiles, or session files. If any portal requires authentication, stop that portal’s work and ask the user to sign in in Chrome; do not substitute another browser or an API.

Write a safe `run.json` before any mutation:

```json
{
  "run_id": "20260730T120000Z",
  "commit_sha": "40 lowercase hex",
  "release_version": "v0.2.0",
  "azure_resource_name": "quoteops-e2e-20260730T120000Z",
  "hostinger_project_name": "quoteops-tms-e2e-20260730T120000Z",
  "cloudflare_tunnel_name": "quoteops-e2e-20260730T120000Z",
  "public_hostname": "quoteops-e2e.example.com",
  "retention": "retain_until_user_review"
}
```

The report may contain resource display names and the public test hostname, but not subscription/tenant/account/zone IDs, raw VPS identifiers, private/public IP addresses, usernames, personal email addresses, or credentials. Record those sensitive operational values only in temporary `0600` files outside `docs/evidence/`.

- [ ] **Step 5: Select or create the Azure Ubuntu VM through Chrome**

Use only the Azure Portal VM page in Chrome. Prefer an existing, user-designated non-production VM. If a new paid VM is required, pause on the final review screen and obtain the user’s approval of subscription, region, size, disk, and displayed cost before clicking **Create**.

The target must be Ubuntu Server 24.04 LTS, `x86_64`, at least 4 vCPU, 8 GiB RAM, 80 GiB disk, outbound HTTPS/DNS/NTP, and no application ingress port. Use Azure’s browser-visible Bastion/web SSH experience for terminal work; do not use local SSH, Azure CLI, ARM, or Run Command automation. Assign the UTC run ID in the resource name/tags and do not modify another VM.

Capture clipped Chrome screenshots only after sensitive blades are closed:

```text
01-azure-vm-overview.png
  proves the test VM is Running and shows only safe resource name/region

02-azure-ubuntu-preflight.png
  proves Ubuntu 24.04, x86_64, resources, and absence/presence of Docker as expected
  from the browser terminal, with hostname/user/IP omitted
```

- [ ] **Step 6: Create the isolated Supabase-backed TMS mock through Hostinger Chrome UI**

Open the supplied Hostinger Docker Manager URL in Chrome and inventory the existing Supabase stack without changing existing projects. Create one isolated project/stack or, when the self-hosted UI models isolation as a database/schema, create `quoteops_tms_e2e_<UTC_RUN_ID>` plus a dedicated least-privilege role. Do not use customer or production data.

Deploy the repository’s canonical mock-TMS service as a digest-pinned container through the Hostinger web UI and back it with the isolated Supabase database/schema. The public HTTPS test origin must implement:

```text
GET  /quoteops/v1/health
POST /quoteops/v1/historical-quotes/search
GET  /quoteops/v1/units
GET  /quoteops/v1/unit-performance
GET  /quoteops/v1/availability-zones
POST /quoteops/v1/quotes
```

Generate one run-scoped Bearer credential, enter it only into secret fields, and never capture its reveal screen. Seed deterministic synthetic Guadalajara–Monterrey history, units, performance, availability zones, and an empty quote-writeback table. Run the OpenAPI conformance suite from the Azure browser terminal against this HTTPS origin before onboarding.

Capture:

```text
03-hostinger-supabase-stack.png
  shows the isolated test project/service healthy without VPS/account identifiers

04-tms-seed-counts.png
  shows only table names and synthetic row counts

05-tms-contract-pass.png
  shows the six-endpoint conformance result and no headers/body secrets
```

- [ ] **Step 7: Install QuoteOps from the Azure browser terminal**

In Azure’s Chrome-based terminal, execute the exact one-command installer displayed by the control plane. Paste the registration token only into the hidden `/dev/tty` prompt. The VM must download the immutable release and must not clone or mount this repository.

Complete AI-first onboarding with the real test provider, activation identity, the Hostinger TMS HTTPS base URL, Cloudflare inputs from Step 8, mailbox, SAKBÉ, embeddings, units, pricing, and the synthetic knowledge fixture. Never place credentials in terminal commands, screenshots, shell history, or the report. If the Cloudflare prerequisite is not ready, allow `onboarding_pending`, configure it in Step 8, then run:

```bash
sudo quoteops onboard --resume
```

Capture:

```text
06-azure-install-version.png
  shows safe installer completion, pinned release version, and client/installation IDs

07-quoteops-onboarding-ready.png
  shows the public QuoteOps setup UI with required_steps empty
```

- [ ] **Step 8: Configure the test-scoped Cloudflare tunnel through Chrome**

Use the user’s authenticated Cloudflare Dashboard session in Chrome. Create a remotely managed named tunnel, public hostname route to `http://caddy:80`, Access application, human-user allow policy, and a short-lived Service Auth token/policy, all named with the same UTC run ID. Do not request or use a Cloudflare account API token.

Reveal/copy the tunnel and Service Auth secrets only into the Azure browser terminal’s hidden onboarding prompts or temporary `0600` source files; never take a screenshot while a secret is visible. Require:

```text
cloudflared_tunnel_ha_connections > 0
anonymous public request is denied or redirected by Cloudflare Access
authenticated public /api/setup-state returns the exact release/client/installation
human Chrome session can reach the QuoteOps UI through Access
```

Capture:

```text
08-cloudflare-tunnel-healthy.png
  shows the run-scoped tunnel Healthy and safe hostname only

09-cloudflare-access-policy.png
  shows policy names/actions without account IDs, emails, token IDs, or secrets

10-cloudflare-protected-origin.png
  shows the QuoteOps UI reached through Cloudflare Access
```

- [ ] **Step 9: Execute the visible end-to-end quote journey in Chrome**

Use the QuoteOps web UI in Chrome—not API-only assertions—to:

1. confirm onboarding is ready and the TMS probe is green;
2. submit the controlled Guadalajara-to-Monterrey dry-van request from Task 8;
3. observe route, deterministic price, approval state, and final quote;
4. open the Hostinger/Supabase UI and confirm exactly one matching writeback;
5. retry the same quote writeback and confirm idempotence;
6. restart the QuoteOps Compose stack from the Azure browser terminal;
7. reload the public UI through Cloudflare and confirm the run/setup state persists.

Application HTTP calls between QuoteOps, the canonical TMS, AI, SAKBÉ, embeddings, and Cloudflare are expected product behavior; the prohibition concerns out-of-band infrastructure management automation.

Capture:

```text
11-quote-request.png
12-quote-result.png
13-supabase-writeback.png
14-post-restart-ready.png
```

Use synthetic values and crop each screenshot to the smallest UI region that proves the named assertion.

- [ ] **Step 10: Build and visually review the screenshot report**

Write `report.md` from the template. For every screenshot, include a caption, UTC timestamp, visible hostname, expected assertion, actual result, and PASS/FAIL. Create `screenshots.json` with:

```ts
type BrowserScreenshotEvidence = {
  id: string;
  file: string;
  captured_at: string;
  browser: "chrome";
  surface: "azure" | "hostinger" | "cloudflare" | "quoteops";
  assertion: string;
  result: "pass" | "fail";
  sensitive_ui_excluded: true;
};
```

Visually inspect every PNG at original resolution before publication. A screenshot containing any credential, email, subscription/tenant/account/zone ID, IP address, database connection string, terminal history, or unrelated customer resource must be deleted and recaptured with a safe clip; do not blur it and keep the unsafe original. Generate `SHA256SUMS`, run:

```bash
npm run evidence:browser:validate -- \
  "$PWD/docs/evidence/<UTC_RUN_ID>-azure-hostinger-cloudflare-e2e"
```

Expected: `BROWSER E2E EVIDENCE: PASS`.

- [ ] **Step 11: Retain resources for review and commit only the reusable test machinery**

The report must end with an exact inventory of the Azure VM/resource group, Hostinger project/schema/container, Cloudflare tunnel/hostname/Access application/service token, and their state as `retained_pending_user_review`. Do not delete or reuse them in another run. Recommend immediate rotation/revocation of disposable credentials after review.

Commit only the reusable runbook, template, validator, tests, and package script:

```bash
git add docs/runbooks/azure-hostinger-cloudflare-browser-e2e.md docs/evidence/templates/browser-e2e-report.md scripts/validate-browser-evidence.mjs tests/regression/browser-evidence.test.ts package.json
git commit -m "test(appliance): add live browser acceptance evidence"
```

Keep the run-specific report and screenshots uncommitted until the user inspects them and explicitly approves publication or cleanup.

---

## Final Verification Gate

Run from a clean worktree at the release commit:

```bash
npm ci
npm run build
npx vitest run \
  packages/connectors/tests/tms-adapter.test.ts \
  tests/regression/mock-tms-http.test.ts \
  tests/regression/tms-openapi-contract.test.ts \
  tests/regression/browser-evidence.test.ts \
  apps/api/tests/tmsProbe.test.ts
npm test -- --run
bash deploy/appliance/tests/smoke.sh
bash deploy/appliance/tests/lifecycle.sh
npm run test:appliance:ubuntu-vm -- --run
SOURCE_DATE_EPOCH="$(git show -s --format=%ct HEAD)" \
  npm run package:appliance -- \
  --version "$RELEASE_VERSION" \
  --git-sha "$(git rev-parse HEAD)" \
  --agent-digest "$QUOTEOPS_AGENT_DIGEST" \
  --api-digest "$QUOTEOPS_API_DIGEST" \
  --web-digest "$QUOTEOPS_WEB_DIGEST" \
  --postgres-image "$QUOTEOPS_POSTGRES_IMAGE" \
  --redis-image "$QUOTEOPS_REDIS_IMAGE" \
  --caddy-image "$QUOTEOPS_CADDY_IMAGE"
npm run test:appliance:mac
```

After the automated gate passes, execute Task 11 through the authenticated Chrome session and validate its resulting evidence directory:

```bash
test -n "${BROWSER_E2E_EVIDENCE_DIR:-}"
npm run evidence:browser:validate -- "$BROWSER_E2E_EVIDENCE_DIR"
```

The implementation is complete only when:

- the single terminal command reaches guided onboarding without a second manual Compose command;
- invalid AI credentials never persist;
- production Compose exposes no host ports;
- Cloudflare Tunnel has active connections and Cloudflare Access blocks anonymous traffic;
- activation is bound to the expected client/installation;
- the canonical TMS probe validates real responses and quote writeback is idempotent;
- `/api/setup-state.required_steps` is empty;
- installation and update use one immutable release;
- a token issued before a newer control-plane deployment still renders its exact frozen install-pack overlay and pinned release;
- a failed update rolls back to the previous running release;
- backup/restore checksums and identity gates pass;
- the disposable Ubuntu 24.04 AMD64 VM proves the real apt/Docker, `/opt`, ownership, and stable-wrapper bootstrap path;
- the deterministic MacBook journey uses published images and the real public hostname;
- Chrome on this Mac proves the one-command installation on the selected Azure Ubuntu VM without using the in-app browser or infrastructure-management APIs/CLIs;
- the isolated Hostinger/Supabase project passes all six TMS endpoints and contains exactly one idempotent quote writeback;
- the user’s test-scoped Cloudflare tunnel is healthy, Access blocks anonymous traffic, and the public QuoteOps UI survives restart;
- the Spanish report references every required Chrome screenshot, records PASS/FAIL honestly, and identifies all retained resources;
- textual evidence scanning and visual review find no secret or unrelated infrastructure material.

## Explicitly Deferred Work

- A PostgreSQL mirror/sync worker for normalized TMS history.
- OAuth support for customer TMS APIs.
- API/CLI-driven automatic creation or mutation of the client’s Cloudflare account, tunnel, DNS, or Access policy; Task 11 permits only the isolated, user-visible Chrome workflow explicitly requested for live acceptance.
- Additional AI providers beyond OpenRouter and Gemini.
- Native ARM64 QuoteOps application images; the MacBook acceptance uses explicit AMD64 emulation.
- Splitting PostgreSQL, Redis, API, agent, or web onto separate machines.
