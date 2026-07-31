# Customer VM installation runbook

This runbook describes what a client must prepare before the QuoteOps one-command
install, what the control plane displays, and what the operator can run afterward.

The VM receives **containers and a versioned runtime bundle**, not a Git clone.
No source checkout, no build step, and no repository access is required on the
customer VM. The control plane ships a pinned, digest-verified release that the
bootstrap installs under `/opt/quoteops-v1`.

## Step 1 — Pre-install form

Before the install, the client must complete and deliver this form. Nothing here
is a secret that lives in the command line; long-lived credentials are entered
transiently and stored as `0600` root-owned files on the VM.

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

## Step 2 — One-command install and operator flow

The control plane displays a single one-command bootstrap. The registration
token is prompted for through `/dev/tty`; it is never pasted into the command
and never appears in shell history or process arguments.

```bash
bash -c 'set -Eeuo pipefail; f="$(mktemp)"; trap '\''rm -f "$f"'\'' EXIT; curl --proto "=https" --proto-redir "=https" --tlsv1.2 -fsSL "$1" -o "$f"; sudo bash "$f"' quoteops "${CONTROL_PLANE_URL}/install/quoteops"
```

After the bootstrap installs the runtime bundle, the operator uses the stable
`quoteops` wrapper for every lifecycle operation:

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

### Stable data layout

The appliance keeps a stable, release-independent data layout under
`/opt/quoteops-v1`:

- `releases/<pinned-version>/` — read-only, root-owned, immutable to non-root;
  contains the versioned `docker-compose.yml`, `release.env`, and the appliance
  scripts shipped for that release.
- `current` — a root-owned absolute symlink that always selects exactly one
  pinned release. `update` atomically retargets `current` at the new release;
  `rollback` retargets it at the previous release.
- `secrets/`, `settings/`, `manifests/`, `connectors/`, `backups/` — version
  independent, so they survive every `update` and `rollback` untouched.

### Rollback

`rollback` retargets `current` at the previously pinned release, then restarts
the core services from that release's compose file. It does not delete the
newer release directory, the database, or any settings. Because data volumes
and secrets are version independent, rollback restores the running application
to the prior version without data loss.

### Restore onto another VM

`restore` replays a `backup` tarball into the stable data layout. Restoring onto
a different VM re-creates manifests, connectors, settings, and the database
snapshot, but **local secrets do not travel in the backup**. After restoring on
a new VM, the operator must re-enter the local secrets (PostgreSQL password,
Cloudflare tunnel token, AI/TMS/mailbox/SAKBÉ/embedding keys) with
`sudo quoteops secrets set …` before the appliance can start.

### Transient Cloudflare Service Auth on update/rollback

`update` and `rollback` securely prompt for the transient Cloudflare Service
Auth client ID and secret when the tunnel is configured, or accept only
`--cloudflare-access-file /absolute/0600/path`. They refresh the version-bound
public-origin receipt and **delete the local credential file after
verification**, so no Service Auth value is ever persisted across the version
switch. If verification must be resumed, the operator re-enters the Service
Auth values.
