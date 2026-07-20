# QuoteOps Human Simulator Repair — Design

## Context

The existing `quoteops_vpse2e` installation on VPS `1807611` is running the released `v0.1.2` images, but its setup screen remains partially pending even though the agent runtime already supports the requested providers. The VPS exposed a repository-level mismatch:

- the agent accepts an OpenAI-compatible NVIDIA NIM model through `model.api_key_env`, but API readiness only recognizes a fixed list of model key names;
- mailbox intake accepts Resend through `RESEND_API_KEY`, but API readiness only accepts IMAP password or OAuth refresh-token credentials;
- HTTP TMS installations need a strict TMS mapping file, but `install.sh` cannot transport that file or publish its runtime path;
- the existing E2E fixture is not a reproducible customer journey for `alejandro@resaux.io`, Resend, NVIDIA NIM, SAKBÉ, and the SAP-like HTTP TMS simulation.

This design repairs those product seams and then validates the result by deleting only the isolated `quoteops_vpse2e` project and reinstalling it from a newly generated client package.

## Goals

1. Make setup readiness derive required credentials from the mounted agent and TMS configuration instead of hard-coded provider names.
2. Keep all checks fail-closed when a config is missing, malformed, or names an absent environment variable.
3. Let the appliance installer carry a strict TMS mapping file into the mounted connectors directory.
4. Add a non-secret, reproducible human-simulator client fixture for `alejandro@resaux.io` using:
   - a verified Resend receiving domain from the connected account;
   - NVIDIA NIM as the LLM through the OpenAI-compatible runtime;
   - live SAKBÉ route resolution;
   - the HTTP mock TMS as a SAP-contract simulator.
5. Produce a redacted evidence bundle covering client creation, install-pack generation, mailbox authorization, clean VPS installation, intake, extraction, SAKBÉ routing, pricing, approval/writeback, heartbeat, and final setup state.

## Non-goals

- Implementing a vendor-specific SAP connector or claiming certification against a real SAP tenant.
- Changing unrelated VPS projects (`traefik`, `supabase`, Paperclip, Hermes) or the other Hostinger VM.
- Committing provider keys, registration tokens, licenses, mailbox contents, or customer data.
- Reworking pricing logic, the quote workflow, or the cloud control-plane data model.

## Design

### 1. Provider-aware readiness

`buildLocalSetupState` loads the same `AgentRuntimeConfig` used by the agent. The secret gate evaluates the exact environment variable named by `model.api_key_env` when the model provider requires a key. Deterministic and CLI-backed models do not require a hosted-model key. If an embeddings block is configured, its `api_key_env` is required; if embeddings are intentionally disabled, no phantom embedding key is required.

Mailbox readiness reuses `mailboxCredentialsPresent` from `@quoteops/agent`. Resend therefore requires `MAILBOX_USER + RESEND_API_KEY`; password IMAP requires `MAILBOX_USER + MAILBOX_PASSWORD`; OAuth requires the full client-id, client-secret, refresh-token tuple.

The setup secret gate continues to require live SAKBÉ credentials. TMS secrets become adapter-aware: a file adapter has no API secret requirement; an HTTP adapter only requires environment variables referenced by its configuration; SQL adapters retain their connection-string requirements. A malformed mounted config leaves `configure_secrets` pending.

The heartbeat `ai_key_status` uses the same model-provider rule so the cloud and local setup page cannot disagree.

### 2. TMS mapping transport

`install.sh` gains `--tms-mapping-config PATH`. It validates readability, copies the file to `connectors/tms-mapping.json`, protects it with mode `0600`, writes `QUOTEOPS_TMS_MAPPING_CONFIG_PATH=/opt/quoteops-v1/connectors/tms-mapping.json`, and includes it in overwrite guards. Connector packs may also supply `tms-mapping.json` directly. Existing install invocations remain valid.

### 3. Human-simulator client fixture

`deploy/appliance/examples/human-simulator/` contains only non-secret artifacts:

- manifest for client `RESAUX`, requester domain `resaux.io`, and a deterministic dry-van pricing profile;
- agent config using NVIDIA NIM via `NVIDIA_NIM_API_KEY` and Resend intake;
- HTTP TMS adapter plus strict mapping JSON for the SAP-like mock contract;
- small knowledge document and a synthetic RFQ payload;
- a runbook and a verification script that query health/setup/RFQ state without printing secrets.

The actual Resend receiving address is discovered live. No unverified or different domain may be substituted. Runtime secrets are copied from `/Users/alejandro/inducta/KEYS.md` into the VPS root-only secret file and never into the generated client package.

### 4. Clean deployment and evidence

Before reset, record the exact Hostinger project/container state. Delete only the Compose project and install directory associated with `quoteops_vpse2e`. Live discovery showed that `alejandro@resaux.io` already belongs to tenant `RESAUX`, with a previous installation visible in the portal. To preserve the exact authorized email and the control plane's email uniqueness, generate a fresh one-use install pack for `RESAUX` and treat it as a new customer installation with a new registration token and installation id; do not create a duplicate tenant or rewrite another customer's email. Open the delivered authorization link from Alejandro's mailbox.

Build and publish a new immutable image tag from this branch. The VPS installation must pin that tag. Evidence records digests/versions and redacts all credentials.

The human-simulator sends a synthetic RFQ through the configured Resend receiving address, waits for intake, and verifies the following independent proofs:

1. Resend message received and marked processed.
2. NVIDIA NIM produced structured RFQ extraction (not deterministic fallback).
3. SAKBÉ produced live route evidence.
4. The workflow created a priced run.
5. Required approval was completed through the authorized user path when applicable.
6. The HTTP mock TMS received quote/status writeback.
7. `/api/setup-state` has no remaining required steps.
8. The control plane reports the new installation heartbeat and configured AI status.

## Safety and secret handling

- Secret presence may be inspected, but secret values must never be printed to tool output or stored in Git.
- VPS secret files remain `0600`; client/connectors directories remain `0700` where supported.
- Destructive operations resolve the project name, Compose path, and VM id before removal.
- Screenshots and JSON evidence are inspected for tokens, keys, raw authorization URLs, and private mailbox content before saving.

## Verification gates

- Focused provider-readiness tests demonstrate NVIDIA NIM and Resend readiness and fail when either configured key is absent.
- Installer smoke tests demonstrate mapping copy/path/overwrite behavior.
- Fixture configs parse using production schemas; the verifier fails closed on any pending setup step.
- Full `npm test`, TypeScript build, web build, and appliance smoke pass from the repair branch.
- Live VPS proof covers all eight checks above; anything not evidenced is reported as not verified.
