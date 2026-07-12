import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { calculateQuote, type QuoteCoreInput } from "@quoteops/quote-core";
import {
  FileImportTmsAdapter,
  HttpTmsAdapter,
  createTmsAdapterFromConfig,
  type HistoricalSearchQuery,
  type TmsAdapter
} from "../src/index";

const tempDirs: string[] = [];

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
    let receivedAuthorization: string | undefined;
    let receivedUrl: string | undefined;
    const server = await startServer((req, res) => {
      receivedAuthorization = req.headers.authorization;
      receivedUrl = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    try {
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
          TMS_BASE_URL: server.baseUrl,
          TMS_API_KEY: "test-token"
        }
      });

      await expect(adapter.healthCheck()).resolves.toMatchObject({ ok: true, status: "ok" });
      expect(adapter).toBeInstanceOf(HttpTmsAdapter);
      expect(receivedUrl).toBe("/ready");
      expect(receivedAuthorization).toBe("Bearer test-token");
    } finally {
      await server.close();
    }
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
  it("reports write quote as unavailable when the TMS has no writeback endpoint", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    try {
      const adapter = new HttpTmsAdapter({
        baseUrl: server.baseUrl,
        endpoints: { health: "/health" }
      });

      await expect(adapter.healthCheck()).resolves.toMatchObject({
        ok: true,
        capabilities: { write_quote: false }
      });
    } finally {
      await server.close();
    }
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
    const server = await startServer((_req, res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "maintenance" }));
    });

    try {
      const adapter = new HttpTmsAdapter({
        baseUrl: server.baseUrl,
        endpoints: { health: "/health" }
      });

      await expect(adapter.healthCheck()).resolves.toMatchObject({
        ok: false,
        status: "failed",
        capabilities: { write_quote: false },
        details: { status_code: 503 }
      });
    } finally {
      await server.close();
    }
  });

  it("does not break quote-core when TMS health fails", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "maintenance" }));
    });

    try {
      const adapter = new HttpTmsAdapter({
        baseUrl: server.baseUrl,
        endpoints: { health: "/health" }
      });
      const health = await adapter.healthCheck();
      const quote = calculateQuote(quoteCoreInput);

      expect(health.ok).toBe(false);
      expect(quote.status).toBe("APPROVED");
      expect(quote.base_rate_mxn).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  it("rejects failed status writeback without importing quote-core", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "writeback failed" }));
    });

    try {
      const adapter = new HttpTmsAdapter({
        baseUrl: server.baseUrl,
        endpoints: { writeStatus: "/statuses" }
      });

      await expect(
        adapter.writeQuoteStatus({
          entity_id: "RFQ-2026-000099-L01",
          status: "failed",
          metadata: { reason: "tms_unavailable" }
        })
      ).rejects.toMatchObject({
        name: "TmsAdapterError",
        status: 500
      });
    } finally {
      await server.close();
    }
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

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(handler);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected test HTTP server to listen on a local port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      })
  };
}

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
