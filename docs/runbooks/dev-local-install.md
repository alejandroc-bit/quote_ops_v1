# Developer local install runbook

Run the QuoteOps appliance on your MacBook for development and manual testing, without a real Cloudflare tunnel, public hostname, or Ubuntu VM.

## Prerequisites

- macOS arm64 (Apple Silicon). The stack runs under AMD64 emulation.
- Docker Desktop running (`docker info` succeeds).
- `docker compose` v2.24+.
- `jq`, `curl`, `openssl`, `node`, and `bash` on `PATH`.
- OpenRouter API key (validates the AI-first onboarding step).
- Resend API key (mailbox intake).
- INEGI SAKBÉ key (routes).
- Gemini API key (embeddings, model `text-embedding-004`).

## Prepare secrets (one time)

Create `0600` files under `~/.quoteops-secrets/`:

```bash
mkdir -p ~/.quoteops-secrets && chmod 700 ~/.quoteops-secrets
for name in openrouter-key resend-key sakbe-key embedding-key; do
  printf "Pega %s: " "$name"
  read -s val
  printf '%s' "$val" > ~/.quoteops-secrets/$name
  chmod 600 ~/.quoteops-secrets/$name
  echo " ✓ $name"
done
ls -la ~/.quoteops-secrets/
```

## Run the dev install

```bash
cd <repo>/.worktrees/vm-appliance-onboarding   # or the branch checkout
npm run dev:install
```

What `scripts/dev-install-quoteops.sh` does:

1. Preflight: verifies Docker, the four secret files exist and are `0600`.
2. Creates a bounded temp root under `$TMPDIR/quoteops-dev.XXXXXX` and a unique Compose project.
3. Ensures the appliance images are loaded. For `v0.1.2` it downloads the public side-load tarballs from the GitHub release and `docker load`s them; for other versions, the images must already be present locally.
4. Starts a throwaway control plane API on `http://127.0.0.1:19083` using a file store (no Postgres required), packages a local appliance release bundle, registers it via `sync-bundled`, creates a `DEV` client, and issues a one-use install pack.
5. Invokes `deploy/appliance/install.sh --no-pull` into the bounded `QUOTEOPS_HOME`, wiring the four secret files into `secrets/client.env`.
6. Prints the local web URL, API health URL, control-plane URL, and the resume/cleanup commands.

## What you get

- `web_url=http://127.0.0.1:8080` — QuoteOps web UI (load it in Chrome).
- `api_health=http://127.0.0.1:8080/api/health` — API health.
- `control_plane=http://127.0.0.1:19083` — throwaway control plane (admin CLI works here).
- `quoteops_home=$TMPDIR/quoteops-dev.XXXXXX/quoteops-v1` — the appliance data root.

Open `http://127.0.0.1:8080` in your browser and resume onboarding with the AI key you supplied. The onboarding wizard is AI-first: it validates the OpenRouter key live before persisting anything.

## What it does NOT prove

- No real Cloudflare tunnel or public hostname (Caddy binds `127.0.0.1:8080` only).
- No real Ubuntu apt/Docker bootstrap (Mac uses Docker Desktop).
- No published `v0.2.0` release from the CI pipeline (uses local `v0.1.2` side-load images).
- For the full acceptance journey, use `deploy/appliance/tests/macbook-acceptance.sh` (original plan Task 10).

## Debugging a failed run

Add `--keep` to retain the temp root and Compose project after a failure:

```bash
npm run dev:install -- --keep
```

The script prints the retained root, project name, and the cleanup command. Inspect:

- `$E2E_ROOT/cp.log` — control plane API output.
- `$QUOTEOPS_HOME/` — appliance data, env, and release assets.
- `docker compose --project-name <project> logs` — service logs.

## Cleanup

On success the script tears down everything automatically. For a retained failed run:

```bash
bash scripts/dev-install-quoteops.sh --cleanup
```

This loads the `0600` state file, revalidates the bounded paths, stops only the recorded Compose project, kills the control plane process, and removes the temp root and state file.

## Optional overrides

| Env var | Default | Purpose |
|---|---|---|
| `QUOTEOPS_DEV_VERSION` | `v0.1.2` | appliance release version to package |
| `QUOTEOPS_DEV_HTTP_PORT` | `8080` | Caddy loopback port |
| `QUOTEOPS_DEV_CLIENT_ID` | `DEV` | control plane client id |
| `QUOTEOPS_DEV_EMAIL` | `dev@quoteops.example` | authorized activation email |
| `QUOTEOPS_DEV_INSTALLATION_ID` | `dev-prod-001` | appliance installation id |
| `QUOTEOPS_DEV_REPO` | script parent | worktree root (for `npm run`) |
