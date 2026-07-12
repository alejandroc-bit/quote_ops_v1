import {
  agreementSchema,
  customerSchema,
  shipmentSchema,
  tmsCanonicalAvailabilityZoneSchema,
  tmsCanonicalPerformanceSchema,
  tmsCanonicalUnitSchema,
  unitPositionSchema
} from "@quoteops/contracts";
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
import {
  analyzeHistoricalQuotes,
  coerceHistoricalQuoteRecord,
  fieldNumber,
  fieldText,
  type SourceRow
} from "./historicalAnalysis.js";
import {
  defaultTmsAdapterCapabilities,
  unsupportedTmsOperation,
  type HistoricalSearchQuery,
  type ListNewRfqsQuery,
  type TmsAdapter,
  type TmsAdapterCapabilities,
  type TmsAdapterHealthResult,
  type UnitPositionsQuery
} from "./TmsAdapter.js";

/**
 * Runs the client's own SQL against their TMS database. THE QUERY IS THE
 * MAPPING: each configured SELECT must alias columns to the canonical names
 * (the same headers the file_import adapter reads), so a homegrown schema is
 * adapted by writing queries, not code. Values from the RFQ are always passed
 * as bind params — never interpolated — so a configured query cannot be turned
 * into an injection vector by request data.
 */

export type SqlRow = Record<string, unknown>;

export interface SqlExecutor {
  /** Runs a query with `:name` bind params and returns rows keyed by column. */
  query(sql: string, params: Record<string, unknown>): Promise<SqlRow[]>;
  close(): Promise<void>;
}

export type SqlQueryEntity =
  | "get_rfq"
  | "new_rfqs"
  | "historical_quotes"
  | "historical_shipments"
  | "customers"
  | "agreements"
  | "unit_positions"
  | "units"
  | "performance"
  | "availability_zones";

export interface SqlTmsAdapterConfig {
  queries: Partial<Record<SqlQueryEntity, string>>;
  write_quote?: { statement: string };
  write_status?: { statement: string };
}

export class SqlTmsAdapter implements TmsAdapter {
  constructor(
    private readonly config: SqlTmsAdapterConfig,
    private readonly executor: SqlExecutor
  ) {}

  async healthCheck(): Promise<TmsAdapterHealthResult> {
    const capabilities = this.capabilities();
    try {
      await this.executor.query("SELECT 1 AS ok", {});
      return {
        ok: true,
        status: "ok",
        checked_at: new Date().toISOString(),
        capabilities,
        details: { source: "sql" }
      };
    } catch (error) {
      // never surface the connection string, only the driver message
      return {
        ok: false,
        status: "failed",
        checked_at: new Date().toISOString(),
        capabilities,
        details: { source: "sql", error: error instanceof Error ? error.message : String(error) }
      };
    }
  }

  async getRfq(rfqId: string): Promise<Rfq | null> {
    if (!this.config.queries.get_rfq) return null;
    const rows = await this.executor.query(this.config.queries.get_rfq, { rfq_id: rfqId });
    const rfqJson = rows[0]?.rfq_json ?? rows[0]?.rfq;
    if (typeof rfqJson === "string") {
      const { rfqSchema } = await import("@quoteops/contracts");
      return rfqSchema.parse(JSON.parse(rfqJson));
    }
    return null;
  }

  async listNewRfqs(query: ListNewRfqsQuery = {}): Promise<Rfq[]> {
    if (!this.config.queries.new_rfqs) return [];
    const rows = await this.executor.query(this.config.queries.new_rfqs, {
      received_after: query.received_after ?? null,
      limit: query.limit ?? null
    });
    const { rfqSchema } = await import("@quoteops/contracts");
    return rows
      .map((row) => (typeof row.rfq_json === "string" ? row.rfq_json : null))
      .filter((value): value is string => value !== null)
      .map((value) => rfqSchema.parse(JSON.parse(value)));
  }

  async searchHistoricalQuotes(query: HistoricalSearchQuery): Promise<HistoricalAnalysis> {
    const rows = await this.runOrEmpty("historical_quotes", historicalParams(query));
    const records = rows
      .map((row) => coerceHistoricalQuoteRecord(row as SourceRow))
      .filter((record): record is NonNullable<typeof record> => record !== null);
    return analyzeHistoricalQuotes(records, query);
  }

  async searchHistoricalShipments(query: HistoricalSearchQuery): Promise<Shipment[]> {
    const rows = await this.runOrEmpty("historical_shipments", historicalParams(query));
    return rows.map((row) =>
      shipmentSchema.parse({
        shipment_id: fieldText(row, ["shipment_id", "id"]),
        rfq_id: fieldText(row, ["rfq_id"]),
        customer_id: fieldText(row, ["customer_id"]),
        status: fieldText(row, ["status"]) ?? "unknown",
        metadata: row
      })
    );
  }

  async getCustomer(customerId: string): Promise<Customer | null> {
    const rows = await this.runOrEmpty("customers", { customer_id: customerId });
    const row = rows[0];
    if (!row) return null;
    return customerSchema.parse({
      customer_id: fieldText(row, ["customer_id", "id"]),
      name: fieldText(row, ["name", "customer_name"]),
      company_alias: fieldText(row, ["company_alias", "alias"]),
      customer_type: fieldText(row, ["customer_type", "type"]),
      business_unit_id: fieldText(row, ["business_unit_id", "business_unit"]),
      metadata: row
    });
  }

  async getCustomerAgreements(customerId: string): Promise<Agreement[]> {
    const rows = await this.runOrEmpty("agreements", { customer_id: customerId });
    return rows.map((row) =>
      agreementSchema.parse({
        agreement_id: fieldText(row, ["agreement_id", "id"]),
        customer_id: fieldText(row, ["customer_id"]),
        lane_id: fieldText(row, ["lane_id"]),
        rate_mxn: fieldNumber(row, ["rate_mxn", "rate"]),
        effective_from: fieldText(row, ["effective_from", "from"]),
        effective_to: fieldText(row, ["effective_to", "to"]),
        metadata: row
      })
    );
  }

  async getUnitPositions(query: UnitPositionsQuery = {}): Promise<UnitPosition[]> {
    const rows = await this.runOrEmpty("unit_positions", {
      city: query.city ?? null,
      state: query.state ?? null,
      country: query.country ?? null,
      vehicle_profile_id: query.vehicle_profile_id ?? null
    });
    return rows.map((row) =>
      unitPositionSchema.parse({
        unit_id: fieldText(row, ["unit_id", "tractor_id", "vehicle_id"]),
        vehicle_profile_id: fieldText(row, ["vehicle_profile_id", "profile_id"]),
        city: fieldText(row, ["city"]),
        state: fieldText(row, ["state"]),
        country: fieldText(row, ["country"]),
        available_at: fieldText(row, ["available_at"]),
        metadata: row
      })
    );
  }

  async getUnits(): Promise<TmsCanonicalUnit[]> {
    const rows = await this.runOrEmpty("units", {});
    return rows.map((row) =>
      tmsCanonicalUnitSchema.parse({
        unit_id: fieldText(row, ["unit_id", "id"]),
        current_lat: fieldNumber(row, ["current_lat", "lat", "latitude"]) ?? 0,
        current_lng: fieldNumber(row, ["current_lng", "lng", "longitude"]) ?? 0,
        status: fieldText(row, ["status"]) ?? "Available",
        ...(fieldText(row, ["next_destination_city"])
          ? { next_destination_city: fieldText(row, ["next_destination_city"]) }
          : {})
      })
    );
  }

  async getUnitPerformance(): Promise<TmsCanonicalPerformance[]> {
    const rows = await this.runOrEmpty("performance", {});
    return rows.map((row) =>
      tmsCanonicalPerformanceSchema.parse({
        unit_type: fieldText(row, ["unit_type", "vehicle_profile_id", "profile_id"]),
        kpl_yield: fieldNumber(row, ["kpl_yield", "km_per_l", "rendimiento"]) ?? 0,
        real_cost_per_km: fieldNumber(row, ["real_cost_per_km", "cost_per_km", "costo_km"]) ?? 0
      })
    );
  }

  async getAvailabilityZones(): Promise<TmsCanonicalAvailabilityZone[]> {
    const rows = await this.runOrEmpty("availability_zones", {});
    return rows.map((row) =>
      tmsCanonicalAvailabilityZoneSchema.parse({
        zone_id: fieldText(row, ["zone_id", "id"]),
        city: fieldText(row, ["city"]),
        state: fieldText(row, ["state"]),
        country: fieldText(row, ["country"]),
        available_units: fieldNumber(row, ["available_units", "units"]) ?? 0
      })
    );
  }

  async writeQuoteResult(input: WriteQuoteInput): Promise<WriteQuoteResult> {
    if (!this.config.write_quote) {
      // visible, not silent: quoting still works, writeback is just not wired
      return { quote_id: input.quote_id, status: "unsupported_write" };
    }
    await this.executor.query(this.config.write_quote.statement, {
      quote_id: input.quote_id,
      rfq_id: input.rfq_id,
      lane_id: input.lane_id,
      rate_mxn: input.rate_mxn,
      currency: input.currency,
      metadata: JSON.stringify(input.metadata ?? {})
    });
    return { quote_id: input.quote_id, status: "written" };
  }

  async writeQuoteStatus(input: WriteStatusInput): Promise<WriteStatusResult> {
    if (!this.config.write_status) {
      throw unsupportedTmsOperation("write_status");
    }
    await this.executor.query(this.config.write_status.statement, {
      entity_id: input.entity_id,
      status: input.status,
      metadata: JSON.stringify(input.metadata ?? {})
    });
    return { entity_id: input.entity_id, status: "written" };
  }

  private async runOrEmpty(
    entity: SqlQueryEntity,
    params: Record<string, unknown>
  ): Promise<SqlRow[]> {
    const sql = this.config.queries[entity];
    if (!sql) return [];
    return this.executor.query(sql, params);
  }

  private capabilities(): TmsAdapterCapabilities {
    const q = this.config.queries;
    return defaultTmsAdapterCapabilities({
      read_rfq: Boolean(q.get_rfq),
      list_new_rfqs: Boolean(q.new_rfqs),
      search_historical_quotes: Boolean(q.historical_quotes),
      search_historical_shipments: Boolean(q.historical_shipments),
      read_customer: Boolean(q.customers),
      read_customer_agreements: Boolean(q.agreements),
      read_unit_positions: Boolean(q.unit_positions),
      read_units: Boolean(q.units),
      read_unit_performance: Boolean(q.performance),
      read_availability_zones: Boolean(q.availability_zones),
      write_quote: Boolean(this.config.write_quote),
      write_status: Boolean(this.config.write_status)
    });
  }
}

function historicalParams(query: HistoricalSearchQuery): Record<string, unknown> {
  return {
    origin_city: query.origin.city,
    origin_state: query.origin.state,
    origin_country: query.origin.country,
    destination_city: query.destination.city,
    destination_state: query.destination.state,
    destination_country: query.destination.country,
    vehicle_profile_id: query.vehicle_profile_id ?? null,
    equipment_request: query.equipment_request ?? null,
    customer_id: query.customer_id ?? null,
    customer_type: query.customer_type ?? null,
    commodity: query.cargo?.commodity ?? null,
    commodity_category: query.cargo?.commodity_category ?? null,
    sector: query.cargo?.sector ?? null,
    weight_kg: query.cargo?.weight_kg ?? null,
    service_type: query.service_type ?? null,
    time_from: query.time_window.from,
    time_to: query.time_window.to,
    max_results: query.max_results ?? null
  };
}
