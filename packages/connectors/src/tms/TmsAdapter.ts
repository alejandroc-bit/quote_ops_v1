import type {
  Agreement,
  Customer,
  HealthCheckResult,
  HistoricalAnalysis,
  Rfq,
  RfqLocation,
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

export interface TmsAdapterCapabilities {
  read_rfq: boolean;
  list_new_rfqs: boolean;
  search_historical_quotes: boolean;
  search_historical_shipments: boolean;
  read_customer: boolean;
  read_customer_agreements: boolean;
  read_unit_positions: boolean;
  read_units: boolean;
  read_unit_performance: boolean;
  read_availability_zones: boolean;
  write_quote: boolean;
  write_status: boolean;
}

export interface TmsAdapterHealthResult extends HealthCheckResult {
  status: "ok" | "failed";
  capabilities: TmsAdapterCapabilities;
}

export interface HistoricalSearchQuery {
  request_id: string;
  origin: RfqLocation;
  destination: RfqLocation;
  vehicle_profile_id?: string | null;
  equipment_request?: string | null;
  customer_id?: string | null;
  customer_type?: string | null;
  cargo?: {
    commodity?: string | null;
    commodity_category?: string | null;
    sector?: string | null;
    weight_kg?: number | null;
    hazmat?: boolean | null;
    temperature_controlled?: boolean | null;
  };
  service_type?: string | null;
  time_window: {
    from: string;
    to: string;
  };
  max_results?: number;
}

export interface ListNewRfqsQuery {
  received_after?: string;
  limit?: number;
}

export interface UnitPositionsQuery {
  city?: string;
  state?: string;
  country?: string;
  vehicle_profile_id?: string | null;
}

export interface TmsAdapter {
  healthCheck(): Promise<TmsAdapterHealthResult>;
  getRfq(rfqId: string): Promise<Rfq | null>;
  listNewRfqs(query?: ListNewRfqsQuery): Promise<Rfq[]>;
  searchHistoricalQuotes(query: HistoricalSearchQuery): Promise<HistoricalAnalysis>;
  searchHistoricalShipments(query: HistoricalSearchQuery): Promise<Shipment[]>;
  getCustomer(customerId: string): Promise<Customer | null>;
  getCustomerAgreements(customerId: string): Promise<Agreement[]>;
  getUnitPositions(query?: UnitPositionsQuery): Promise<UnitPosition[]>;
  getUnits(): Promise<TmsCanonicalUnit[]>;
  getUnitPerformance(): Promise<TmsCanonicalPerformance[]>;
  getAvailabilityZones(): Promise<TmsCanonicalAvailabilityZone[]>;
  writeQuoteResult(input: WriteQuoteInput): Promise<WriteQuoteResult>;
  writeQuoteStatus(input: WriteStatusInput): Promise<WriteStatusResult>;
}

export interface TmsAdapterErrorOptions {
  code?: string;
  status?: number;
  details?: unknown;
}

export class TmsAdapterError extends Error {
  readonly code?: string;
  readonly status?: number;
  readonly details?: unknown;

  constructor(message: string, options: TmsAdapterErrorOptions = {}) {
    super(message);
    this.name = "TmsAdapterError";
    this.code = options.code;
    this.status = options.status;
    this.details = options.details;
  }
}

export function defaultTmsAdapterCapabilities(
  overrides: Partial<TmsAdapterCapabilities> = {}
): TmsAdapterCapabilities {
  return {
    read_rfq: false,
    list_new_rfqs: false,
    search_historical_quotes: false,
    search_historical_shipments: false,
    read_customer: false,
    read_customer_agreements: false,
    read_unit_positions: false,
    read_units: false,
    read_unit_performance: false,
    read_availability_zones: false,
    write_quote: false,
    write_status: false,
    ...overrides
  };
}

export function unsupportedTmsOperation(operation: string): TmsAdapterError {
  return new TmsAdapterError(`TMS operation is not configured: ${operation}`, {
    code: `${operation}_unsupported`
  });
}
