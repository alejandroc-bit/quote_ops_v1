# QuoteOps Control Plane Contract

The appliance is installed per client and processes RFQs locally. The Inducta control plane only authorizes onboarding and tracks minimal fleet registry state.

The control plane may receive:

- Authorized client and user records managed by Inducta.
- Installation id and signed license status.
- Last heartbeat timestamp.
- Onboarding status.
- AI key status as `configured` or `missing`.
- Aggregate quote counters: `total`, `validated`, `rejected`, `pending`, `failed`.

The control plane must not receive:

- AI API keys, embedding keys, TMS credentials, Gmail tokens or SAKBE keys.
- Raw RFQs, customer emails, WhatsApp messages or documents.
- TMS raw payloads, rows, historical exports or writeback payloads.
- Route evidence, SAKBE responses or detailed lane evidence.
- Approval envelopes, director decisions, workflow timelines or full workflow state.
- Quote-core formulas, detailed liquidations or customer-specific pricing internals.

## Client install (3 steps)

1. **Inducta creates the client** in the Control Plane UI/API and generates an install pack. The pack shows a one-line install command and a short-lived registration token.
2. **The client runs the command in their terminal** (Docker + Docker Compose v2 required):

   ```bash
   QUOTEOPS_REGISTRATION_TOKEN='<paste-token-here>' \
     bash -c 'curl -fsSL <control-plane-url>/api/install/$QUOTEOPS_REGISTRATION_TOKEN | bash'
   ```

   `GET /api/install/:token` serves a self-extracting script with the appliance
   deploy files (install.sh, docker-compose.yml, Caddyfile) plus the client's
   manifest, criteria and connector templates. The token authorizes the
   download but is never embedded in the script, and it is only consumed by
   activation. Images are pulled from the registry published by the
   `release-appliance-images` workflow (`ghcr.io/<owner>/quoteops-{agent,api,web}`,
   tagged on `quoteops-v*` releases); override with `QUOTEOPS_IMAGE_REGISTRY`.
3. **The client signs in through the cloud onboarding flow.** The control plane validates the user allowlist and registration token, then issues a signed license for `client_id + installation_id`.

For development installs from a repo checkout, `bash deploy/appliance/install.sh --client <ID> --manifest <path> ...` still works directly (see `deploy/appliance/examples/nmx/` for a fictional example client).

After activation, `/api/setup-state` unlocks only when the appliance has a valid local license. Secret capture happens locally. The cloud can learn that the AI key is configured, but it never receives the key value.

## Re-activation (lost license or used token)

Registration tokens are single-use: a successful activation consumes the token.
If the appliance loses its local license (e.g. the api container was recreated),
re-activating with the old token fails — the control plane answers
`registration_token_used` and the appliance propagates that code (403).

- **Generate install pack** (portal) is the recovery path: it issues a NEW
  registration token. Update `QUOTEOPS_REGISTRATION_TOKEN` in
  `/opt/quoteops/secrets/client.env`, restart the api container and POST
  `/api/onboarding/activate` again.
- **Reissue license** only re-signs a license for an authorized client record;
  it does NOT create or re-enable a registration token.

## Minimal runtime sync

The api container pushes the sync automatically: when `QUOTEOPS_CONTROL_PLANE_URL`
and `QUOTEOPS_INSTALLATION_ID` are set, it syncs once at boot and then every
`QUOTEOPS_SYNC_INTERVAL_MS` milliseconds (default 600000 = 10 min; set `0` to
disable). It also runs before activation, so the portal reflects onboarding
progress (`not_started`/`authorized`). Sync failures are only logged — the
appliance keeps working when the cloud is unreachable.

To force a sync manually:

```bash
curl -X POST http://localhost:19080/api/control-plane/sync-minimal
```

The appliance computes aggregate counters from local workflow summaries and posts only:

- heartbeat: `client_id`, `ai_key_status`, `onboarding_status`
- counters: `total`, `validated`, `rejected`, `pending`, `failed`

It does not post raw RFQs, route evidence, TMS rows, workflow timelines, approval envelopes, documents, embeddings or secrets.
