# QuoteOps appliance installer

Install a client package with its manifest and agent configuration:

```bash
deploy/appliance/install.sh \
  --client client-id \
  --manifest /path/to/client-manifest.yaml \
  --agent-config /path/to/agent-config.yaml
```

For an HTTP TMS, provide its strict mapping JSON during installation:

```bash
deploy/appliance/install.sh \
  --client client-id \
  --manifest /path/to/client-manifest.yaml \
  --agent-config /path/to/agent-config.yaml \
  --tms-adapter-config /path/to/tms-adapter.yaml \
  --tms-mapping-config /path/to/tms-mapping.json
```

The installer copies the mapping to `connectors/tms-mapping.json`, protects it
with mode `0600`, and publishes
`QUOTEOPS_TMS_MAPPING_CONFIG_PATH=/opt/quoteops-v1/connectors/tms-mapping.json`
in `.env`. A connector pack may include `tms-mapping.json` instead. As with the
agent and TMS-adapter assets, an existing mapping is never replaced unless you
pass `--force`.
