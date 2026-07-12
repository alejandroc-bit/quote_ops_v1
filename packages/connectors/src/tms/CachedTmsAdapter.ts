import { createHash } from "node:crypto";
import type {
  Agreement,
  Customer,
  HistoricalAnalysis,
  Rfq,
  Shipment,
  TmsCanonicalAvailabilityZone,
  TmsCanonicalPerformance,
  TmsCanonicalUnit,
  UnitPosition,
  WriteQuoteInput,
  WriteQuoteResult,
  WriteStatusInput,
  WriteStatusResult
} from "@quoteops/contracts";
import type { KeyValueCache } from "../cache/KeyValueCache.js";
import type {
  HistoricalSearchQuery,
  ListNewRfqsQuery,
  TmsAdapter,
  TmsAdapterHealthResult,
  UnitPositionsQuery
} from "./TmsAdapter.js";

/**
 * Wraps a TmsAdapter so read queries hit Redis before the TMS. Reference data
 * (unit types, yields, zones) is cached for an hour; live-ish data (positions)
 * for two minutes; history for 15 minutes. Writes and RFQ intake are never
 * cached. Any cache error falls through to the underlying adapter — the cache
 * is a speed-up, never a gate on quoting.
 */

const DEFAULT_TTLS = {
  unit_positions: 120,
  units: 3600,
  performance: 3600,
  availability_zones: 3600,
  historical_quotes: 900,
  historical_shipments: 900,
  customer: 1800,
  agreements: 1800
} as const;

export type CachedTmsTtls = typeof DEFAULT_TTLS;

export class CachedTmsAdapter implements TmsAdapter {
  private readonly ttls: CachedTmsTtls;

  constructor(
    private readonly inner: TmsAdapter,
    private readonly cache: KeyValueCache,
    ttls: Partial<CachedTmsTtls> = {}
  ) {
    this.ttls = { ...DEFAULT_TTLS, ...ttls };
  }

  healthCheck(): Promise<TmsAdapterHealthResult> {
    return this.inner.healthCheck();
  }

  // RFQ intake is never cached — it must reflect the TMS immediately.
  getRfq(rfqId: string): Promise<Rfq | null> {
    return this.inner.getRfq(rfqId);
  }

  listNewRfqs(query?: ListNewRfqsQuery): Promise<Rfq[]> {
    return this.inner.listNewRfqs(query);
  }

  searchHistoricalQuotes(query: HistoricalSearchQuery): Promise<HistoricalAnalysis> {
    return this.cached("historical_quotes", this.ttls.historical_quotes, query, () =>
      this.inner.searchHistoricalQuotes(query)
    );
  }

  searchHistoricalShipments(query: HistoricalSearchQuery): Promise<Shipment[]> {
    return this.cached("historical_shipments", this.ttls.historical_shipments, query, () =>
      this.inner.searchHistoricalShipments(query)
    );
  }

  getCustomer(customerId: string): Promise<Customer | null> {
    return this.cached("customer", this.ttls.customer, { customerId }, () =>
      this.inner.getCustomer(customerId)
    );
  }

  getCustomerAgreements(customerId: string): Promise<Agreement[]> {
    return this.cached("agreements", this.ttls.agreements, { customerId }, () =>
      this.inner.getCustomerAgreements(customerId)
    );
  }

  getUnitPositions(query?: UnitPositionsQuery): Promise<UnitPosition[]> {
    return this.cached("unit_positions", this.ttls.unit_positions, query ?? {}, () =>
      this.inner.getUnitPositions(query)
    );
  }

  getUnits(): Promise<TmsCanonicalUnit[]> {
    return this.cached("units", this.ttls.units, {}, () => this.inner.getUnits());
  }

  getUnitPerformance(): Promise<TmsCanonicalPerformance[]> {
    return this.cached("performance", this.ttls.performance, {}, () =>
      this.inner.getUnitPerformance()
    );
  }

  getAvailabilityZones(): Promise<TmsCanonicalAvailabilityZone[]> {
    return this.cached("availability_zones", this.ttls.availability_zones, {}, () =>
      this.inner.getAvailabilityZones()
    );
  }

  writeQuoteResult(input: WriteQuoteInput): Promise<WriteQuoteResult> {
    return this.inner.writeQuoteResult(input);
  }

  writeQuoteStatus(input: WriteStatusInput): Promise<WriteStatusResult> {
    return this.inner.writeQuoteStatus(input);
  }

  private async cached<T>(
    entity: keyof CachedTmsTtls | "customer",
    ttlSeconds: number,
    keyInput: unknown,
    load: () => Promise<T>
  ): Promise<T> {
    const key = cacheKey(entity, keyInput);
    try {
      const hit = await this.cache.get(key);
      if (hit !== null) {
        return JSON.parse(hit) as T;
      }
    } catch {
      /* cache read failure -> treat as miss */
    }

    const value = await load();
    try {
      await this.cache.set(key, JSON.stringify(value), ttlSeconds);
    } catch {
      /* cache write failure is non-fatal */
    }
    return value;
  }
}

function cacheKey(entity: string, keyInput: unknown): string {
  const hash = createHash("sha1").update(JSON.stringify(keyInput)).digest("hex");
  return `tms:${entity}:${hash}`;
}
