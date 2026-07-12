# QuoteOps Appliance Secrets

Each client install has one secrets file:

```text
<QUOTEOPS_HOME>/secrets/client.env
```

The regular `<QUOTEOPS_HOME>/.env` is appliance configuration. It stores paths, image tags, ports, and database wiring. Client-owned API keys go in `secrets/client.env`, never in the client pack, manifest, RFQ files, criteria, Git, or exported templates.

Default runtime keys:

```env
INEGI_SAKBE_KEY=""
GEMINI_API_KEY=""
OPENROUTER_API_KEY=""
```

TMS connection (only for the SQL provider — connect the client's own database):

```env
# Read-only connection string to the client's TMS database.
# postgres://user:pass@host:5432/db  |  mysql://...  |  mssql://...
# Use Google Cloud SQL, Azure SQL, or any managed SQL — see
# connectors/tms-sql-contract.md for the queries to configure.
TMS_SQL_URL=""
```

Agent mailbox keys (RFQs by email — text, image, or xlsx). The client assigns a
dedicated mail account to the agent; any provider that speaks IMAP works
(Gmail, Outlook/Microsoft 365, or a custom server). Configure the non-secret
settings in `connectors/agent/agent-config.yaml` under `mailbox:`; the address
and credentials go here:

```env
# the mailbox address the client assigned to the agent
MAILBOX_USER=""

# option A — app password (works with any IMAP provider):
MAILBOX_PASSWORD=""

# option B — OAuth2 (Gmail / Outlook):
MAILBOX_OAUTH_CLIENT_ID=""
MAILBOX_OAUTH_CLIENT_SECRET=""
MAILBOX_OAUTH_REFRESH_TOKEN=""
# MAILBOX_OAUTH_TENANT=""      # Outlook only, defaults to "common"

# imap provider only (when provider: imap in agent-config):
# MAILBOX_IMAP_HOST=""
# MAILBOX_IMAP_PORT="993"
```

The `quoteops-agent` container polls the mailbox on the configured interval
(default 60s) when a `mailbox:` block and credentials are present. Only senders
whose domain is listed in the manifest's
`business_units[].requester_email_domains` are processed; everything else is
marked read (ignored). Extraction failures are flagged (`\Flagged`) and left
for manual review — never dropped silently. Processed mail is optionally moved
to `processed_mailbox`.

Future connector or agent keys can be added with the same pattern as uppercase env vars:

```bash
printf '%s\n' "$VALUE" | bash deploy/appliance/secrets.sh \
  --home /opt/quoteops \
  set CONNECTOR_API_KEY --stdin
```

Operational rules:

- `install.sh` creates `secrets/client.env` with mode `600` inside a `700` directory.
- `docker-compose.yml` injects `secrets/client.env` into `quoteops-api` and `quoteops-agent` using `env_file`.
- The client pack remains portable because it references env var names, not values.
- `backup.sh` does not include secret values. It writes only a `secrets.keys` inventory, so restore requires re-provisioning the client's secret file out of band.
- If a required key is missing, the runtime must fail closed instead of inventing route, TMS, or pricing data.

## Council-Locked Secret Policy

Secret values stay in the client appliance or customer-managed vault. Client packs and the Inducta Control Plane may contain env var names such as `TMS_API_KEY`, `INEGI_SAKBE_KEY`, `OPENROUTER_API_KEY`, and `QUOTEOPS_EMBEDDING_API_KEY`, but never their values.

The appliance must fail closed when a required secret is missing:

- missing signed license: `423 appliance_locked`
- missing TMS secret: `REVIEW_REQUIRED`
- missing SAKBÉ/SACB key: `REVIEW_REQUIRED`
- missing embedding key during ingestion: ingestion blocked
- missing model key during TMS onboarding remap: remap blocked
