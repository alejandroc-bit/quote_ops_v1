import { describe, expect, it } from "vitest";
import {
  CachedTmsAdapter,
  InMemoryKeyValueCache,
  defaultTmsAdapterCapabilities,
  type HistoricalSearchQuery,
  type TmsAdapter,
  type TmsAdapterHealthResult
} from "../src/index";

const query: HistoricalSearchQuery = {
  request_id: "req-1",
  origin: { city: "Monterrey", state: "Nuevo Leon", country: "MX" },
  destination: { city: "Saltillo", state: "Coahuila", country: "MX" },
  time_window: { from: "2026-01-01", to: "2026-12-31" }
};

function countingAdapter(overrides: Partial<TmsAdapter> = {}): {
  adapter: TmsAdapter;
  calls: Record<string, number>;
} {
  const calls: Record<string, number> = {};
  const bump = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  const health: TmsAdapterHealthResult = {
    ok: true,
    status: "ok",
    checked_at: "2026-01-01T00:00:00.000Z",
    capabilities: defaultTmsAdapterCapabilities()
  };
  const adapter: TmsAdapter = {
    async healthCheck() {
      bump("healthCheck");
      return health;
    },
    async getRfq() {
      bump("getRfq");
      return null;
    },
    async listNewRfqs() {
      bump("listNewRfqs");
      return [];
    },
    async searchHistoricalQuotes() {
      bump("searchHistoricalQuotes");
      return { request_id: "req-1", search_layers: [], time_window: query.time_window, comparables: [], insufficient_data: [] };
    },
    async searchHistoricalShipments() {
      bump("searchHistoricalShipments");
      return [];
    },
    async getCustomer() {
      bump("getCustomer");
      return null;
    },
    async getCustomerAgreements() {
      bump("getCustomerAgreements");
      return [];
    },
    async getUnitPositions() {
      bump("getUnitPositions");
      return [];
    },
    async getUnits() {
      bump("getUnits");
      return [{ unit_id: "T-1", current_lat: 25, current_lng: -100, status: "Available" }];
    },
    async getUnitPerformance() {
      bump("getUnitPerformance");
      return [{ unit_type: "PLAT_FULL", kpl_yield: 2.6, real_cost_per_km: 12 }];
    },
    async getAvailabilityZones() {
      bump("getAvailabilityZones");
      return [];
    },
    async writeQuoteResult(input) {
      bump("writeQuoteResult");
      return { quote_id: input.quote_id, status: "written" };
    },
    async writeQuoteStatus(input) {
      bump("writeQuoteStatus");
      return { entity_id: input.entity_id, status: "written" };
    },
    ...overrides
  };
  return { adapter, calls };
}

describe("CachedTmsAdapter", () => {
  it("serves the second identical read from cache", async () => {
    const { adapter, calls } = countingAdapter();
    const cached = new CachedTmsAdapter(adapter, new InMemoryKeyValueCache());

    const first = await cached.getUnitPerformance();
    const second = await cached.getUnitPerformance();

    expect(second).toEqual(first);
    expect(calls.getUnitPerformance).toBe(1); // second call hit the cache
  });

  it("keys by query so different searches both hit the TMS", async () => {
    const { adapter, calls } = countingAdapter();
    const cached = new CachedTmsAdapter(adapter, new InMemoryKeyValueCache());

    await cached.searchHistoricalQuotes(query);
    await cached.searchHistoricalQuotes({
      ...query,
      destination: { city: "Puebla", state: "Puebla", country: "MX" }
    });
    await cached.searchHistoricalQuotes(query); // same as first -> cached

    expect(calls.searchHistoricalQuotes).toBe(2);
  });

  it("re-fetches after the entity TTL expires", async () => {
    let now = 0;
    const cache = new InMemoryKeyValueCache(() => now);
    const { adapter, calls } = countingAdapter();
    const cached = new CachedTmsAdapter(adapter, cache, { units: 60 });

    await cached.getUnits();
    now = 30_000; // within TTL
    await cached.getUnits();
    expect(calls.getUnits).toBe(1);

    now = 61_000; // past TTL
    await cached.getUnits();
    expect(calls.getUnits).toBe(2);
  });

  it("never caches writes or RFQ intake", async () => {
    const { adapter, calls } = countingAdapter();
    const cached = new CachedTmsAdapter(adapter, new InMemoryKeyValueCache());

    await cached.getRfq("rfq-1");
    await cached.getRfq("rfq-1");
    await cached.writeQuoteResult({
      quote_id: "q-1",
      rfq_id: "r-1",
      lane_id: "l-1",
      rate_mxn: 1,
      currency: "MXN"
    });
    await cached.writeQuoteResult({
      quote_id: "q-1",
      rfq_id: "r-1",
      lane_id: "l-1",
      rate_mxn: 1,
      currency: "MXN"
    });

    expect(calls.getRfq).toBe(2);
    expect(calls.writeQuoteResult).toBe(2);
  });

  it("falls through to the TMS when the cache throws", async () => {
    const brokenCache = {
      async get() {
        throw new Error("redis down");
      },
      async set() {
        throw new Error("redis down");
      },
      async close() {}
    };
    const { adapter, calls } = countingAdapter();
    const cached = new CachedTmsAdapter(adapter, brokenCache);

    const result = await cached.getUnits();
    expect(result[0]!.unit_id).toBe("T-1");
    expect(calls.getUnits).toBe(1);
  });
});
