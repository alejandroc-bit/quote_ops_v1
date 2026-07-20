import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { HttpTmsAdapter } from "@quoteops/connectors";
// @ts-expect-error plain .mjs module without type declarations
import { createMockTmsServer } from "../../deploy/appliance/mock-tms/server.mjs";

let server: Server;
let adapter: HttpTmsAdapter;

beforeAll(async () => {
  server = createMockTmsServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  adapter = new HttpTmsAdapter({
    baseUrl: `http://127.0.0.1:${port}`,
    endpoints: { writeQuote: "/quotes", writeStatus: "/status" }
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("mock TMS speaks the real HttpTmsAdapter contract", () => {
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
