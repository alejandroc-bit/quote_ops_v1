import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { calculateQuote, type QuoteCoreInput } from "@quoteops/quote-core";
import {
  historicalQuoteRecordSchema,
  TMS_HTTP_V1_CONTRACT,
  TMS_HTTP_V1_PATHS
} from "@quoteops/contracts";
import {
  FileImportTmsAdapter,
  HttpTmsAdapter,
  TmsAdapterError,
  createTmsAdapterFromConfig,
  type HistoricalSearchQuery,
  type TmsAdapter
} from "../src/index";

const tempDirs: string[] = [];

describe("TMS HTTP v1 contract", () => {
  it("publishes the canonical contract identity, paths, and historical row schema", () => {
    expect(TMS_HTTP_V1_CONTRACT).toBe("quoteops-tms-http-v1");
    expect(TMS_HTTP_V1_PATHS).toEqual({
      health: "/quoteops/v1/health",
      historical_quotes: "/quoteops/v1/historical-quotes/search",
      units: "/quoteops/v1/units",
      unit_performance: "/quoteops/v1/unit-performance",
      availability_zones: "/quoteops/v1/availability-zones",
      write_quote: "/quoteops/v1/quotes"
    });

    expect(
      historicalQuoteRecordSchema.parse({
        origin_city: "Monterrey",
        origin_state: "Nuevo León",
        origin_country: "MX",
        destination_city: "Saltillo",
        destination_state: "Coahuila",
        destination_country: "MX",
        vehicle_profile_id: "DRY_VAN_53",
        rate_mxn: 18500,
        quoted_at: "2026-07-29T18:00:00.000Z"
      })
    ).toBeTruthy();
  });
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "quoteops-tms-"));
  tempDirs.push(dir);
  const filePath = join(dir, name);
  await mkdir(join(dir, "nested"), { recursive: true });
  await writeFile(filePath, content.trim(), "utf8");
  return filePath;
}

async function createTempCsv(name: string, content: string): Promise<string> {
  return createTempFile(name, content);
}

const historicalQuotesCsv = `
quote_id,rfq_id,lane_id,customer_id,origin_city,origin_state,origin_country,destination_city,destination_state,destination_country,vehicle_profile_id,equipment_request,commodity,commodity_category,sector,weight_kg,rate_mxn,direct_cost_mxn,margin_pct,quoted_at,service_type,status
QUOTE-1,RFQ-2026-000010,RFQ-2026-000010-L01,CUST-1,Monterrey,Nuevo Leon,MX,Saltillo,Coahuila,MX,T3S2_53_DRYVAN,caja seca 53,autopartes,industrial,manufactura,12000,18000,13500,0.25,2026-01-15,spot,won
QUOTE-2,RFQ-2026-000011,RFQ-2026-000011-L01,CUST-1,Monterrey,Nuevo Leon,MX,Saltillo,Coahuila,MX,T3S2_53_DRYVAN,caja seca 53,autopartes,industrial,manufactura,,20000,15000,0.25,2026-02-15,spot,won
QUOTE-3,RFQ-2026-000012,RFQ-2026-000012-L01,CUST-2,Queretaro,Queretaro,MX,Puebla,Puebla,MX,T3S2_53_DRYVAN,caja seca 53,autopartes,industrial,manufactura,10000,24000,18000,0.25,2026-03-15,spot,won
QUOTE-4,RFQ-2026-000013,RFQ-2026-000013-L01,CUST-3,Monterrey,Nuevo Leon,MX,Saltillo,Coahuila,MX,FLATBED,plataforma,acero,industrial,manufactura,14000,17000,13000,0.24,2026-04-15,spot,won
QUOTE-5,RFQ-2026-000014,RFQ-2026-000014-L01,CUST-4,Monterrey,Nuevo Leon,MX,Saltillo,Coahuila,MX,T3S2_53_DRYVAN,caja seca 53,farmaceutico,farma,salud,8000,30000,21000,0.30,2026-05-15,spot,won
`;

const exactRouteQuery: HistoricalSearchQuery = {
  request_id: "RFQ-2026-000099-L01",
  origin: { city: "Monterrey", state: "Nuevo Leon", country: "MX" },
  destination: { city: "Saltillo", state: "Coahuila", country: "MX" },
  vehicle_profile_id: "T3S2_53_DRYVAN",
  equipment_request: "caja seca 53",
  cargo: {
    commodity: "autopartes",
    commodity_category: "industrial",
    sector: "manufactura",
    weight_kg: 12000
  },
  service_type: "spot",
  time_window: { from: "2026-01-01", to: "2026-12-31" }
};

describe("TMS adapter config factory", () => {
  it("creates a file import adapter from YAML env path config", async () => {
    const historicalQuotesPath = await createTempCsv("historical-quotes.csv", historicalQuotesCsv);
    const dir = await mkdtemp(join(tmpdir(), "quoteops-tms-config-"));
    tempDirs.push(dir);
    const quoteWritebacksPath = join(dir, "writebacks", "quotes.jsonl");
    const statusWritebacksPath = join(dir, "writebacks", "statuses.jsonl");
    const configPath = await createTempFile(
      "tms-adapter.yaml",
      `
provider: file_import
historical_quotes_path_env: TMS_HISTORICAL_QUOTES_PATH
quote_writebacks_path_env: TMS_QUOTE_WRITEBACKS_PATH
status_writebacks_path_env: TMS_STATUS_WRITEBACKS_PATH
`
    );

    const adapter = await createTmsAdapterFromConfig(configPath, {
      env: {
        TMS_HISTORICAL_QUOTES_PATH: historicalQuotesPath,
        TMS_QUOTE_WRITEBACKS_PATH: quoteWritebacksPath,
        TMS_STATUS_WRITEBACKS_PATH: statusWritebacksPath
      }
    });
    const result = await adapter.searchHistoricalQuotes(exactRouteQuery);
    const routeComparable = result.comparables.find(
      (comparable) => comparable.layer === "route_unit_cost"
    );
    const writebackResult = await adapter.writeQuoteResult({
      quote_id: "QUOTE-CONFIG-1",
      rfq_id: "RFQ-CONFIG-1",
      lane_id: "RFQ-CONFIG-1-L01",
      rate_mxn: 19000,
      currency: "MXN"
    });
    const queuedWriteback = await readFile(quoteWritebacksPath, "utf8");

    expect(adapter).toBeInstanceOf(FileImportTmsAdapter);
    expect(routeComparable).toMatchObject({
      layer: "route_unit_cost",
      count: 2,
      median_rate_mxn: 19000
    });
    expect(writebackResult).toMatchObject({ quote_id: "QUOTE-CONFIG-1", status: "queued" });
    expect(queuedWriteback).toContain("QUOTE-CONFIG-1");
  });

  it("creates an http adapter from YAML env config with interpolated authorization", async () => {
    const scripted = createScriptedFetch(jsonResponse({ ok: true }));
    const configPath = await createTempFile(
      "tms-adapter.yaml",
      `
provider: http
base_url_env: TMS_BASE_URL
headers:
  authorization: "Bearer \${TMS_API_KEY}"
health_endpoint_path: /ready
`
    );
    const adapter = await createTmsAdapterFromConfig(configPath, {
      env: {
        TMS_BASE_URL: "https://tms.example.test",
        TMS_API_KEY: "test-token"
      },
      fetch: scripted.fetch
    });

    await expect(adapter.healthCheck()).resolves.toMatchObject({ ok: true, status: "ok" });
    expect(adapter).toBeInstanceOf(HttpTmsAdapter);
    expect(scripted.calls).toHaveLength(1);
    expect(scripted.calls[0]?.url).toBe("https://tms.example.test/ready");
    expect(scripted.calls[0]?.init?.method).toBe("GET");
    expect(new Headers(scripted.calls[0]?.init?.headers).get("authorization")).toBe(
      "Bearer test-token"
    );
  });

  it("rejects a literal authorization secret in HTTP config", async () => {
    const configPath = await createTempFile(
      "tms-adapter.yaml",
      `
provider: http
base_url_env: TMS_BASE_URL
headers:
  authorization: "Bearer embedded-secret"
`
    );

    await expect(
      createTmsAdapterFromConfig(configPath, {
        env: { TMS_BASE_URL: "https://tms.example.test" }
      })
    ).rejects.toMatchObject({
      name: "TmsAdapterError",
      code: "tms_config_embedded_secret",
      details: { header: "authorization" }
    });
  });
});

describe("FileImportTmsAdapter", () => {
  it("searches historical quotes by exact route and unit", async () => {
    const historicalQuotesPath = await createTempCsv("historical-quotes.csv", historicalQuotesCsv);
    const adapter: TmsAdapter = new FileImportTmsAdapter({ historicalQuotesPath });

    const result = await adapter.searchHistoricalQuotes(exactRouteQuery);
    const routeComparable = result.comparables.find(
      (comparable) => comparable.layer === "route_unit_cost"
    );

    expect(routeComparable).toMatchObject({
      layer: "route_unit_cost",
      match_quality: "exact_route_exact_unit",
      count: 2,
      min_rate_mxn: 18000,
      median_rate_mxn: 19000,
      max_rate_mxn: 20000
    });
  });

  it("falls back to commodity and sector historicals when the route is not exact", async () => {
    const historicalQuotesPath = await createTempCsv("historical-quotes.csv", historicalQuotesCsv);
    const adapter = new FileImportTmsAdapter({ historicalQuotesPath });

    const result = await adapter.searchHistoricalQuotes({
      ...exactRouteQuery,
      origin: { city: "Apodaca", state: "Nuevo Leon", country: "MX" },
      destination: { city: "Torreon", state: "Coahuila", country: "MX" }
    });
    const commodityComparable = result.comparables.find(
      (comparable) => comparable.layer === "commodity_category"
    );

    expect(result.comparables.some((comparable) => comparable.layer === "route_unit_cost")).toBe(
      false
    );
    expect(commodityComparable).toMatchObject({
      layer: "commodity_category",
      match_quality: "same_commodity_sector_same_unit",
      count: 3,
      commodity_category: "industrial",
      sector: "manufactura",
      min_rate_mxn: 18000,
      median_rate_mxn: 20000,
      max_rate_mxn: 24000
    });
  });

  it("keeps historical search usable when the RFQ has no weight", async () => {
    const historicalQuotesPath = await createTempCsv("historical-quotes.csv", historicalQuotesCsv);
    const adapter = new FileImportTmsAdapter({ historicalQuotesPath });

    const result = await adapter.searchHistoricalQuotes({
      ...exactRouteQuery,
      cargo: { ...exactRouteQuery.cargo, weight_kg: null }
    });
    const routeComparable = result.comparables.find(
      (comparable) => comparable.layer === "route_unit_cost"
    );

    expect(routeComparable?.count).toBe(2);
    expect(result.insufficient_data).toContainEqual({
      layer: "weight_band",
      reason: "weight_kg_missing"
    });
  });
});

describe("HttpTmsAdapter", () => {
  it("analyzes strict canonical historical rows locally", async () => {
    const scripted = createScriptedFetch(jsonResponse([canonicalHistoricalRow()]));
    const adapter = new HttpTmsAdapter({
      baseUrl: "https://tms.example.test",
      fetch: scripted.fetch
    });

    const analysis = await adapter.searchHistoricalQuotes(exactRouteQuery);

    expect(analysis.request_id).toBe(exactRouteQuery.request_id);
    expect(analysis.comparables).toContainEqual(
      expect.objectContaining({
        layer: "route_unit_cost",
        count: 1,
        median_rate_mxn: 18500
      })
    );
  });

  it("keeps legacy data envelopes compatible while analyzing their rows locally", async () => {
    const scripted = createScriptedFetch(
      jsonResponse({ data: [canonicalHistoricalRow()] })
    );
    const adapter = new HttpTmsAdapter({
      baseUrl: "https://tms.example.test",
      fetch: scripted.fetch
    });

    const analysis = await adapter.searchHistoricalQuotes(exactRouteQuery);

    expect(analysis.comparables).toContainEqual(
      expect.objectContaining({ layer: "route_unit_cost", count: 1 })
    );
  });

  it("preserves an existing aggregated HistoricalAnalysis response", async () => {
    const existing = {
      request_id: exactRouteQuery.request_id,
      search_layers: ["route_unit_cost"],
      time_window: exactRouteQuery.time_window,
      comparables: [
        {
          layer: "route_unit_cost",
          match_quality: "upstream_analysis",
          count: 2,
          min_rate_mxn: 18000,
          median_rate_mxn: 19000,
          max_rate_mxn: 20000
        }
      ],
      insufficient_data: []
    };
    const scripted = createScriptedFetch(jsonResponse(existing));
    const adapter = new HttpTmsAdapter({
      baseUrl: "https://tms.example.test",
      fetch: scripted.fetch
    });

    await expect(adapter.searchHistoricalQuotes(exactRouteQuery)).resolves.toEqual(
      existing
    );
  });

  it("converts malformed historical rows to a safe connector schema error", async () => {
    const scripted = createScriptedFetch(
      jsonResponse([{ ...canonicalHistoricalRow(), unexpected: "legacy-only" }])
    );
    const adapter = new HttpTmsAdapter({
      baseUrl: "https://tms.example.test/sensitive/path",
      headers: { authorization: "Bearer secret-token" },
      fetch: scripted.fetch
    });

    const error = await adapter
      .searchHistoricalQuotes(exactRouteQuery)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TmsAdapterError);
    expect(error).toMatchObject({
      code: "invalid_response_schema",
      details: {
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: expect.any(Array),
            code: expect.any(String),
            message: expect.any(String)
          })
        ])
      }
    });
    expect(JSON.stringify(error)).not.toContain("secret-token");
    expect(JSON.stringify(error)).not.toContain("sensitive/path");
  });

  it("times out every canonical non-health operation with a safe error", async () => {
    const adapter = new HttpTmsAdapter({
      baseUrl: "https://tms.example.test/private",
      headers: { authorization: "Bearer secret-token" },
      endpoints: { writeQuote: "/quoteops/v1/quotes" },
      timeoutMs: 5,
      fetch: abortableNeverSettlingFetch
    });
    const operations = [
      () => adapter.searchHistoricalQuotes(exactRouteQuery),
      () => adapter.getUnits(),
      () => adapter.getUnitPerformance(),
      () => adapter.getAvailabilityZones(),
      () =>
        adapter.writeQuoteResult({
          quote_id: "QUOTE-TIMEOUT",
          rfq_id: "RFQ-TIMEOUT",
          lane_id: "RFQ-TIMEOUT-L01",
          rate_mxn: 18500,
          currency: "MXN"
        })
    ];

    for (const operation of operations) {
      const error = await operation().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TmsAdapterError);
      expect(error).toMatchObject({ code: "request_timeout" });
      expect(error.status).toBeUndefined();
      expect(error.details).toBeUndefined();
      expect(JSON.stringify(error)).not.toContain("secret-token");
      expect(JSON.stringify(error)).not.toContain("/private");
    }
  });

  it("applies the configured timeout to health without throwing", async () => {
    const adapter = new HttpTmsAdapter({
      baseUrl: "https://tms.example.test",
      timeoutMs: 5,
      fetch: abortableNeverSettlingFetch
    });

    await expect(adapter.healthCheck()).resolves.toMatchObject({
      ok: false,
      status: "failed"
    });
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])(
    "rejects invalid timeoutMs %s",
    (timeoutMs) => {
      expect(
        () =>
          new HttpTmsAdapter({
            baseUrl: "https://tms.example.test",
            timeoutMs
          })
      ).toThrowError(TmsAdapterError);
    }
  );

  it("reports write quote as unavailable when the TMS has no writeback endpoint", async () => {
    const scripted = createScriptedFetch(jsonResponse({ ok: true }));
    const adapter = new HttpTmsAdapter({
      baseUrl: "https://tms.example.test",
      endpoints: { health: "/health" },
      fetch: scripted.fetch
    });

    await expect(adapter.healthCheck()).resolves.toMatchObject({
      ok: true,
      capabilities: { write_quote: false }
    });
    expect(scripted.calls[0]?.url).toBe("https://tms.example.test/health");
  });

  it("validates write payloads before sending them to the TMS", async () => {
    let called = false;
    const adapter = new HttpTmsAdapter({
      baseUrl: "https://tms.example.test",
      endpoints: { writeQuote: "/quotes" },
      fetch: async () => {
        called = true;
        return new Response(JSON.stringify({ quote_id: "QUOTE-1", status: "written" }));
      }
    });

    await expect(
      adapter.writeQuoteResult({
        quote_id: "QUOTE-1",
        rfq_id: "RFQ-1",
        lane_id: "RFQ-1-L01",
        rate_mxn: -1,
        currency: "MXN"
      })
    ).rejects.toThrow();
    expect(called).toBe(false);
  });

  it("returns a failed health result when the TMS is unhealthy", async () => {
    const scripted = createScriptedFetch(
      jsonResponse({ ok: false, error: "maintenance" }, 503)
    );
    const adapter = new HttpTmsAdapter({
      baseUrl: "https://tms.example.test",
      endpoints: { health: "/health" },
      fetch: scripted.fetch
    });

    await expect(adapter.healthCheck()).resolves.toMatchObject({
      ok: false,
      status: "failed",
      capabilities: { write_quote: false },
      details: { status_code: 503, error: "maintenance" }
    });
    expect(scripted.calls[0]?.url).toBe("https://tms.example.test/health");
  });

  it("does not break quote-core when TMS health fails", async () => {
    const scripted = createScriptedFetch(
      jsonResponse({ ok: false, error: "maintenance" }, 503)
    );
    const adapter = new HttpTmsAdapter({
      baseUrl: "https://tms.example.test",
      endpoints: { health: "/health" },
      fetch: scripted.fetch
    });
    const health = await adapter.healthCheck();
    const quote = calculateQuote(quoteCoreInput);

    expect(health.ok).toBe(false);
    expect(health.details).toMatchObject({ status_code: 503, error: "maintenance" });
    expect(scripted.calls[0]?.url).toBe("https://tms.example.test/health");
    expect(quote.status).toBe("APPROVED");
    expect(quote.base_rate_mxn).toBeGreaterThan(0);
  });

  it("rejects failed status writeback without importing quote-core", async () => {
    const scripted = createScriptedFetch(jsonResponse({ error: "writeback failed" }, 500));
    const adapter = new HttpTmsAdapter({
      baseUrl: "https://tms.example.test",
      endpoints: { writeStatus: "/statuses" },
      fetch: scripted.fetch
    });

    await expect(
      adapter.writeQuoteStatus({
        entity_id: "RFQ-2026-000099-L01",
        status: "failed",
        metadata: { reason: "tms_unavailable" }
      })
    ).rejects.toMatchObject({
      name: "TmsAdapterError",
      status: 500,
      details: { error: "writeback failed" }
    });
    expect(scripted.calls[0]?.url).toBe("https://tms.example.test/statuses");
    expect(scripted.calls[0]?.init?.method).toBe("POST");
    expect(new Headers(scripted.calls[0]?.init?.headers).get("content-type")).toBe(
      "application/json"
    );
    expect(JSON.parse(String(scripted.calls[0]?.init?.body))).toMatchObject({
      entity_id: "RFQ-2026-000099-L01",
      status: "failed",
      metadata: { reason: "tms_unavailable" }
    });
  });
});

describe("FileImportTmsAdapter health", () => {
  it("reports failed health when a configured import file is unreadable", async () => {
    const adapter = new FileImportTmsAdapter({
      historicalQuotesPath: "/tmp/quoteops-missing-file.csv"
    });

    await expect(adapter.healthCheck()).resolves.toMatchObject({
      ok: false,
      status: "failed",
      capabilities: { search_historical_quotes: false }
    });
  });
});

describe("FileImportTmsAdapter writeback queue", () => {
  it("queues quote writebacks to a local JSONL file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quoteops-tms-writeback-"));
    tempDirs.push(dir);
    const quoteWritebacksPath = join(dir, "writebacks", "quotes.jsonl");
    const adapter = new FileImportTmsAdapter({ quoteWritebacksPath });

    const result = await adapter.writeQuoteResult({
      quote_id: "quote-v2-RFQ-2026-000099-L01",
      rfq_id: "RFQ-2026-000099",
      lane_id: "RFQ-2026-000099-L01",
      rate_mxn: 25000,
      currency: "MXN",
      metadata: { source: "test" }
    });
    const lines = (await readFile(quoteWritebacksPath, "utf8")).trim().split("\n");
    const queued = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;

    expect(result).toEqual({
      quote_id: "quote-v2-RFQ-2026-000099-L01",
      status: "queued"
    });
    expect(queued).toMatchObject({
      quote_id: "quote-v2-RFQ-2026-000099-L01",
      rfq_id: "RFQ-2026-000099",
      status: "queued",
      rate_mxn: 25000
    });
  });
});

interface ScriptedFetchCall {
  url: string;
  init: RequestInit | undefined;
}

function createScriptedFetch(...responses: Response[]): {
  fetch: typeof fetch;
  calls: ScriptedFetchCall[];
} {
  const calls: ScriptedFetchCall[] = [];
  const fetchFn = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const response = responses.shift();
    if (!response) {
      throw new Error(`Unexpected TMS fetch call: ${String(input)}`);
    }
    return response;
  }) as typeof fetch;

  return { fetch: fetchFn, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function canonicalHistoricalRow(): Record<string, unknown> {
  return {
    quote_id: "QUOTE-HTTP-1",
    origin_city: "Monterrey",
    origin_state: "Nuevo Leon",
    origin_country: "MX",
    destination_city: "Saltillo",
    destination_state: "Coahuila",
    destination_country: "MX",
    vehicle_profile_id: "T3S2_53_DRYVAN",
    equipment_request: "caja seca 53",
    commodity: "autopartes",
    commodity_category: "industrial",
    sector: "manufactura",
    weight_kg: 12000,
    rate_mxn: 18500,
    direct_cost_mxn: 14000,
    margin_pct: 0.24,
    quoted_at: "2026-06-15T00:00:00.000Z",
    service_type: "spot",
    status: "won"
  };
}

const abortableNeverSettlingFetch = (async (
  _input: URL | RequestInfo,
  init?: RequestInit
) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  })) as typeof fetch;

const quoteCoreInput: QuoteCoreInput = {
  rfq: {
    rfq_id: "RFQ-2026-000001",
    lane_id: "RFQ-2026-000001-L01",
    requester_email: "compras@cliente.com",
    client_id: "cliente-demo",
    business_unit_id: "general",
    origin: { city: "Monterrey", state: "Nuevo Leon", country: "MX" },
    destination: { city: "Saltillo", state: "Coahuila", country: "MX" },
    vehicle_profile_id: "T3S2_53_DRYVAN",
    cargo: {
      weight_kg: 12000,
      value_mxn: 250000,
      commodity: "autopartes",
      commodity_category: "industrial",
      sector: "manufactura",
      hazmat: false
    },
    service: { return_policy: "sin_retorno", route_policy: "cuota" },
    commercial: { target_rate_mxn: null }
  },
  manifest: {
    client_id: "cliente-demo",
    business_units: [
      {
        business_unit_id: "general",
        requester_email_domains: ["cliente.com"],
        default: true
      }
    ],
    vehicle_profiles: [
      {
        vehicle_profile_id: "T3S2_53_DRYVAN",
        business_unit_id: "general",
        payload_capacity_kg: 24000,
        fuel_loaded_km_per_l: 3,
        fuel_empty_km_per_l: 3.4,
        operator_cost_per_km_mxn: 2.5,
        pricing_model: "formula",
        diesel_price_mxn_per_liter: 24,
        margin_target_pct: 0.25,
        minimum_margin_pct: 0.18,
        maintenance_per_km_mxn: 2,
        tires_per_km_mxn: 1.25,
        fixed_overhead_per_km_mxn: 1,
        depreciation_per_km_mxn: 1.5,
        insurance_rate: 0.002,
        insurance_min_mxn: 500
      }
    ],
    route_policy: { sakbe_required: true }
  },
  route_evidence: {
    status: "resolved",
    source: "sakbe",
    km_loaded: 80,
    estimated_minutes: 85,
    tolls_mxn: 600,
    requires_return_route: false
  }
};
