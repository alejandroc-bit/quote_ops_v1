# RESAUX human-simulator client fixture

This is a non-secret, reproducible client pack for the existing `RESAUX`
tenant and its authorized user, `alejandro@resaux.io`. It is intended to drive
a fresh appliance installation after review; it never creates `RESAUXSIM` or a
duplicate cloud tenant.

The fixture exercises a synthetic RFQ through these boundaries:

- Resend Receiving API for mailbox intake;
- NVIDIA NIM through the OpenAI-compatible endpoint using
  `nvidia/nemotron-3-ultra-550b-a55b`;
- live INEGI SAKBE route resolution;
- a local HTTP mock TMS that simulates a SAP-style contract; it is not a SAP
  connector and has no SAP certification; and
- approval-required outbound delivery plus quote and status writeback.

## Pack contents

- `client-manifest.yaml` is the RESAUX dry-van profile. Requester emails from
  `resaux.io` are allowed.
- `connectors/agent/agent-config.yaml` selects NVIDIA NIM and Resend without
  values for any credentials or mailbox addresses.
- `connectors/tms-adapter.yaml` targets the HTTP mock contract. Its strict
  `tms-mapping.json` names only runtime environment variables.
- `connectors/knowledge/operating-policy.md` is staged fixture knowledge.
- `fixtures/rfq-email.txt` is a synthetic message payload; deliver it only to
  the runtime-injected receiving address.
- `verify.sh` checks public appliance state and prints a redacted JSON summary.

## Before installation

1. In the control plane, confirm that `alejandro@resaux.io` still maps to
   tenant `RESAUX`. Generate a new, one-use install pack for that tenant; do
   not create a new client record.
2. In Resend, confirm that `inducta.io` is verified. This is the only verified
   domain discovered for this run. Stop if it is no longer verified.
3. Choose a receiving address on that verified domain at runtime. Do not add it
   to this repository, the client pack, screenshots, or command history.
4. Store the new registration token, appliance license material, and provider
   keys only in the VPS root-only secret file (`0600`).

## Install preparation

Copy the fixture to a secure operator workstation or VPS, then use the
generated one-use values with the installer. The install command must point to
this fixture's manifest, connector directory, and strict mapping file. Keep
the generated registration token outside the shell history where possible.

The runtime secret file must contain values for:

- `NVIDIA_NIM_API_KEY` — NVIDIA NIM key for the configured model.
- `RESEND_API_KEY` — Resend key with receiving and sending access.
- `INEGI_SAKBE_KEY` — live SAKBE key.
- `MOCK_TMS_BASE_URL` — base URL of the fixture's mock-TMS service.
- `MAILBOX_USER` and `MAILBOX_FROM` — inject only the selected address on the
  currently verified Resend domain. Neither variable has a value in this pack.

The `MAILBOX_USER` receiving address filters Resend intake. `MAILBOX_FROM` is
the verified sender used by quote replies; it may be the same selected address.
Do not substitute `resaux.io` for the verified Resend domain.

The strict mapping file names `MOCK_TMS_API_KEY` because its current schema
requires an API-key environment-variable reference for HTTP mappings. The mock
adapter deliberately sends no auth header and the mock service does not verify
a key, so this fixture has no `MOCK_TMS_API_KEY` runtime-secret requirement.
Do not inject a placeholder key or reuse a real TMS credential for it.

Start the HTTP mock in the appliance network before testing. The mock source is
`deploy/appliance/mock-tms/server.mjs`; bind `MOCK_TMS_BASE_URL` to its network
address. It persists writebacks only in memory, so it is suitable solely for
this simulator.

## Run the proof

1. Install and activate the appliance through the authorized RESAUX user path.
2. Send `fixtures/rfq-email.txt` to the runtime-injected receiving address.
3. Wait for mailbox intake and confirm the run used structured NVIDIA NIM
   extraction, live SAKBE route evidence, and the HTTP mock-TMS writebacks.
4. Complete approval through the authorized user path when the workflow asks
   for it.
5. Run the verifier against the public appliance origin:

   ```bash
   bash deploy/appliance/examples/human-simulator/verify.sh https://appliance.example
   ```

The verifier exits non-zero unless `/api/health` reports `ok: true` and
`/api/setup-state` has an empty `required_steps` array. Its JSON output is a
redacted summary only; it intentionally does not print secret files, mailbox
addresses, provider responses, registration tokens, or license material.
