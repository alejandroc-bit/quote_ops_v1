import { access, appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse } from "csv-parse/sync";
import {
  agreementSchema,
  customerSchema,
  rfqSchema,
  shipmentSchema,
  tmsCanonicalAvailabilityZoneSchema,
  tmsCanonicalPerformanceSchema,
  tmsCanonicalUnitSchema,
  unitPositionSchema,
  writeQuoteInputSchema,
  writeQuoteResultSchema,
  writeStatusInputSchema,
  writeStatusResultSchema
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
  coerceHistoricalQuoteRecord
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

type CsvRecord = Record<string, string | undefined>;

export interface FileImportTmsAdapterConfig {
  rfqsPath?: string;
  historicalQuotesPath?: string;
  historicalShipmentsPath?: string;
  customersPath?: string;
  agreementsPath?: string;
  unitPositionsPath?: string;
  unitsPath?: string;
  performancePath?: string;
  availabilityZonesPath?: string;
  quoteWritebacksPath?: string;
  statusWritebacksPath?: string;
}

export class FileImportTmsAdapter implements TmsAdapter {
  constructor(private readonly config: FileImportTmsAdapterConfig) {}

  async healthCheck(): Promise<TmsAdapterHealthResult> {
    const pathHealth = await this.pathHealth();
    const capabilities = this.capabilities(pathHealth.readable);
    const ok = pathHealth.failures.length === 0;

    return {
      ok,
      status: ok ? "ok" : "failed",
      checked_at: new Date().toISOString(),
      capabilities,
      details: {
        source: "file_import",
        format: "csv",
        ...(pathHealth.failures.length ? { unreadable_paths: pathHealth.failures } : {})
      }
    };
  }

  async getRfq(rfqId: string): Promise<Rfq | null> {
    const rfqs = await this.readRfqs();
    return rfqs.find((rfq) => rfq.rfq_id === rfqId) ?? null;
  }

  async listNewRfqs(query: ListNewRfqsQuery = {}): Promise<Rfq[]> {
    const rfqs = await this.readRfqs();
    const filtered = query.received_after
      ? rfqs.filter((rfq) => rfq.received_at > query.received_after!)
      : rfqs;

    return typeof query.limit === "number" ? filtered.slice(0, query.limit) : filtered;
  }

  async searchHistoricalQuotes(query: HistoricalSearchQuery): Promise<HistoricalAnalysis> {
    const records = (await readCsvRows(this.config.historicalQuotesPath))
      .map((row) => coerceHistoricalQuoteRecord(row))
      .filter((record): record is NonNullable<typeof record> => record !== null);

    return analyzeHistoricalQuotes(records, query);
  }

  async searchHistoricalShipments(query: HistoricalSearchQuery): Promise<Shipment[]> {
    const rows = await readCsvRows(this.config.historicalShipmentsPath);
    const shipments = rows
      .filter((row) => rowMatchesRoute(row, query))
      .slice(0, query.max_results)
      .map((row) =>
        shipmentSchema.parse({
          shipment_id: requiredText(row, ["shipment_id", "id"]),
          rfq_id: text(row, ["rfq_id"]),
          customer_id: text(row, ["customer_id"]),
          status: text(row, ["status"]) ?? "unknown",
          metadata: metadataFromRow(row)
        })
      );

    return shipments;
  }

  async getCustomer(customerId: string): Promise<Customer | null> {
    const customers = await this.readCustomers();
    return customers.find((customer) => customer.customer_id === customerId) ?? null;
  }

  async getCustomerAgreements(customerId: string): Promise<Agreement[]> {
    const rows = await readCsvRows(this.config.agreementsPath);

    return rows
      .filter((row) => text(row, ["customer_id"]) === customerId)
      .map((row) =>
        agreementSchema.parse({
          agreement_id: requiredText(row, ["agreement_id", "id"]),
          customer_id: requiredText(row, ["customer_id"]),
          lane_id: text(row, ["lane_id"]),
          rate_mxn: numberValue(row, ["rate_mxn", "rate"]),
          effective_from: requiredText(row, ["effective_from", "from"]),
          effective_to: text(row, ["effective_to", "to"]),
          metadata: metadataFromRow(row)
        })
      );
  }

  async getUnitPositions(query: UnitPositionsQuery = {}): Promise<UnitPosition[]> {
    const rows = await readCsvRows(this.config.unitPositionsPath);

    return rows
      .filter((row) => matchesLocationQuery(row, query))
      .map((row) =>
        unitPositionSchema.parse({
          unit_id: requiredText(row, ["unit_id", "tractor_id", "vehicle_id"]),
          vehicle_profile_id: text(row, ["vehicle_profile_id", "profile_id"]),
          city: requiredText(row, ["city"]),
          state: requiredText(row, ["state"]),
          country: requiredText(row, ["country"]),
          available_at: text(row, ["available_at"]),
          metadata: metadataFromRow(row)
        })
      );
  }

  async getUnits(): Promise<TmsCanonicalUnit[]> {
    const rows = await readCsvRows(this.config.unitsPath);
    return rows.map((row) =>
      tmsCanonicalUnitSchema.parse({
        unit_id: requiredText(row, ["unit_id", "id"]),
        current_lat: numberValue(row, ["current_lat", "lat", "latitude"]) ?? 0,
        current_lng: numberValue(row, ["current_lng", "lng", "longitude"]) ?? 0,
        status: text(row, ["status"]) ?? "Available",
        ...(text(row, ["next_destination_city"])
          ? { next_destination_city: text(row, ["next_destination_city"]) }
          : {})
      })
    );
  }

  async getUnitPerformance(): Promise<TmsCanonicalPerformance[]> {
    const rows = await readCsvRows(this.config.performancePath);
    return rows.map((row) =>
      tmsCanonicalPerformanceSchema.parse({
        unit_type: requiredText(row, ["unit_type", "vehicle_profile_id", "profile_id"]),
        kpl_yield: numberValue(row, ["kpl_yield", "km_per_l", "rendimiento"]) ?? 0,
        real_cost_per_km: numberValue(row, ["real_cost_per_km", "cost_per_km", "costo_km"]) ?? 0
      })
    );
  }

  async getAvailabilityZones(): Promise<TmsCanonicalAvailabilityZone[]> {
    const rows = await readCsvRows(this.config.availabilityZonesPath);
    return rows.map((row) =>
      tmsCanonicalAvailabilityZoneSchema.parse({
        zone_id: requiredText(row, ["zone_id", "id"]),
        city: requiredText(row, ["city"]),
        state: requiredText(row, ["state"]),
        country: requiredText(row, ["country"]),
        available_units: numberValue(row, ["available_units", "units"]) ?? 0
      })
    );
  }

  async writeQuoteResult(input: WriteQuoteInput): Promise<WriteQuoteResult> {
    if (!this.config.quoteWritebacksPath) {
      throw unsupportedTmsOperation("write_quote");
    }

    const parsed = writeQuoteInputSchema.parse(input);
    const result = writeQuoteResultSchema.parse({
      quote_id: parsed.quote_id,
      status: "queued"
    });

    await appendJsonLine(this.config.quoteWritebacksPath, {
      ...parsed,
      status: result.status,
      queued_at: new Date().toISOString()
    });

    return result;
  }

  async writeQuoteStatus(input: WriteStatusInput): Promise<WriteStatusResult> {
    if (!this.config.statusWritebacksPath) {
      throw unsupportedTmsOperation("write_status");
    }

    const parsed = writeStatusInputSchema.parse(input);
    const result = writeStatusResultSchema.parse({
      entity_id: parsed.entity_id,
      status: "queued"
    });

    await appendJsonLine(this.config.statusWritebacksPath, {
      ...parsed,
      status: result.status,
      queued_at: new Date().toISOString()
    });

    return result;
  }

  private async readRfqs(): Promise<Rfq[]> {
    const rows = await readCsvRows(this.config.rfqsPath);

    return rows.map(mapRfqRow).filter(isRfq);
  }

  private async readCustomers(): Promise<Customer[]> {
    const rows = await readCsvRows(this.config.customersPath);

    return rows.map((row) =>
      customerSchema.parse({
        customer_id: requiredText(row, ["customer_id", "id"]),
        name: requiredText(row, ["name", "customer_name"]),
        company_alias: text(row, ["company_alias", "alias"]),
        customer_type: text(row, ["customer_type", "type"]),
        business_unit_id: text(row, ["business_unit_id", "business_unit"]),
        metadata: metadataFromRow(row)
      })
    );
  }

  private capabilities(readable: Partial<Record<keyof FileImportTmsAdapterConfig, boolean>> = {}): TmsAdapterCapabilities {
    return defaultTmsAdapterCapabilities({
      read_rfq: Boolean(this.config.rfqsPath && readable.rfqsPath !== false),
      list_new_rfqs: Boolean(this.config.rfqsPath && readable.rfqsPath !== false),
      search_historical_quotes: Boolean(
        this.config.historicalQuotesPath && readable.historicalQuotesPath !== false
      ),
      search_historical_shipments: Boolean(
        this.config.historicalShipmentsPath && readable.historicalShipmentsPath !== false
      ),
      read_customer: Boolean(this.config.customersPath && readable.customersPath !== false),
      read_customer_agreements: Boolean(
        this.config.agreementsPath && readable.agreementsPath !== false
      ),
      read_unit_positions: Boolean(
        this.config.unitPositionsPath && readable.unitPositionsPath !== false
      ),
      read_units: Boolean(this.config.unitsPath && readable.unitsPath !== false),
      read_unit_performance: Boolean(
        this.config.performancePath && readable.performancePath !== false
      ),
      read_availability_zones: Boolean(
        this.config.availabilityZonesPath && readable.availabilityZonesPath !== false
      ),
      write_quote: Boolean(
        this.config.quoteWritebacksPath && readable.quoteWritebacksPath !== false
      ),
      write_status: Boolean(
        this.config.statusWritebacksPath && readable.statusWritebacksPath !== false
      )
    });
  }

  private async pathHealth(): Promise<{
    readable: Partial<Record<keyof FileImportTmsAdapterConfig, boolean>>;
    failures: Array<{ key: keyof FileImportTmsAdapterConfig; path: string; error: string }>;
  }> {
    const readable: Partial<Record<keyof FileImportTmsAdapterConfig, boolean>> = {};
    const failures: Array<{ key: keyof FileImportTmsAdapterConfig; path: string; error: string }> = [];

    await Promise.all(
      (Object.entries(this.config) as Array<[keyof FileImportTmsAdapterConfig, string | undefined]>)
        .filter((entry): entry is [keyof FileImportTmsAdapterConfig, string] => Boolean(entry[1]))
        .map(async ([key, path]) => {
          try {
            if (isWritebackPathKey(key)) {
              await ensureWritableTarget(path);
            } else {
              await access(path);
            }
            readable[key] = true;
          } catch (error) {
            readable[key] = false;
            failures.push({
              key,
              path,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        })
    );

    return { readable, failures };
  }
}

function isWritebackPathKey(key: keyof FileImportTmsAdapterConfig): boolean {
  return key === "quoteWritebacksPath" || key === "statusWritebacksPath";
}

async function ensureWritableTarget(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await access(dirname(path));
}

async function appendJsonLine(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(payload)}\n`, "utf8");
}

async function readCsvRows(path: string | undefined): Promise<CsvRecord[]> {
  if (!path) {
    return [];
  }

  const content = await readFile(path, "utf8");
  if (!content.trim()) {
    return [];
  }

  return parse(content, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    trim: true
  }) as CsvRecord[];
}

function mapRfqRow(row: CsvRecord): Rfq | null {
  const rfqJson = text(row, ["rfq_json", "rfq"]);
  if (rfqJson) {
    return rfqSchema.parse(JSON.parse(rfqJson));
  }

  const rfqId = text(row, ["rfq_id"]);
  const laneId = text(row, ["lane_id"]);
  const originCity = text(row, ["origin_city"]);
  const originState = text(row, ["origin_state"]);
  const destinationCity = text(row, ["destination_city"]);
  const destinationState = text(row, ["destination_state"]);

  if (!rfqId || !laneId || !originCity || !originState || !destinationCity || !destinationState) {
    return null;
  }

  return rfqSchema.parse({
    rfq_id: rfqId,
    source: "tms",
    received_at: toDateTime(text(row, ["received_at", "created_at"])) ?? new Date().toISOString(),
    requester: {
      name: text(row, ["requester_name"]) ?? "TMS Import",
      email: text(row, ["requester_email"]) ?? "tms-import@example.com",
      company_alias: text(row, ["company_alias"]) ?? "TMS"
    },
    raw: {
      subject: text(row, ["subject"]) ?? `TMS RFQ ${rfqId}`,
      body: text(row, ["body"]) ?? "",
      attachments: []
    },
    parsed: {
      lanes: [
        {
          lane_id: laneId,
          origin: {
            city: originCity,
            state: originState,
            country: text(row, ["origin_country"]) ?? "MX"
          },
          destination: {
            city: destinationCity,
            state: destinationState,
            country: text(row, ["destination_country"]) ?? "MX"
          },
          equipment_request: text(row, ["equipment_request"]) ?? "unspecified",
          vehicle_profile_id: text(row, ["vehicle_profile_id"]),
          cargo: {
            commodity: text(row, ["commodity"]),
            commodity_category: text(row, ["commodity_category"]),
            sector: text(row, ["sector"]),
            weight_kg: numberValue(row, ["weight_kg"]),
            value_mxn: numberValue(row, ["value_mxn"]),
            hazmat: booleanValue(row, ["hazmat"]) ?? false,
            temperature_controlled: booleanValue(row, ["temperature_controlled"]) ?? false
          },
          service: {
            return_policy: text(row, ["return_policy"]) ?? "unspecified",
            route_policy: text(row, ["route_policy"]) ?? "unspecified",
            requested_pickup_at: toDateTime(text(row, ["requested_pickup_at"]))
          },
          commercial: {
            target_rate_mxn: numberValue(row, ["target_rate_mxn"]),
            customer_id: text(row, ["customer_id"]),
            customer_type: text(row, ["customer_type"]),
            business_unit_id: text(row, ["business_unit_id"])
          },
          confidence: {
            overall: numberValue(row, ["confidence_overall"]) ?? 0.5,
            missing_fields: [],
            review_reasons: []
          }
        }
      ]
    }
  });
}

function isRfq(rfq: Rfq | null): rfq is Rfq {
  return rfq !== null;
}

function rowMatchesRoute(row: CsvRecord, query: HistoricalSearchQuery): boolean {
  return (
    normalized(text(row, ["origin_city"])) === normalized(query.origin.city) &&
    normalized(text(row, ["origin_state"])) === normalized(query.origin.state) &&
    normalized(text(row, ["destination_city"])) === normalized(query.destination.city) &&
    normalized(text(row, ["destination_state"])) === normalized(query.destination.state)
  );
}

function matchesLocationQuery(row: CsvRecord, query: UnitPositionsQuery): boolean {
  return (
    matchesOptional(text(row, ["city"]), query.city) &&
    matchesOptional(text(row, ["state"]), query.state) &&
    matchesOptional(text(row, ["country"]), query.country) &&
    matchesOptional(text(row, ["vehicle_profile_id", "profile_id"]), query.vehicle_profile_id)
  );
}

function matchesOptional(actual: string | null, expected: string | null | undefined): boolean {
  if (!expected) {
    return true;
  }

  return normalized(actual) === normalized(expected);
}

function text(row: CsvRecord, names: string[]): string | null {
  for (const name of names) {
    const value = row[name]?.trim();
    if (value) {
      return value;
    }
  }

  return null;
}

function requiredText(row: CsvRecord, names: string[]): string {
  const value = text(row, names);
  if (!value) {
    throw new Error(`Missing required CSV field: ${names.join(" or ")}`);
  }

  return value;
}

function numberValue(row: CsvRecord, names: string[]): number | null {
  const value = text(row, names);
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanValue(row: CsvRecord, names: string[]): boolean | null {
  const value = text(row, names);
  if (!value) {
    return null;
  }

  return ["1", "true", "yes", "si", "sí"].includes(normalized(value));
}

function normalized(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase();
}

function toDateTime(value: string | null): string | null {
  if (!value) {
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${value}T00:00:00.000Z`;
  }

  return value;
}

function metadataFromRow(row: CsvRecord): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).filter(([, value]) => value !== undefined && value.trim() !== "")
  );
}
