import type { MinimalClientRecord } from "./minimalRegistry.js";

export type InstallPack = {
  client_id: string;
  installation_id: string;
  registration_token: string;
  expires_at: string;
  control_plane_url: string;
  install_command: string;
  files: Record<string, string>;
};

export function createInstallPack(input: {
  client: MinimalClientRecord;
  control_plane_url: string;
  registration_token: string;
  expires_at: string;
}): InstallPack {
  const controlPlaneUrl = input.control_plane_url.replace(/\/+$/, "");
  const { client } = input;
  const installationId = client.installation.installation_id;

  return {
    client_id: client.client_id,
    installation_id: installationId,
    registration_token: input.registration_token,
    expires_at: input.expires_at,
    control_plane_url: controlPlaneUrl,
    // single physical line on purpose: a backslash-newline continuation is
    // fragile to copy/paste (web renderers and chat UIs can swap the space
    // after it for a non-breaking/zero-width char, which then makes the
    // shell fail to find "bash"). No angle brackets in the placeholder
    // either, since those look like they should stay in the string.
    install_command: `QUOTEOPS_REGISTRATION_TOKEN="PASTE_YOUR_TOKEN_HERE" bash -c 'curl -fsSL ${controlPlaneUrl}/api/install/$QUOTEOPS_REGISTRATION_TOKEN | bash'`,
    files: {
      "client-manifest.yaml": renderClientManifest(client),
      "criteria-template.yaml": renderCriteriaTemplate(client),
      "connectors/agent/agent-config.yaml": renderAgentConfigTemplate(),
      "connectors/tms-adapter.yaml": renderTmsAdapterTemplate(),
      "connectors/tms/rfqs.csv": renderRfqCsvTemplate(),
      "connectors/tms/historical-quotes.csv": renderHistoricalQuotesCsvTemplate(),
      "connectors/tms/historical-shipments.csv": renderHistoricalShipmentsCsvTemplate(),
      "connectors/tms/customers.csv": renderCustomersCsvTemplate(),
      "connectors/tms/agreements.csv": renderAgreementsCsvTemplate(),
      "connectors/tms/unit-positions.csv": renderUnitPositionsCsvTemplate(),
      "connectors/tms/units.csv": renderUnitsCsvTemplate(),
      "connectors/tms/performance.csv": renderPerformanceCsvTemplate(),
      "connectors/tms/availability-zones.csv": renderAvailabilityZonesCsvTemplate(),
      "connectors/tms/quote-writebacks.jsonl": "",
      "connectors/tms/status-writebacks.jsonl": "",
      "connectors/tms-http-contract.md": renderHttpContract(),
      "connectors/tms-sql-contract.md": renderSqlContract()
    }
  };
}

function renderClientManifest(client: MinimalClientRecord): string {
  return [
    `client_id: ${client.client_id}`,
    `legal_name: ${quoteYaml(client.legal_name)}`,
    `installation_id: ${client.installation.installation_id}`,
    "business_units:",
    "  - business_unit_id: general",
    "    requester_email_domains: []",
    "    # keywords que identifican esta unidad de negocio en solicitudes de texto libre",
    "    keywords: []",
    "    default: true",
    "vehicle_profiles:",
    "  - vehicle_profile_id: T3S3_53_DRYVAN",
    "    business_unit_id: general",
    "    # keywords que identifican este tipo de unidad (ej. full, sencillo, plataforma)",
    "    keywords: []",
    "    payload_capacity_kg: 29000",
    "    fuel_loaded_km_per_l: 2.8",
    "    fuel_empty_km_per_l: 3.2",
    "    operator_cost_per_km_mxn: 2.75",
    "    pricing_model: profitability",
    "    diesel_price_mxn_per_liter: 29",
    "    margin_target_pct: 0.2",
    "    minimum_margin_pct: 0.12",
    "    maintenance_per_km_mxn: 3.6",
    "    tires_per_km_mxn: 2.01",
    "    fixed_overhead_per_km_mxn: 3.625",
    "    depreciation_per_km_mxn: 3.1792",
    "    insurance_rate: 0.003",
    "    insurance_min_mxn: 1200",
    "    profitability_rb_table:",
    "      - max_km: 100",
    "        rb_pct: 0.6",
    "      - max_km: 500",
    "        rb_pct: 0.6",
    "      - max_km: 1000",
    "        rb_pct: 0.57",
    "      - max_km: 2000",
    "        rb_pct: 0.55",
    "      - max_km: 3000",
    "        rb_pct: 0.52",
    "      - max_km: null",
    "        rb_pct: 0.5",
    "route_policy:",
    "  sakbe_required: true",
    "control_plane:",
    "  sync_mode: aggregate_only",
    "  sends:",
    "    - activation_status",
    "    - last_heartbeat_at",
    "    - ai_key_status",
    "    - quote_counters",
    "  never_sends:",
    "    - ai_api_key",
    "    - raw_rfq",
    "    - tms_rows",
    "    - route_evidence",
    "    - approval_detail",
    "local_setup:",
    "  secrets_required:",
    "    - ai_provider_api_key",
    "    - tms_credentials",
    "    - mailbox_credentials",
    "    - sakbe_key",
    "    - embedding_provider_key"
  ].join("\n");
}

function renderCriteriaTemplate(client: MinimalClientRecord): string {
  return [
    `client_id: ${client.client_id}`,
    "margin:",
    "  target_margin_pct: null",
    "  minimum_margin_pct: null",
    "approval:",
    "  approver_roles: []",
    "  require_human_validation: true",
    "communication:",
    "  tone: neutral",
    "  forbidden_disclosures:",
    "    - direct_cost_mxn",
    "    - internal_margin_pct"
  ].join("\n");
}

function renderTmsAdapterTemplate(): string {
  return [
    "provider: file_import",
    "rfqs_path_env: QUOTEOPS_TMS_RFQS_PATH",
    "historical_quotes_path_env: QUOTEOPS_TMS_HISTORICAL_QUOTES_PATH",
    "historical_shipments_path_env: QUOTEOPS_TMS_HISTORICAL_SHIPMENTS_PATH",
    "customers_path_env: QUOTEOPS_TMS_CUSTOMERS_PATH",
    "agreements_path_env: QUOTEOPS_TMS_AGREEMENTS_PATH",
    "unit_positions_path_env: QUOTEOPS_TMS_UNIT_POSITIONS_PATH",
    "units_path_env: QUOTEOPS_TMS_UNITS_PATH",
    "performance_path_env: QUOTEOPS_TMS_PERFORMANCE_PATH",
    "availability_zones_path_env: QUOTEOPS_TMS_AVAILABILITY_ZONES_PATH",
    "quote_writebacks_path_env: QUOTEOPS_TMS_QUOTE_WRITEBACKS_PATH",
    "status_writebacks_path_env: QUOTEOPS_TMS_STATUS_WRITEBACKS_PATH"
  ].join("\n");
}

function renderAgentConfigTemplate(): string {
  return [
    "model:",
    "  provider: openrouter",
    "  model_name: nvidia/nemotron-3-ultra-550b-a55b:free",
    "  temperature: 0",
    "  api_key_env: OPENROUTER_API_KEY",
    "authorization:",
    "  tools:",
    "    email.intake:",
    "      effect: read",
    "      mode: allowed",
    "    route.resolve:",
    "      effect: read",
    "      mode: allowed",
    "    tms.searchHistorical:",
    "      effect: read",
    "      mode: allowed",
    "    tms.writeQuoteResult:",
    "      effect: write",
    "      mode: allowed",
    "    email.sendQuote:",
    "      effect: send",
    "      mode: approval_required",
    "    approval.decide:",
    "      effect: approve",
    "      mode: approval_required",
    "# Mailbox the client assigns to the agent for RFQ intake (Gmail, Outlook,",
    "# or any IMAP server). Uncomment and set provider/auth; credentials live in",
    "# the appliance secrets (MAILBOX_USER + MAILBOX_PASSWORD or MAILBOX_OAUTH_*).",
    "# mailbox:",
    "#   provider: gmail        # gmail | outlook | imap",
    "#   auth: oauth2           # oauth2 | password",
    "#   processed_mailbox: null",
    "#   poll_interval_ms: 60000",
    "#   imap_host: null        # imap provider only",
    "#   imap_port: null"
  ].join("\n");
}

function renderRfqCsvTemplate(): string {
  return [
    "rfq_id,lane_id,received_at,requester_name,requester_email,company_alias,origin_city,origin_state,destination_city,destination_state,equipment_request,vehicle_profile_id,weight_kg,commodity,commodity_category,sector,value_mxn,customer_id,customer_type,business_unit_id,route_policy",
    ""
  ].join("\n");
}

function renderHistoricalQuotesCsvTemplate(): string {
  return [
    "quote_id,rfq_id,lane_id,quoted_at,origin_city,origin_state,destination_city,destination_state,vehicle_profile_id,rate_mxn,currency,customer_id,customer_type,business_unit_id,route_policy",
    ""
  ].join("\n");
}

function renderHistoricalShipmentsCsvTemplate(): string {
  return [
    "shipment_id,quoted_at,origin_city,origin_state,destination_city,destination_state,vehicle_profile_id,total_cost_mxn,total_revenue_mxn,customer_id,customer_type,business_unit_id",
    ""
  ].join("\n");
}

function renderCustomersCsvTemplate(): string {
  return ["customer_id,company_alias,customer_type,business_unit_id", ""].join("\n");
}

function renderAgreementsCsvTemplate(): string {
  return ["agreement_id,customer_id,lane_id,rate_mxn,currency,starts_at,expires_at", ""].join("\n");
}

function renderUnitPositionsCsvTemplate(): string {
  return ["unit_id,vehicle_profile_id,current_city,current_state,available_at", ""].join("\n");
}

function renderUnitsCsvTemplate(): string {
  return ["unit_id,current_lat,current_lng,status,next_destination_city", ""].join("\n");
}

function renderPerformanceCsvTemplate(): string {
  return ["unit_type,kpl_yield,real_cost_per_km", ""].join("\n");
}

function renderAvailabilityZonesCsvTemplate(): string {
  return ["zone_id,city,state,country,available_units", ""].join("\n");
}

function renderHttpContract(): string {
  return [
    "# QuoteOps TMS — HTTP contract (homegrown TMS)",
    "",
    "If your TMS exposes an HTTP API, implement these endpoints. Set",
    "`provider: http` in `connectors/tms-adapter.yaml` and point each",
    "`*_endpoint_path` at your route. All read endpoints return JSON (an object,",
    "or `{ \"data\": ... }`). The appliance reads; it never mutates your TMS",
    "except through the two optional write endpoints.",
    "",
    "## Read endpoints (return the canonical column names)",
    "",
    "| Purpose | Method | Default path | Returns (canonical fields) |",
    "|---|---|---|---|",
    "| Health | GET | /health | `{ ok: true }` |",
    "| Historical quotes | POST | /historical-quotes/search | array of `{ rate_mxn, direct_cost_mxn, margin_pct, origin_city, origin_state, origin_country, destination_city, destination_state, destination_country, vehicle_profile_id, commodity_category, sector, weight_kg, service_type, quoted_at }` |",
    "| Historical shipments | POST | /historical-shipments/search | array of `{ shipment_id, rfq_id, customer_id, status }` |",
    "| Customer | GET | /customers/:id | `{ customer_id, name, company_alias, customer_type, business_unit_id }` |",
    "| Customer agreements | GET | /customers/:id/agreements | array of `{ agreement_id, customer_id, lane_id, rate_mxn, effective_from, effective_to }` |",
    "| Unit positions | GET | /unit-positions | array of `{ unit_id, vehicle_profile_id, city, state, country, available_at }` |",
    "| **Units** | GET | /units | array of `{ unit_id, current_lat, current_lng, status, next_destination_city }` |",
    "| **Unit performance** | GET | /unit-performance | array of `{ unit_type, kpl_yield, real_cost_per_km }` |",
    "| **Availability zones** | GET | /availability-zones | array of `{ zone_id, city, state, country, available_units }` |",
    "",
    "`unit_type` in unit-performance MUST equal the `vehicle_profile_id` used in",
    "the manifest so the appliance overlays real yields onto the right profile.",
    "",
    "## Optional write endpoints",
    "",
    "| Purpose | Method | Path | Body |",
    "|---|---|---|---|",
    "| Write quote | POST | (your path) | `{ quote_id, rfq_id, lane_id, rate_mxn, currency, metadata }` → `{ quote_id, status }` |",
    "| Write status | POST | (your path) | `{ entity_id, status, metadata }` → `{ entity_id, status }` |",
    "",
    "Auth: put your token in the appliance secrets and reference it from the",
    "adapter config headers with `${ENV_VAR}` — never paste the value in the YAML.",
    ""
  ].join("\n");
}

function renderSqlContract(): string {
  return [
    "# QuoteOps TMS — SQL contract (homegrown TMS on a database)",
    "",
    "If your TMS is a SQL database (Google Cloud SQL Postgres/MySQL, Azure SQL,",
    "SQL Server, or self-hosted), you do NOT build endpoints — you write one",
    "SELECT per entity. **The query is the mapping**: alias your columns to the",
    "canonical names below and the appliance adapts to any schema.",
    "",
    "Set `provider: sql` in `connectors/tms-adapter.yaml`:",
    "",
    "```yaml",
    "provider: sql",
    "dialect: postgres        # postgres | mysql | mssql",
    "connection_url_env: TMS_SQL_URL   # a READ-ONLY DB user; value lives in secrets",
    "queries:",
    "  historical_quotes: >",
    "    SELECT tarifa AS rate_mxn, costo AS direct_cost_mxn, margen AS margin_pct,",
    "           origen_ciudad AS origin_city, origen_estado AS origin_state, 'MX' AS origin_country,",
    "           destino_ciudad AS destination_city, destino_estado AS destination_state, 'MX' AS destination_country,",
    "           tipo_unidad AS vehicle_profile_id, categoria AS commodity_category,",
    "           sector AS sector, peso AS weight_kg, fecha AS quoted_at",
    "    FROM cotizaciones",
    "    WHERE fecha BETWEEN :time_from AND :time_to",
    "  units: SELECT id AS unit_id, lat AS current_lat, lon AS current_lng, estatus AS status FROM unidades",
    "  performance: SELECT tipo AS unit_type, rendimiento AS kpl_yield, costo_km AS real_cost_per_km FROM rendimientos",
    "  availability_zones: SELECT id AS zone_id, ciudad AS city, estado AS state, 'MX' AS country, disponibles AS available_units FROM zonas",
    "  # customers, agreements, unit_positions, historical_shipments, get_rfq, new_rfqs are optional",
    "write_quote:",
    "  statement: INSERT INTO cotizaciones_outbox (quote_id, rate_mxn) VALUES (:quote_id, :rate_mxn)",
    "```",
    "",
    "## Canonical columns your SELECT must alias to",
    "",
    "- historical_quotes: `rate_mxn` (required), `direct_cost_mxn`, `margin_pct`,",
    "  `origin_city/state/country`, `destination_city/state/country`,",
    "  `vehicle_profile_id`, `commodity_category`, `sector`, `weight_kg`,",
    "  `service_type`, `quoted_at`.",
    "- units: `unit_id`, `current_lat`, `current_lng`, `status`",
    "  (`Available|En_Ruta|Mantenimiento`), `next_destination_city?`.",
    "- performance: `unit_type` (= manifest `vehicle_profile_id`), `kpl_yield`,",
    "  `real_cost_per_km`.",
    "- availability_zones: `zone_id`, `city`, `state`, `country`(2), `available_units`.",
    "",
    "## Available bind params (`:name`)",
    "",
    "Historical queries receive: `:origin_city :origin_state :origin_country",
    ":destination_city :destination_state :destination_country :vehicle_profile_id",
    ":commodity :commodity_category :sector :weight_kg :service_type :customer_id",
    ":time_from :time_to`. Customer/agreement queries receive `:customer_id`.",
    "Unit-position queries receive `:city :state :country :vehicle_profile_id`.",
    "",
    "## Rules",
    "",
    "- Use a **read-only** database user for `TMS_SQL_URL` (writes only through the",
    "  optional `write_quote`/`write_status` statements).",
    "- Only `:name` bind params — the appliance never interpolates RFQ values into",
    "  your SQL, so request data cannot become an injection.",
    "- `IN (:list)` / array params are not supported in v1; expand to named params.",
    ""
  ].join("\n");
}

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}
