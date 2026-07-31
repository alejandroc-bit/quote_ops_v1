# Task 8 implementation report

## Status

PASS. Guided installation now joins license activation, post-restart test-RFQ
readiness, Cloudflare Tunnel/Access readiness, final verification, and safe
local resume into one idempotent completion path.

## What I implemented

- Added the `license_activation` onboarding phase immediately after
  `ai_provider`.
  - Uses only `http://quoteops-api:8080`.
  - Rejects an alternate `QUOTEOPS_ONBOARD_API_URL`.
  - Sends only the authorized email; it never accepts or prints a registration
    token.
  - Uses a strict activation response and maps network/timeout failures to the
    safe `activation_unreachable` code.
  - Reuses an already valid license without another activation mutation.
- Made control-plane activation retry-safe after response loss.
  - A used token returns the same deterministic license only when the same
    client/installation is already active and licensed.
  - A used token without a persisted license returns a safe conflict.
  - Expiry applies only before first token consumption.
- Added the final `test_rfq` onboarding phase.
  - Uses the exact T3S3 readiness request and a versioned request hash.
  - Derives one deterministic run ID per installation.
  - Atomically writes intent before mutation, GETs first on every run/resume,
    POSTs only on 404, and polls for a passing priced workflow.
  - A complete receipt is trusted only when its hash matches and the API still
    reports `APPROVED`, no approval requirement, route evidence, and completed
    writeback semantics.
  - Corrupt/mismatched receipts fail closed. Review-required runs remain
    pending.
- Made `POST /api/playground/rfqs` idempotent for deterministic readiness runs.
  - Structurally identical reuse returns the existing run.
  - A conflicting request for the same run ID returns 409.
  - The request fingerprint is retained on queued, successful, and failed
    workflow states without adding fields to the strict raw-RFQ schema.
- Added safe Cloudflare setup state.
  - Reports only provider, required flag, safe status, public hostname, and
    check timestamp.
  - Requires valid config, token presence, positive internal HA connections,
    Cloudflare-specific unauthenticated Access denial/redirect evidence, and a
    matching authenticated-origin receipt for release/client/installation.
  - Missing/mismatched authenticated-origin evidence reports
    `pending_manual_public_validation`.
  - Timeout/network failures report `unreachable`; bodies, headers, metrics,
    tokens, and env names are not returned.
  - `connect_cloudflare` now participates in local required steps while the
    minimal heartbeat remains aggregate-only.
- Updated the client setup wizard with the exact “Publicar con Cloudflare”
  copy, safe hostname/status display, and compatibility for older setup-state
  payloads without a tunnel field.
- Completed guided install orchestration.
  - Starts core services, waits for internal health, runs onboarding through
    knowledge, restarts core services, runs only `test_rfq`, starts
    `cloudflared`, runs `verify-install.sh`, and prints the public URL only
    after success.
  - Any interrupted/external failure preserves release/data and exits 20 with:
    `sudo quoteops onboard --resume`.
  - Resume validates an exact physical SemVer release plus stored identity,
    skips archive/token handling, and repeats the completion sequence.
  - The `quoteops onboard` wrapper removes one optional user-facing
    `--resume` and forwards remaining arguments to `install.sh`.
- Added bounded Mac acceptance input support.
  - `--answers-dir` is accepted only in Mac acceptance automation under the
    bounded physical test root.
  - Host input directory must be 0700; `answers.json` and every direct
    `SecretFileRef` target must be regular non-symlink 0600 files owned by the
    operator or root.
  - A temporary Compose override binds only that canonical directory,
    read-only, into only `quoteops-onboard`, with acceptance mode scoped to that
    service.
  - One-shot runs use `-T` and only the fixed container-side answers path.
  - Override and host inputs are removed at their required boundaries, and
    production env/secret/release/Compose files remain acceptance-free.
  - Smoke contains a real Docker bind branch that records host and container
    observed UIDs and validates the known read-only mount without comparing
    those UIDs.
- Locked the generated v0.2.0 install-pack defaults to business unit `general`,
  profile `T3S3_53_DRYVAN`, and deterministic profitability margins. The
  install-pack acceptance fixture now supplies a deterministic Docker-volume
  probe instead of depending on the developer machine's daemon state.
- Added installer rendering assertions proving `--guided` and `"$@"` remain in
  the downloaded installer, so `--answers-dir` reaches host-side installation.

## TDD evidence

### RED

- Onboarding suite failed to load because
  `licenseActivationStep.ts` did not exist.
- Tunnel setup-state tests failed because `buildLocalSetupState`,
  `TunnelReadinessProbe`, and `connect_cloudflare` were absent.
- Portal UI test failed because “Publicar con Cloudflare” was absent.
- Control-plane activation retry returned 403 instead of 200 after the first
  successful activation response was discarded.
- Deterministic Playground conflict returned 202 instead of 409.
- Appliance smoke failed because `quoteops onboard --resume` did not execute
  the required core/onboard/restart/test/tunnel/verify sequence.

### GREEN

- Exact focused Task 8 command:
  - 4 test files passed.
  - 148 tests passed.
- Appliance smoke:
  - Installer/wrapper/smoke shell syntax passed.
  - `smoke.sh: ok`.
- Production build:
  - TypeScript project build passed.
  - Client portal and control-plane Vite builds passed.
- Full repository:
  - 50 test files passed.
  - 536 tests passed.
- `git diff --check` passed.

## Files changed

- `apps/api/src/onboard/licenseActivationStep.ts`
- `apps/api/src/onboard/testRfqStep.ts`
- `apps/api/src/onboard/cli.ts`
- `apps/api/src/index.ts`
- `apps/api/tests/onboarding-flow.test.ts`
- `apps/api/tests/api.test.ts`
- `apps/control-plane-api/src/index.ts`
- `apps/control-plane-api/tests/control-plane-api.test.ts`
- `apps/control-plane/tests/install-pack-install.test.ts`
- `apps/web/src/api/quoteOpsApi.ts`
- `apps/web/src/pages/clientSetupWizard.tsx`
- `apps/web/tests/portalUi.test.tsx`
- `deploy/appliance/install.sh`
- `deploy/appliance/quoteops.sh`
- `deploy/appliance/tests/smoke.sh`

## Self-review

- Fixed a resume control-flow bug found by smoke: the `if` construct had
  discarded the guided sequence's exit 20 before cleanup. The function now
  captures status in the `else` branch and returns it after cleanup.
- Kept the Playground fingerprint out of the strict raw-RFQ payload after the
  full API suite showed that an added raw field caused workflow failure.
- Qualified browser `Response` as `globalThis.Response` to avoid the Express
  type collision found by the production build.
- Corrected the Playground response field from nonexistent `total_mxn` to
  `base_rate_mxn`.
- Confirmed no acceptance setting persists in production env, secret, release,
  or Compose state and no credential value/filename is emitted in the
  acceptance command trace.
- Confirmed failures do not start the tunnel or final verification.

## Concern

The real Docker Desktop bind/UID observation branch is implemented but could
not execute in this worktree because the Docker daemon and local
`alpine:3.20` image were unavailable. Smoke reported that skip explicitly.
All host-side path, ownership, mode, symlink, fixed-mount, read-only override,
non-TTY, cleanup, and secret-redaction checks executed and passed.

## Fix Round 1

### Status

All three Important review findings are fixed with regression coverage.

### Findings addressed

- Broke the first-install Cloudflare readiness deadlock without weakening the
  gate. The verifier temporarily tolerates only `connect_cloudflare`, validates
  the authenticated public origin, writes the identity-bound receipt, then
  re-fetches internal setup state and requires an empty `required_steps` array.
  Every other pending step and every anonymous public 200 remain fail-closed.
- Restricted container-side `--answers-file` to explicit Mac acceptance mode
  and the exact `/run/quoteops-onboard-input/answers.json` path. Before any
  credential or input contents are read, the container now requires the fixed
  physical 0700 mount and direct 0600 regular files owned by root or the
  invoking container user, rejects symlinks, and verifies canonical
  containment plus open-path inode identity for the answers file and every
  referenced input. The ordinary Task 5 parser remains unchanged, and the host
  preflight checks remain intact.
- Installed EXIT cleanup traps before either acceptance override creation path.
  Cleanup removes only the override created by the current installer process
  and guarded installer temp files; it never removes the host-owned answers
  directory or its inputs.

### TDD evidence

#### RED

- Fresh Cloudflare verification failed while setup reported only
  `connect_cloudflare`.
- A non-acceptance invocation and unsafe acceptance paths/files reached the
  ordinary answers parser because no container preflight existed.
- A 0755 acceptance root was accepted by the initial container preflight.
- An injected `jq` failure after partially creating the Compose override left
  `.onboard-acceptance.*.json` behind.

#### GREEN

- Fresh Cloudflare verification observes
  `receipt=absent / required_steps=["connect_cloudflare"]`, validates the
  protected origin, writes the receipt, then observes
  `receipt=present / required_steps=[]`. A non-Cloudflare pending step exits 17
  without writing a receipt or contacting the public origin.
- Acceptance tests reject missing acceptance mode, alternate paths, widened
  mount permissions, world-readable files, symlinked answers/references, and
  references outside the fixed mount.
- Smoke injects failures during override creation and core startup; both remove
  the process-owned override, preserve host inputs, and preserve the guided
  exit-20 contract where applicable.

### Verification

- Exact focused Task 8 command: 4 files passed, 155 tests passed.
- Appliance smoke: `smoke.sh: ok`.
- Production build: TypeScript project build and both Vite builds passed.
- Full repository: 50 files passed, 543 tests passed.
- Installer, verifier, wrapper, and smoke shell syntax passed.
- `git diff --check` passed.

### Files changed

- `apps/api/src/onboard/cli.ts`
- `apps/api/src/onboard/onboardingFlow.ts`
- `apps/api/tests/onboarding-flow.test.ts`
- `deploy/appliance/install.sh`
- `deploy/appliance/verify-install.sh`
- `deploy/appliance/tests/smoke.sh`

### Concern

The real Docker Desktop bind/UID observation branch still could not run because
the Docker daemon and local `alpine:3.20` image were unavailable. Smoke reported
the skip explicitly. The host-side acceptance boundary, container preflight,
fixed read-only override shape, failure cleanup, verifier state transition, and
all repository tests executed and passed.
