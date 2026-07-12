# NMX Appliance Example

This is a client connector pack, not product code. It can be copied into an appliance install to emulate NMX with mounted files and live SAKBE route requests:

- `client-manifest.yaml`: operating profile used by quote-core.
- `connectors/sakbe/route-cache.json`: intentionally empty; live mode bypasses cache reads and writes.
- `connectors/tms/*.csv`: file-based TMS inputs.
- `connectors/agent/agent-config.yaml`: OpenRouter Nemotron guide model and tool authorization.

Install preparation example:

```bash
bash deploy/appliance/install.sh \
  --client NMX \
  --manifest deploy/appliance/examples/nmx/client-manifest.yaml \
  --connectors deploy/appliance/examples/nmx/connectors \
  --sakbe-live true \
  --sakbe-cache-mode live_only \
  --skip-start
```

For local testing, set `INEGI_SAKBE_KEY` and `OPENROUTER_API_KEY` in the generated secrets file, not in this folder or in the main `.env`. See `deploy/appliance/SECRETS.md`. Non-Docker tests can point to a trusted local keys file with explicit `QUOTEOPS_*_KEYS_PATH` env vars, but Docker installs should use the per-client secrets file only.
