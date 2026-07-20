# QuoteOps Human Simulator Repair Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Use `superpowers:test-driven-development` for every behavior change and `superpowers:verification-before-completion` before claiming success.

**Goal:** Repair provider-aware onboarding readiness and package transport, then prove a clean customer installation on the existing isolated VPS with Resend, NVIDIA NIM, SAKBÉ, and a SAP-like HTTP TMS simulation.

**Architecture:** Reuse production runtime configuration and credential predicates as the single source of truth. Extend the installer at the asset boundary rather than adding a new deployment path. Keep the human simulator as a non-secret client fixture plus a read-only verification script; inject live credentials only at installation time.

**Tech Stack:** TypeScript, Vitest, Bash, Docker Compose, Express, Resend Receiving API, NVIDIA NIM OpenAI-compatible API, INEGI SAKBÉ, Hostinger VPS/control plane.

---

## Task 1: Provider-aware setup and heartbeat readiness

**Files:**

- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/tests/api.test.ts`

### Step 1: Write the failing API tests

Add a test agent config using `provider: openai`, `api_key_env: NVIDIA_NIM_API_KEY`, and `mailbox.provider: resend`. Assert that a fully configured environment with `NVIDIA_NIM_API_KEY`, `RESEND_API_KEY`, `MAILBOX_USER`, and SAKBÉ evidence does not require `configure_secrets` or `connect_mailbox` and reports `ai_key_status: configured` to the control plane.

Add negative assertions that removing `NVIDIA_NIM_API_KEY` or `RESEND_API_KEY` keeps the exact corresponding readiness step pending. Cover a malformed/missing agent config as fail-closed.

### Step 2: Verify RED

Run:

```bash
npx vitest run apps/api/tests/api.test.ts
```

Expected: the NVIDIA/Resend readiness case fails because the current hard-coded gates ignore both keys.

### Step 3: Implement the minimum provider-aware gate

Load `AgentRuntimeConfig` through `loadAgentRuntimeConfig`. Reuse `mailboxCredentialsPresent` for mailbox readiness. Evaluate the configured model and embeddings key env names; preserve no-key behavior for deterministic/CLI models. Inspect the loaded TMS adapter for credential references instead of requiring an arbitrary TMS key. Make local setup and heartbeat call the same model credential predicate.

Any missing or malformed configured file must return not-ready without crashing the endpoint.

### Step 4: Verify GREEN

Run the focused API test command again. Expected: all API tests pass.

### Step 5: Commit

```bash
git add apps/api/src/index.ts apps/api/tests/api.test.ts
git commit -m "fix(api): derive setup readiness from provider config"
```

## Task 2: Install strict TMS mapping assets

**Files:**

- Modify: `deploy/appliance/install.sh`
- Modify: `deploy/appliance/tests/smoke.sh`
- Modify: `deploy/appliance/README.md`

### Step 1: Write the failing installer smoke checks

Extend the smoke fixture with a strict mapping JSON. Invoke `install.sh --tms-mapping-config`. Assert:

- help exposes the new flag;
- the file is copied to `connectors/tms-mapping.json`;
- `.env` contains the container path `QUOTEOPS_TMS_MAPPING_CONFIG_PATH`;
- the target is mode `0600`;
- overwrite guards behave consistently with agent/TMS-adapter assets.

### Step 2: Verify RED

Run:

```bash
bash deploy/appliance/tests/smoke.sh
```

Expected: the new flag is unknown or the mapping assertions fail.

### Step 3: Implement the minimum installer change

Add argument parsing, validation, absolute path resolution, target guarding, copy/default behavior, environment wiring, permissions, and final output for the mapping file. Preserve all existing CLI behavior.

### Step 4: Verify GREEN

Run the smoke script again. Expected: pass, including existing install guards.

### Step 5: Commit

```bash
git add deploy/appliance/install.sh deploy/appliance/tests/smoke.sh deploy/appliance/README.md
git commit -m "feat(appliance): install explicit TMS mapping config"
```

## Task 3: Add the reproducible human-simulator client fixture

**Files:**

- Create: `deploy/appliance/examples/human-simulator/README.md`
- Create: `deploy/appliance/examples/human-simulator/client-manifest.yaml`
- Create: `deploy/appliance/examples/human-simulator/connectors/agent/agent-config.yaml`
- Create: `deploy/appliance/examples/human-simulator/connectors/tms-adapter.yaml`
- Create: `deploy/appliance/examples/human-simulator/connectors/tms-mapping.json`
- Create: `deploy/appliance/examples/human-simulator/connectors/knowledge/operating-policy.md`
- Create: `deploy/appliance/examples/human-simulator/fixtures/rfq-email.txt`
- Create: `deploy/appliance/examples/human-simulator/verify.sh`
- Modify: `deploy/appliance/tests/smoke.sh`

### Step 1: Write failing fixture contract checks

Add smoke checks that require every fixture file, parse the manifest/agent/TMS configs through production loaders, verify `client_id: RESAUX`, allowed requester domain `resaux.io`, model key env `NVIDIA_NIM_API_KEY`, mailbox provider `resend`, explicit TMS mapping, staged knowledge, and an executable verifier. Assert the fixture contains no strings matching committed secret/token formats.

### Step 2: Verify RED

Run the smoke script. Expected: fixture contract check fails because the directory does not exist.

### Step 3: Add the minimal non-secret fixture

Create the client pack and runbook. Use NVIDIA's OpenAI-compatible base URL, Resend mailbox provider, the SAP-like mock TMS HTTP contract, a valid strict mapping JSON, and synthetic RFQ content. The verifier accepts an appliance base URL, queries public operational endpoints, emits redacted JSON, and exits non-zero unless health is good and `required_steps` is empty.

Do not include an actual Resend receiving address until it has been confirmed live; the runbook must require injecting only a verified-domain address into `MAILBOX_USER`/`MAILBOX_FROM`.

### Step 4: Verify GREEN

Run the smoke script and focused schema/config tests. Expected: pass.

### Step 5: Commit

```bash
git add deploy/appliance/examples/human-simulator deploy/appliance/tests/smoke.sh
git commit -m "test(appliance): add Resend NIM human simulator pack"
```

## Task 4: Integration verification and release image

**Files:**

- Modify only if a test exposes a scoped defect in Tasks 1–3.

### Step 1: Run the complete verification set

```bash
npm test
npm run build
bash deploy/appliance/tests/smoke.sh
git diff --check
```

Expected: all pass with no hidden skips attributable to the repair.

### Step 2: Independent final review

Give a final reviewer the design, implementation plan, commit range, focused test outputs, full-suite output, and `git diff --stat`. Resolve every critical/high finding with a new RED/GREEN cycle and rerun the complete set.

### Step 3: Build and publish immutable images

Choose the next non-conflicting semantic tag, build the `agent`, `api`, and `web` images from the reviewed commit, publish to `ghcr.io/alejandroc-bit`, and record digests. Never overwrite `v0.1.2`.

## Task 5: Generate a fresh cloud install pack

**Files:**

- Create: `docs/evidence/2026-07-19-vps-human-simulator/00-run-manifest.md`
- Create: `docs/evidence/2026-07-19-vps-human-simulator/01-client-pack-redacted.json`

### Step 1: Confirm external prerequisites without leaking values

Inspect `/Users/alejandro/inducta/KEYS.md` for the named Resend, NVIDIA NIM, and SAKBÉ key entries and validate each with a provider-safe call. In Resend, identify the actually verified receiving domain; fail closed if no domain is verified.

### Step 2: Create client and install pack

In the live control plane, use the existing tenant `RESAUX` already authorized for `alejandro@resaux.io`; generate a fresh, one-use install pack and record a redacted projection. The fresh-install simulation uses a new registration token and installation id without duplicating the tenant or rewriting another email. Do not persist the registration token in evidence.

### Step 3: Complete mailbox authorization

Search Alejandro's mailbox for the new QuoteOps authorization email, open the matching message, verify client/email/destination, and follow the authorization link. Record timestamps and outcome only; redact the URL/token.

## Task 6: Reset only the isolated VPS project and reinstall

**Files:**

- Create: `docs/evidence/2026-07-19-vps-human-simulator/02-vps-reset-and-install.md`

### Step 1: Resolve and record the destructive target

Confirm VM id `1807611`, project `quoteops_vpse2e`, Compose path, container list, and install directory. Record unrelated projects that must remain untouched.

### Step 2: Remove the old simulation

Stop/delete only `quoteops_vpse2e`, remove only its resolved installation data, and confirm all unrelated Hostinger projects remain present and running.

### Step 3: Install from zero

Install the fresh `RESAUX` pack using the immutable image tag, new installation id, verified Resend address, `NVIDIA_NIM_API_KEY`, live SAKBÉ key, and the mock TMS HTTP endpoint/mapping. Set secret files to `0600`; do not print values.

### Step 4: Activate and verify baseline

Activate as `alejandro@resaux.io`, start all services, and verify health, license, provider-aware setup steps, and image digests before sending an RFQ.

## Task 7: Execute and document the human simulator

**Files:**

- Create: `docs/evidence/2026-07-19-vps-human-simulator/03-human-simulator-results.md`
- Create: `docs/evidence/2026-07-19-vps-human-simulator/04-final-state-redacted.json`

### Step 1: Send one synthetic RFQ as the customer

From `alejandro@resaux.io`, send the fixture RFQ to the verified Resend receiving address. The recipient must be the isolated test inbox and the content must contain no real customer data.

### Step 2: Observe every system boundary

Capture redacted evidence for Resend receiving/processing, NVIDIA extraction, SAKBÉ route, priced workflow result, approval when required, mock-TMS writeback, and control-plane heartbeat.

### Step 3: Run the fixture verifier

Run `verify.sh` against the VPS endpoint and save its redacted output. Verify `/api/setup-state.required_steps` is empty and all containers are healthy.

### Step 4: Final security and requirement audit

Search the evidence directory and Git diff for key/token patterns. Confirm no secrets, raw authorization URLs, or mailbox contents are committed. Map each requested requirement to a concrete artifact and distinguish simulated SAP compatibility from a real SAP integration.
