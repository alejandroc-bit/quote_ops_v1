import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { HttpTmsAdapter } from "@quoteops/connectors";
import {
  historicalQuoteRecordSchema,
  TMS_HTTP_V1_CONTRACT,
  TMS_HTTP_V1_PATHS,
  tmsHttpV1ErrorSchema,
  tmsHttpV1HealthSchema
} from "@quoteops/contracts";
// @ts-expect-error plain .mjs module without type declarations
import { createMockTmsServer } from "../../deploy/appliance/mock-tms/server.mjs";

let server: Server;
let adapter: HttpTmsAdapter;
let v1Adapter: HttpTmsAdapter;
let baseUrl: string;
const testToken = "mock-tms-contract-token";

beforeAll(async () => {
  server = createMockTmsServer({ token: testToken });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  adapter = new HttpTmsAdapter({
    baseUrl,
    endpoints: { writeQuote: "/quotes", writeStatus: "/status" }
  });
  v1Adapter = new HttpTmsAdapter({
    baseUrl,
    headers: { authorization: `Bearer ${testToken}` },
    endpoints: {
      health: TMS_HTTP_V1_PATHS.health,
      searchHistoricalQuotes: TMS_HTTP_V1_PATHS.historical_quotes,
      getUnits: TMS_HTTP_V1_PATHS.units,
      getUnitPerformance: TMS_HTTP_V1_PATHS.unit_performance,
      getAvailabilityZones: TMS_HTTP_V1_PATHS.availability_zones,
      writeQuote: TMS_HTTP_V1_PATHS.write_quote
    }
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("mock TMS speaks the real HttpTmsAdapter contract", () => {
  it("requires the configured Bearer token on every canonical and inspection route", async () => {
    const canonicalRoutes = [
      ["GET", TMS_HTTP_V1_PATHS.health],
      ["POST", TMS_HTTP_V1_PATHS.historical_quotes],
      ["GET", TMS_HTTP_V1_PATHS.units],
      ["GET", TMS_HTTP_V1_PATHS.unit_performance],
      ["GET", TMS_HTTP_V1_PATHS.availability_zones],
      ["POST", TMS_HTTP_V1_PATHS.write_quote],
      ["GET", "/quote-writebacks"],
      ["GET", "/status-writebacks"]
    ] as const;

    for (const [method, path] of canonicalRoutes) {
      const response = await fetch(`${baseUrl}${path}`, { method });
      expect(response.status).toBe(401);
      expect(tmsHttpV1ErrorSchema.parse(await response.json())).toMatchObject({
        error: "unauthorized"
      });
    }
  });

  it("serves strict v1 health, context reads, and projected historical rows", async () => {
    const healthResponse = await fetch(`${baseUrl}${TMS_HTTP_V1_PATHS.health}`, {
      headers: authorizationHeaders()
    });
    const health = tmsHttpV1HealthSchema.parse(await healthResponse.json());
    expect(health).toEqual({
      ok: true,
      status: "ok",
      contract_version: TMS_HTTP_V1_CONTRACT,
      capabilities: {
        historical_quotes: true,
        units: true,
        unit_performance: true,
        availability_zones: true,
        write_quote: true
      }
    });

    expect((await v1Adapter.getUnits()).length).toBeGreaterThan(0);
    expect((await v1Adapter.getUnitPerformance()).length).toBeGreaterThan(0);
    expect((await v1Adapter.getAvailabilityZones()).length).toBeGreaterThan(0);

    const response = await fetch(
      `${baseUrl}${TMS_HTTP_V1_PATHS.historical_quotes}`,
      {
        method: "POST",
        headers: {
          ...authorizationHeaders(),
          "content-type": "application/json"
        },
        body: JSON.stringify(historicalSearchRequest())
      }
    );
    const rows = (await response.json()) as unknown[];
    const projected = rows.map((row) => historicalQuoteRecordSchema.parse(row));
    expect(projected).toHaveLength(10);
    expect(projected[0]).toMatchObject({
      quote_id: "LIQ-0001",
      quoted_at: "2026-03-10T00:00:00.000Z"
    });
    expect(projected[0]).not.toHaveProperty("liquidation_id");
    expect(projected[0]).not.toHaveProperty("operator_cost_mxn");

    const analysis = await v1Adapter.searchHistoricalQuotes(
      historicalSearchRequest()
    );
    expect(
      analysis.comparables.find((row) => row.layer === "route_unit_cost")
    ).toMatchObject({ count: 5, min_rate_mxn: 18100, max_rate_mxn: 21400 });
  });

  it("validates and idempotently stores canonical quote writebacks", async () => {
    const firstBody = {
      quote_id: "QUOTE-IDEMPOTENT-1",
      rfq_id: "RFQ-IDEMPOTENT-1",
      lane_id: "RFQ-IDEMPOTENT-1-L01",
      rate_mxn: 19850,
      currency: "MXN",
      metadata: {
        zeta: [{ second: 2, first: 1 }, "tail"],
        alpha: { right: 2, left: 1 }
      }
    };
    const reorderedBody = {
      metadata: {
        alpha: { left: 1, right: 2 },
        zeta: [{ first: 1, second: 2 }, "tail"]
      },
      currency: "MXN",
      rate_mxn: 19850,
      lane_id: "RFQ-IDEMPOTENT-1-L01",
      rfq_id: "RFQ-IDEMPOTENT-1",
      quote_id: "QUOTE-IDEMPOTENT-1"
    };

    const first = await postCanonicalQuote(firstBody);
    const retry = await postCanonicalQuote(reorderedBody);
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(await first.json());

    const conflict = await postCanonicalQuote({
      ...firstBody,
      rate_mxn: 19851
    });
    expect(conflict.status).toBe(409);
    expect(tmsHttpV1ErrorSchema.parse(await conflict.json())).toMatchObject({
      error: "quote_id_conflict"
    });

    const arrayOrderConflict = await postCanonicalQuote({
      ...firstBody,
      metadata: {
        ...firstBody.metadata,
        zeta: [...firstBody.metadata.zeta].reverse()
      }
    });
    expect(arrayOrderConflict.status).toBe(409);

    const inspection = await fetch(`${baseUrl}/quote-writebacks`, {
      headers: authorizationHeaders()
    });
    expect(inspection.status).toBe(200);
    expect(await inspection.json()).toHaveLength(1);
  });

  it("returns a strict 400 error for an invalid canonical quote", async () => {
    const response = await postCanonicalQuote({
      quote_id: "QUOTE-INVALID",
      rfq_id: "RFQ-INVALID"
    });

    expect(response.status).toBe(400);
    expect(tmsHttpV1ErrorSchema.parse(await response.json())).toMatchObject({
      error: "invalid_request"
    });
  });

  it("passes healthCheck", async () => {
    const health = await adapter.healthCheck();
    expect(health.ok).toBe(true);
  });

  it("serves NOM-coded units, performance, zones, positions through the real schemas", async () => {
    const units = await adapter.getUnits();
    expect(units.map((unit) => unit.unit_id)).toContain("T3S3_53_DRYVAN");
    const performance = await adapter.getUnitPerformance();
    expect(performance.find((row) => row.unit_type === "T3S3_53_DRYVAN")).toMatchObject({
      kpl_yield: 2.8,
      real_cost_per_km: 8.5
    });
    expect((await adapter.getAvailabilityZones()).length).toBeGreaterThan(0);
    expect((await adapter.getUnitPositions()).length).toBeGreaterThan(0);
  });

  it("serves customers and agreements", async () => {
    const customer = await adapter.getCustomer("VPSE2E-CUST-01");
    expect(customer?.name).toBe("Cliente Demo VPS");
    expect(await adapter.getCustomer("NOPE")).toBeNull();
    expect((await adapter.getCustomerAgreements("VPSE2E-CUST-01")).length).toBe(1);
  });

  it("answers layered historical search from liquidations (route+unit+cargo)", async () => {
    const analysis = await adapter.searchHistoricalQuotes({
      request_id: "t-1",
      origin: { city: "Guadalajara", state: "Jalisco", country: "MX" },
      destination: { city: "Monterrey", state: "Nuevo Leon", country: "MX" },
      vehicle_profile_id: "T3S3_53_DRYVAN",
      cargo: { commodity: "carga general", commodity_category: "general", sector: "industrial", weight_kg: 18000, hazmat: false },
      service_type: "cuota",
      time_window: { from: "2026-01-01", to: "2026-12-31" }
    });
    const route = analysis.comparables.find((comp) => comp.layer === "route_unit_cost");
    expect(route).toMatchObject({ count: 5, min_rate_mxn: 18100, max_rate_mxn: 21400 });
    expect(route?.avg_direct_cost_mxn).toBeGreaterThan(0);
    expect(analysis.insufficient_data).toEqual([]);
  });

  it("reports insufficient data for an unknown route but still matches broader layers", async () => {
    const analysis = await adapter.searchHistoricalQuotes({
      request_id: "t-2",
      origin: { city: "Tijuana", state: "Baja California", country: "MX" },
      destination: { city: "Merida", state: "Yucatan", country: "MX" },
      vehicle_profile_id: "T3S3_53_DRYVAN",
      cargo: { commodity: null, commodity_category: "general", sector: "industrial", weight_kg: 18000, hazmat: false },
      service_type: "cuota",
      time_window: { from: "2026-01-01", to: "2026-12-31" }
    });
    expect(analysis.insufficient_data).toContainEqual({
      layer: "route_unit_cost",
      reason: "exact_route_unit_history_missing"
    });
    expect(analysis.comparables.find((comp) => comp.layer === "commodity_category")).toBeTruthy();
  });

  it("accepts quote and status writebacks through the real write schemas", async () => {
    const result = await adapter.writeQuoteResult({
      quote_id: "quote-v2-RFQ-2026-000001-L01",
      rfq_id: "RFQ-2026-000001",
      lane_id: "RFQ-2026-000001-L01",
      rate_mxn: 19850,
      currency: "MXN",
      metadata: { source: "mock-tms-contract-test" }
    });
    expect(result).toEqual({ quote_id: "quote-v2-RFQ-2026-000001-L01", status: "written" });
    const status = await adapter.writeQuoteStatus({ entity_id: "RFQ-2026-000001", status: "quoted" });
    expect(status).toEqual({ entity_id: "RFQ-2026-000001", status: "written" });
  });
});

function authorizationHeaders(): Record<string, string> {
  return { authorization: `Bearer ${testToken}` };
}

function historicalSearchRequest() {
  return {
    request_id: "t-v1",
    origin: { city: "Guadalajara", state: "Jalisco", country: "MX" },
    destination: { city: "Monterrey", state: "Nuevo Leon", country: "MX" },
    vehicle_profile_id: "T3S3_53_DRYVAN",
    cargo: {
      commodity: null,
      commodity_category: "general",
      sector: "industrial",
      weight_kg: 18000,
      hazmat: false
    },
    service_type: "cuota",
    time_window: { from: "2026-01-01", to: "2026-12-31" }
  };
}

function postCanonicalQuote(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${TMS_HTTP_V1_PATHS.write_quote}`, {
    method: "POST",
    headers: {
      ...authorizationHeaders(),
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}
