import { z } from "zod";
import {
  agreementSchema,
  customerSchema,
  historicalAnalysisSchema,
  tmsHttpV1HistoricalResponseSchema,
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
  defaultTmsAdapterCapabilities,
  TmsAdapterError,
  unsupportedTmsOperation,
  type HistoricalSearchQuery,
  type ListNewRfqsQuery,
  type TmsAdapter,
  type TmsAdapterCapabilities,
  type TmsAdapterHealthResult,
  type UnitPositionsQuery
} from "./TmsAdapter.js";
import {
  analyzeHistoricalQuotes,
  coerceHistoricalQuoteRecord
} from "./historicalAnalysis.js";

type EndpointResolver<TArgs extends unknown[] = []> = string | ((...args: TArgs) => string);

export interface HttpTmsAdapterEndpoints {
  health?: EndpointResolver;
  getRfq?: EndpointResolver<[string]>;
  listNewRfqs?: EndpointResolver;
  searchHistoricalQuotes?: EndpointResolver;
  searchHistoricalShipments?: EndpointResolver;
  getCustomer?: EndpointResolver<[string]>;
  getCustomerAgreements?: EndpointResolver<[string]>;
  getUnitPositions?: EndpointResolver;
  getUnits?: EndpointResolver;
  getUnitPerformance?: EndpointResolver;
  getAvailabilityZones?: EndpointResolver;
  writeQuote?: EndpointResolver;
  writeStatus?: EndpointResolver;
}

export interface HttpTmsAdapterConfig {
  baseUrl: string;
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  endpoints?: HttpTmsAdapterEndpoints;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const defaultReadEndpoints: Required<
  Omit<HttpTmsAdapterEndpoints, "writeQuote" | "writeStatus">
> = {
  health: "/health",
  getRfq: (rfqId) => `/rfqs/${encodeURIComponent(rfqId)}`,
  listNewRfqs: "/rfqs/new",
  searchHistoricalQuotes: "/historical-quotes/search",
  searchHistoricalShipments: "/historical-shipments/search",
  getCustomer: (customerId) => `/customers/${encodeURIComponent(customerId)}`,
  getCustomerAgreements: (customerId) =>
    `/customers/${encodeURIComponent(customerId)}/agreements`,
  getUnitPositions: "/unit-positions",
  getUnits: "/units",
  getUnitPerformance: "/unit-performance",
  getAvailabilityZones: "/availability-zones"
};

const rfqArraySchema = z.array(rfqSchema);
const shipmentArraySchema = z.array(shipmentSchema);
const agreementArraySchema = z.array(agreementSchema);
const unitPositionArraySchema = z.array(unitPositionSchema);
const unitArraySchema = z.array(tmsCanonicalUnitSchema);
const performanceArraySchema = z.array(tmsCanonicalPerformanceSchema);
const availabilityZoneArraySchema = z.array(tmsCanonicalAvailabilityZoneSchema);
const historicalHttpResponseSchema = z.union([
  historicalAnalysisSchema,
  tmsHttpV1HistoricalResponseSchema
]);
const DEFAULT_TIMEOUT_MS = 10_000;

export class HttpTmsAdapter implements TmsAdapter {
  private readonly baseUrl: string;
  private readonly headers?: HttpTmsAdapterConfig["headers"];
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly endpoints: Required<
    Omit<HttpTmsAdapterEndpoints, "writeQuote" | "writeStatus">
  > &
    Pick<HttpTmsAdapterEndpoints, "writeQuote" | "writeStatus">;

  constructor(config: HttpTmsAdapterConfig) {
    if (!config.baseUrl) {
      throw new TmsAdapterError("HttpTmsAdapter requires baseUrl", {
        code: "base_url_missing"
      });
    }
    if (
      config.timeoutMs !== undefined &&
      (!Number.isFinite(config.timeoutMs) ||
        !Number.isInteger(config.timeoutMs) ||
        config.timeoutMs <= 0)
    ) {
      throw new TmsAdapterError(
        "HttpTmsAdapter timeoutMs must be a positive finite integer",
        { code: "invalid_timeout" }
      );
    }

    this.baseUrl = config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`;
    this.headers = config.headers;
    this.fetchFn = config.fetch ?? fetch;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.endpoints = {
      ...defaultReadEndpoints,
      ...config.endpoints,
      writeQuote: config.endpoints?.writeQuote,
      writeStatus: config.endpoints?.writeStatus
    };
  }

  async healthCheck(): Promise<TmsAdapterHealthResult> {
    const startedAt = Date.now();
    const capabilities = this.capabilities();

    try {
      const response = await this.fetchFn(this.urlFor(resolveEndpoint(this.endpoints.health, [])), {
        method: "GET",
        headers: await this.requestHeaders(false),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      const body = await parseJsonBody(response);
      const bodyOk = isRecord(body) && typeof body.ok === "boolean" ? body.ok : true;
      const ok = response.ok && bodyOk;
      const details = detailsFromHealthBody(body, response.status);

      return {
        ok,
        status: ok ? "ok" : "failed",
        latency_ms: Date.now() - startedAt,
        checked_at: new Date().toISOString(),
        capabilities,
        ...(Object.keys(details).length > 0 ? { details } : {})
      };
    } catch (error) {
      return {
        ok: false,
        status: "failed",
        latency_ms: Date.now() - startedAt,
        checked_at: new Date().toISOString(),
        capabilities,
        details: {
          error: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  async getRfq(rfqId: string): Promise<Rfq | null> {
    try {
      return await this.get(this.endpoints.getRfq, [rfqId], rfqSchema);
    } catch (error) {
      if (error instanceof TmsAdapterError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async listNewRfqs(query: ListNewRfqsQuery = {}): Promise<Rfq[]> {
    const params = new URLSearchParams();
    if (query.received_after) params.set("received_after", query.received_after);
    if (typeof query.limit === "number") params.set("limit", String(query.limit));

    return this.get(this.endpoints.listNewRfqs, [], rfqArraySchema, params);
  }

  async searchHistoricalQuotes(query: HistoricalSearchQuery): Promise<HistoricalAnalysis> {
    const parsed = await this.post(
      this.endpoints.searchHistoricalQuotes,
      [],
      query,
      historicalHttpResponseSchema
    );
    const legacyAnalysis = historicalAnalysisSchema.safeParse(parsed);
    if (legacyAnalysis.success) {
      return legacyAnalysis.data;
    }
    if (!Array.isArray(parsed)) {
      throw new TmsAdapterError("TMS response failed schema validation", {
        code: "invalid_response_schema"
      });
    }

    const records = parsed
      .map((row) => coerceHistoricalQuoteRecord(row))
      .filter((row): row is NonNullable<typeof row> => row !== null);

    return analyzeHistoricalQuotes(records, query);
  }

  async searchHistoricalShipments(query: HistoricalSearchQuery): Promise<Shipment[]> {
    return this.post(this.endpoints.searchHistoricalShipments, [], query, shipmentArraySchema);
  }

  async getCustomer(customerId: string): Promise<Customer | null> {
    try {
      return await this.get(this.endpoints.getCustomer, [customerId], customerSchema);
    } catch (error) {
      if (error instanceof TmsAdapterError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async getCustomerAgreements(customerId: string): Promise<Agreement[]> {
    return this.get(this.endpoints.getCustomerAgreements, [customerId], agreementArraySchema);
  }

  async getUnitPositions(query: UnitPositionsQuery = {}): Promise<UnitPosition[]> {
    const params = new URLSearchParams();
    if (query.city) params.set("city", query.city);
    if (query.state) params.set("state", query.state);
    if (query.country) params.set("country", query.country);
    if (query.vehicle_profile_id) params.set("vehicle_profile_id", query.vehicle_profile_id);

    return this.get(this.endpoints.getUnitPositions, [], unitPositionArraySchema, params);
  }

  async getUnits(): Promise<TmsCanonicalUnit[]> {
    return this.get(this.endpoints.getUnits, [], unitArraySchema);
  }

  async getUnitPerformance(): Promise<TmsCanonicalPerformance[]> {
    return this.get(this.endpoints.getUnitPerformance, [], performanceArraySchema);
  }

  async getAvailabilityZones(): Promise<TmsCanonicalAvailabilityZone[]> {
    return this.get(this.endpoints.getAvailabilityZones, [], availabilityZoneArraySchema);
  }

  async writeQuoteResult(input: WriteQuoteInput): Promise<WriteQuoteResult> {
    if (!this.endpoints.writeQuote) {
      throw unsupportedTmsOperation("write_quote");
    }

    return this.post(
      this.endpoints.writeQuote,
      [],
      writeQuoteInputSchema.parse(input),
      writeQuoteResultSchema
    );
  }

  async writeQuoteStatus(input: WriteStatusInput): Promise<WriteStatusResult> {
    if (!this.endpoints.writeStatus) {
      throw unsupportedTmsOperation("write_status");
    }

    return this.post(
      this.endpoints.writeStatus,
      [],
      writeStatusInputSchema.parse(input),
      writeStatusResultSchema
    );
  }

  private capabilities(): TmsAdapterCapabilities {
    return defaultTmsAdapterCapabilities({
      read_rfq: Boolean(this.endpoints.getRfq),
      list_new_rfqs: Boolean(this.endpoints.listNewRfqs),
      search_historical_quotes: Boolean(this.endpoints.searchHistoricalQuotes),
      search_historical_shipments: Boolean(this.endpoints.searchHistoricalShipments),
      read_customer: Boolean(this.endpoints.getCustomer),
      read_customer_agreements: Boolean(this.endpoints.getCustomerAgreements),
      read_unit_positions: Boolean(this.endpoints.getUnitPositions),
      read_units: Boolean(this.endpoints.getUnits),
      read_unit_performance: Boolean(this.endpoints.getUnitPerformance),
      read_availability_zones: Boolean(this.endpoints.getAvailabilityZones),
      write_quote: Boolean(this.endpoints.writeQuote),
      write_status: Boolean(this.endpoints.writeStatus)
    });
  }

  private async get<T, TArgs extends unknown[]>(
    endpoint: EndpointResolver<TArgs>,
    args: TArgs,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    params?: URLSearchParams
  ): Promise<T> {
    const url = this.urlFor(resolveEndpoint(endpoint, args));
    if (params && params.size > 0) {
      url.search = params.toString();
    }

    return this.request(url, { method: "GET" }, schema);
  }

  private async post<T, TArgs extends unknown[]>(
    endpoint: EndpointResolver<TArgs>,
    args: TArgs,
    body: unknown,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>
  ): Promise<T> {
    return this.request(
      this.urlFor(resolveEndpoint(endpoint, args)),
      {
        method: "POST",
        body: JSON.stringify(body)
      },
      schema
    );
  }

  private async request<T>(
    url: URL,
    init: RequestInit,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>
  ): Promise<T> {
    try {
      const response = await this.fetchFn(url, {
        ...init,
        headers: await this.requestHeaders(init.body !== undefined),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      const body = await parseJsonBody(response);

      if (!response.ok) {
        throw new TmsAdapterError(`TMS request failed with status ${response.status}`, {
          code: "http_request_failed",
          status: response.status,
          details: body
        });
      }

      return schema.parse(unwrapData(body));
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new TmsAdapterError("TMS response failed schema validation", {
          code: "invalid_response_schema",
          details: {
            issues: error.issues.map(({ path, code, message }) => ({
              path,
              code,
              message
            }))
          }
        });
      }
      if (isTimeoutError(error)) {
        throw new TmsAdapterError("TMS request timed out", {
          code: "request_timeout"
        });
      }
      throw error;
    }
  }

  private async requestHeaders(hasBody: boolean): Promise<Record<string, string>> {
    const configuredHeaders =
      typeof this.headers === "function" ? await this.headers() : this.headers ?? {};

    return {
      accept: "application/json",
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...configuredHeaders
    };
  }

  private urlFor(path: string): URL {
    return /^https?:\/\//i.test(path) ? new URL(path) : new URL(path, this.baseUrl);
  }
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function resolveEndpoint<TArgs extends unknown[]>(
  endpoint: EndpointResolver<TArgs>,
  args: TArgs
): string {
  return typeof endpoint === "function" ? endpoint(...args) : endpoint;
}

async function parseJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new TmsAdapterError("TMS returned invalid JSON", {
      code: "invalid_json",
      status: response.status,
      details: error instanceof Error ? error.message : String(error)
    });
  }
}

function unwrapData(body: unknown): unknown {
  if (isRecord(body) && "data" in body) {
    return body.data;
  }

  return body;
}

function detailsFromHealthBody(body: unknown, statusCode: number): Record<string, unknown> {
  const details: Record<string, unknown> = statusCode >= 400 ? { status_code: statusCode } : {};

  if (!isRecord(body)) {
    return details;
  }

  if (isRecord(body.details)) {
    Object.assign(details, body.details);
  }
  if (typeof body.error === "string") {
    details.error = body.error;
  }
  if (statusCode >= 400) {
    details.status_code = statusCode;
  }

  return details;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
