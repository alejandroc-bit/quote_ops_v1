# RESAUX human-simulator client fixture

This is a non-secret, reproducible customer simulation for the existing
`RESAUX` tenant and its authorized user `alejandro@resaux.io`. It never creates
`RESAUXSIM`, a duplicate client, or a new installation ID. The control plane
keeps RESAUX's stable canonical installation ID; each clean VPS installation
uses a fresh, one-use registration token.

The synthetic RFQ crosses these boundaries:

- Resend Receiving API mailbox intake;
- NVIDIA NIM through its OpenAI-compatible endpoint;
- live INEGI SAKBE routing;
- a local HTTP mock that simulates a SAP-style contract (not a SAP connector
  and not certified against any SAP tenant); and
- approval-required outbound delivery plus quote/status writeback.

## What is in this folder

- `client-manifest.yaml`: RESAUX dry-van policy; only `resaux.io` requesters
  are allowed.
- `connectors/`: NVIDIA NIM, Resend, strict mock-TMS mapping, and staged
  knowledge. It contains names of environment variables, never values.
- `fixtures/rfq-email.txt`: the synthetic customer message.
- `verify.sh`: checks aggregate appliance health and setup state, then prints
  redacted JSON.

## Before you start

1. In the control plane, confirm that `alejandro@resaux.io` still belongs to
   `RESAUX`, then generate a **fresh one-use** install pack/token for that
   tenant. Reuse the tenant's **existing canonical installation ID** shown in
   the portal; do not invent a new ID.
2. In Resend, identify an address that can actually receive a test message.
   A `Verified` badge is not enough: check that the public MX record sends mail
   to Resend. If the root domain already receives through Google or Microsoft,
   use a dedicated receiving subdomain or the account's managed `*.resend.app`
   domain. Never substitute `resaux.io` as the Resend receiving domain.
3. Copy this reviewed repository and the fixture to the target Linux VPS. Do
   not copy provider keys, registration tokens, licenses, or mailbox addresses
   into Git, screenshots, shell history, or this folder.

## Fresh VPS installation — exact command sequence

Run this section as the VPS operator. The angle-bracket values are placeholders
that you enter interactively; do not paste real values into this document.

```bash
# 1) Set paths and non-secret identifiers for this isolated installation.
export QUOTEOPS_REPO=/root/quote_ops_v1
export FIXTURE_DIR="$QUOTEOPS_REPO/deploy/appliance/examples/human-simulator"
export QUOTEOPS_HOME=/opt/quoteops-resaux
export COMPOSE_PROJECT_NAME=quoteops_resaux
export QUOTEOPS_VERSION='<IMMUTABLE_RELEASE_TAG>'
export CONTROL_PLANE_URL='https://quote-ops-portal.vercel.app'

# 2) Read the short-lived token and the existing canonical ID without echoing
# them. The ID is stable for RESAUX; only the token must be newly generated.
read -r -s -p 'Fresh RESAUX registration token: ' REGISTRATION_TOKEN; echo
read -r -p 'Existing RESAUX canonical installation ID: ' INSTALLATION_ID

# 3) Prepare files only. This command intentionally does not start containers.
COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" \
  bash "$QUOTEOPS_REPO/deploy/appliance/install.sh" \
    --client RESAUX \
    --manifest "$FIXTURE_DIR/client-manifest.yaml" \
    --connectors "$FIXTURE_DIR/connectors" \
    --agent-config "$FIXTURE_DIR/connectors/agent/agent-config.yaml" \
    --tms-adapter-config "$FIXTURE_DIR/connectors/tms-adapter.yaml" \
    --tms-mapping-config "$FIXTURE_DIR/connectors/tms-mapping.json" \
    --home "$QUOTEOPS_HOME" \
    --control-plane-url "$CONTROL_PLANE_URL" \
    --registration-token "$REGISTRATION_TOKEN" \
    --installation-id "$INSTALLATION_ID" \
    --version "$QUOTEOPS_VERSION" \
    --skip-start
```

`<IMMUTABLE_RELEASE_TAG>` must be a published tag such as `v0.1.3`, never
`latest`. The token is passed from an in-memory shell variable, not written to
the command itself. Clear it after the install command with
`unset REGISTRATION_TOKEN`.

## Inject every runtime value without printing it

The following puts each value in the root-only secret file using stdin. Read
each value from the approved vault/source when prompted. No value is echoed,
committed, or listed later.

```bash
SECRET_TOOL="$QUOTEOPS_REPO/deploy/appliance/secrets.sh"

read -r -s -p 'NVIDIA NIM API key: ' NVIDIA_NIM_API_KEY; echo
printf '%s\n' "$NVIDIA_NIM_API_KEY" | bash "$SECRET_TOOL" --home "$QUOTEOPS_HOME" set NVIDIA_NIM_API_KEY --stdin
unset NVIDIA_NIM_API_KEY

read -r -s -p 'Resend API key: ' RESEND_API_KEY; echo
printf '%s\n' "$RESEND_API_KEY" | bash "$SECRET_TOOL" --home "$QUOTEOPS_HOME" set RESEND_API_KEY --stdin
unset RESEND_API_KEY

read -r -s -p 'Live INEGI SAKBE key: ' INEGI_SAKBE_KEY; echo
printf '%s\n' "$INEGI_SAKBE_KEY" | bash "$SECRET_TOOL" --home "$QUOTEOPS_HOME" set INEGI_SAKBE_KEY --stdin
unset INEGI_SAKBE_KEY

read -r -p 'Verified Resend receiving address (MAILBOX_USER): ' RESEND_INTAKE_ADDRESS
printf '%s\n' "$RESEND_INTAKE_ADDRESS" | bash "$SECRET_TOOL" --home "$QUOTEOPS_HOME" set MAILBOX_USER --stdin
unset RESEND_INTAKE_ADDRESS

read -r -p 'Verified Resend sending address (MAILBOX_FROM): ' RESEND_FROM_ADDRESS
printf '%s\n' "$RESEND_FROM_ADDRESS" | bash "$SECRET_TOOL" --home "$QUOTEOPS_HOME" set MAILBOX_FROM --stdin
unset RESEND_FROM_ADDRESS

# The mock's private Compose-network URL is also stored as a runtime value.
printf '%s\n' 'http://mock-tms:8099' | bash "$SECRET_TOOL" --home "$QUOTEOPS_HOME" set MOCK_TMS_BASE_URL --stdin

# This prints names plus '=set', never values.
bash "$SECRET_TOOL" --home "$QUOTEOPS_HOME" list
```

The mapping's `auth_method` and `api_key_env` fields are schema metadata: the
generic strict-mapping schema requires API-key metadata. The mock adapter has
no `headers` block and sends **no credential**. Therefore do **not** add a
`MOCK_TMS_API_KEY` placeholder or reuse a real SAP/TMS key.

## Create the exact network and start the mock

The appliance Compose file names its private network
`${COMPOSE_PROJECT_NAME}_quoteops_internal`. Start only the dependency services
once to create that network, then attach the mock using the `mock-tms` alias.

```bash
COMPOSE_FILE="$QUOTEOPS_REPO/deploy/appliance/docker-compose.yml"
NETWORK="${COMPOSE_PROJECT_NAME}_quoteops_internal"
MOCK_CONTAINER=quoteops-resaux-mock-tms

docker compose --env-file "$QUOTEOPS_HOME/.env" -f "$COMPOSE_FILE" \
  up -d --force-recreate postgres redis
docker network inspect "$NETWORK" >/dev/null

# This target is specific to this simulation. Removing it cannot affect other
# VPS projects. It makes a retry safe if a prior mock was left behind.
docker rm -f "$MOCK_CONTAINER" 2>/dev/null || true
docker run -d --name "$MOCK_CONTAINER" \
  --network "$NETWORK" --network-alias mock-tms \
  -v "$QUOTEOPS_REPO/deploy/appliance/mock-tms/server.mjs:/app/server.mjs:ro" \
  node:22-alpine node /app/server.mjs

# env_file values are read when containers are created. Always recreate after
# changing secrets/client.env; `docker compose restart` is not enough.
docker compose --env-file "$QUOTEOPS_HOME/.env" -f "$COMPOSE_FILE" \
  up -d --force-recreate
```

## Activate and run the proof

1. Open the appliance and activate through the authorized `alejandro@resaux.io`
   path. Keep the email authorization URL out of screenshots.
2. Send the contents of `fixtures/rfq-email.txt` only from
   `alejandro@resaux.io` to the runtime-injected Resend mailbox address.
3. Confirm the run records Resend intake, NVIDIA structured extraction, live
   SAKBE evidence, pricing, the required approval, and mock quote/status
   writebacks.
4. Run the aggregate verifier:

   ```bash
   bash "$FIXTURE_DIR/verify.sh" http://127.0.0.1:<APPLIANCE_HTTP_PORT>
   ```

The verifier proves only `/api/health` and `/api/setup-state` aggregate state.
It does **not** prove this particular run used Resend, NVIDIA, SAKBE, pricing,
approval, TMS writebacks, or heartbeat; capture those run-specific facts as
separate redacted evidence.
