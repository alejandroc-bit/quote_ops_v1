# Inducta Control Plane Operator README

## Purpose

The Inducta Control Plane is an internal onboarding and registry tool for QuoteOps client appliances. It is not an operational RFQ dashboard and it is not the pricing data plane.

It has four responsibilities:

- Maintain the list of authorized clients and users.
- Generate an installable package for each client.
- Authorize first install through cloud login and issue a signed license.
- Track active/inactive state, last heartbeat, AI key configured/missing status, and aggregate quote counters.

The RFQ runtime, approvals, TMS access, route evidence, documents, RAG and writeback remain local in the client appliance.

## Minimal Cloud Model

The cloud stores only these records:

- `clients`: `client_id`, `legal_name`, `status`, `created_at`.
- `authorized_users`: email/login allowlist scoped to a client.
- `installations`: `installation_id`, `client_id`, `license_status`, `last_heartbeat_at`, `onboarding_status`, `ai_key_status`.
- `quote_counters`: `total`, `validated`, `rejected`, `pending`, `failed`.
- `install_tokens`: short-lived token for first install authorization.
- `licenses`: signed license issued for `client_id + installation_id`.

## API Surface

- `POST /api/admin/clients`
- `POST /api/admin/clients/:clientId/install-pack`
- `POST /api/admin/clients/:clientId/suspend`
- `POST /api/admin/clients/:clientId/reactivate`
- `POST /api/admin/clients/:clientId/reissue-license`
- `POST /api/onboarding/login`
- `POST /api/onboarding/activate`
- `POST /api/installations/:installationId/heartbeat`
- `POST /api/installations/:installationId/counters`

Registration tokens expire and are only valid for first activation. Reissuing a license is an explicit admin action.

Set `QUOTEOPS_LICENSE_PRIVATE_KEY_PEM` and `QUOTEOPS_LICENSE_PUBLIC_KEY_PEM` in staging/production so emitted licenses survive process restarts. For hosts where multiline env vars are awkward, use `QUOTEOPS_LICENSE_PRIVATE_KEY_PEM_B64` and `QUOTEOPS_LICENSE_PUBLIC_KEY_PEM_B64`. If omitted, the API generates an ephemeral keypair for local demo/test only.

Persistence is selected at boot:

- `DATABASE_URL`: preferred for staging/production. The API creates `control_plane_clients` and `control_plane_install_tokens` if missing.
- `QUOTEOPS_CONTROL_PLANE_STORE_PATH`: JSON file store for controlled local demos or a persistent VM.
- neither set: in-memory store for tests and throwaway demos only.

## Local Demo

Run the API with a JSON store:

```bash
QUOTEOPS_CONTROL_PLANE_STORE_PATH=.quoteops/control-plane-store.json \
  npm run dev:control-plane-api
```

Run the Control Plane UI:

```bash
VITE_QUOTEOPS_CONTROL_PLANE_API_BASE_URL=http://127.0.0.1:19083 \
  npm --workspace @quoteops/web run dev:control
```

Seed and validate NMX end to end:

```bash
npm run demo:nmx-control-plane
```

The demo creates NMX, generates an install pack, authorizes login, activates a signed license, posts heartbeat, posts aggregate counters, and lists the final registry.

When an appliance is configured with `QUOTEOPS_CONTROL_PLANE_URL`, it can push the same minimal aggregate sync from its local API:

```bash
curl -X POST http://localhost:19080/api/control-plane/sync-minimal
```

## Production (Vercel + Supabase)

The cloud control plane deploys on the existing Vercel project (`vercel.json`
builds the UI and serves `api/index.ts` as the API). The client registry lives
in the dedicated Supabase project **`quoteops-control-plane`**
(ref `deoxhkjiakalvmskqycd`, org `opwxapiefcbiefosriph`) — never in
`quote_system_ai_demo` or `cockpit`. The API creates its two tables
(`control_plane_clients`, `control_plane_install_tokens`) on first use.

Vercel environment variables:

- `DATABASE_URL` — Supabase pooler connection string of
  `quoteops-control-plane` (Dashboard → Connect → Transaction pooler; set or
  reset the database password there):
  `postgresql://postgres.deoxhkjiakalvmskqycd:<DB_PASSWORD>@aws-0-us-east-1.pooler.supabase.com:6543/postgres`
- `QUOTEOPS_LICENSE_PRIVATE_KEY_PEM_B64` / `QUOTEOPS_LICENSE_PUBLIC_KEY_PEM_B64` — base64 of the Ed25519 license keypair so licenses survive restarts.
- `QUOTEOPS_CONTROL_PLANE_URL` — the public URL used in install packs and one-liner installers.
- `QUOTEOPS_SUPABASE_URL` / `QUOTEOPS_SUPABASE_ANON_KEY` — same Supabase project, used server-side to verify admin sessions (`GET /auth/v1/user`).
- `QUOTEOPS_ADMIN_EMAILS` — comma-separated allowlist of emails authorized to use `/api/admin/*`. Without all three of these, admin routes answer 503 (fail-closed).
- `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` — same values, build-time vars so the Vite UI can sign in via Supabase Auth (magic link by default).

Admin login: the Control Plane UI shows an "Admin email" field. Entering an
allowlisted email and clicking "Send magic link" emails a one-time sign-in
link (Supabase Auth, no separate account/password to manage). One manual step
in the Supabase Dashboard is required: **Authentication → URL Configuration**,
set Site URL to the production UI URL and add it to Redirect URLs, or magic
links will fail to redirect back.

## Staging Checklist

- Create a staging database and set `DATABASE_URL`.
- Generate and set `QUOTEOPS_LICENSE_PRIVATE_KEY_PEM` and `QUOTEOPS_LICENSE_PUBLIC_KEY_PEM`.
- Set `QUOTEOPS_CONTROL_PLANE_URL` to the public API URL used in install packs.
- Set `QUOTEOPS_SUPABASE_URL`, `QUOTEOPS_SUPABASE_ANON_KEY`, `QUOTEOPS_ADMIN_EMAILS` (backend) and `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (frontend build).
- Deploy the API from `apps/control-plane-api`.
- Deploy the UI with `VITE_QUOTEOPS_APP=control-plane` and `VITE_QUOTEOPS_CONTROL_PLANE_API_BASE_URL` pointing to the API.
- Run `npm run demo:nmx-control-plane` with `CONTROL_PLANE_URL=https://<staging-api-host>`.

## Install Pack Boundary

An install pack may include:

- `client-manifest.yaml`
- `criteria-template.yaml`
- `connectors/agent/agent-config.yaml`
- `connectors/tms-adapter.yaml`
- local file-import TMS templates under `connectors/tms/`
- installation id
- install command using `--control-plane-url`, `--registration-token`, and `--installation-id`

The generated manifest includes a baseline business unit and vehicle profile so the appliance can boot and run controlled RFQ tests before the real client criteria are finalized. The templates are expected to be replaced or edited during client onboarding.

An install pack must not include secrets. The AI provider API key, embeddings key, SAKBE key, Gmail credentials and TMS credentials are entered locally in the appliance.

## No-Go Items

- Do not store AI API keys, TMS credentials, Gmail tokens, SAKBE keys or embedding keys.
- Do not store raw RFQs, customer emails, WhatsApp messages, documents, chunks or embeddings.
- Do not store TMS rows, TMS payloads, route evidence, quote calculations or detailed liquidations.
- Do not store approval envelopes, director decisions, workflow timelines or full workflow state.
- Do not run LangGraph, quote-core, TMS adapters, SAKBE, RAG, ingestion or quote workflow execution in the cloud control plane.
- Do not mutate TMS records from the cloud control plane.
