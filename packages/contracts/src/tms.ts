import { z } from "zod";
import { rfqSchema } from "./rfq.js";

function isIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

const dateSchema = z.string().refine(isIsoCalendarDate, {
  message: "Expected a valid ISO calendar date in YYYY-MM-DD format"
});
const optionalMetadataSchema = z.record(z.unknown()).optional();

export const historicalSearchLayerSchema = z.enum([
  "route_unit_cost",
  "customer_type",
  "commodity_category",
  "sector",
  "weight_band",
  "service_type"
]);

export const timeWindowSchema = z
  .object({
    from: dateSchema,
    to: dateSchema
  })
  .strict()
  .refine((window) => window.from <= window.to, {
    message: "from must be less than or equal to to",
    path: ["to"]
  });

export const historicalComparableSchema = z
  .object({
    layer: historicalSearchLayerSchema,
    match_quality: z.string().min(1),
    count: z.number().int().nonnegative(),
    min_rate_mxn: z.number().finite().nonnegative(),
    p25_rate_mxn: z.number().finite().nonnegative().optional(),
    median_rate_mxn: z.number().finite().nonnegative(),
    p75_rate_mxn: z.number().finite().nonnegative().optional(),
    max_rate_mxn: z.number().finite().nonnegative(),
    avg_direct_cost_mxn: z.number().finite().nonnegative().optional(),
    avg_margin_pct: z.number().finite().optional(),
    commodity_category: z.string().min(1).optional(),
    sector: z.string().min(1).optional(),
    weight_band: z.string().min(1).optional()
  })
  .strict();

export const insufficientDataSchema = z
  .object({
    layer: historicalSearchLayerSchema,
    reason: z.string().min(1)
  })
  .strict();

export const historicalAnalysisSchema = z
  .object({
    request_id: z.string().min(1),
    search_layers: z.array(historicalSearchLayerSchema).min(1),
    time_window: timeWindowSchema,
    comparables: z.array(historicalComparableSchema),
    insufficient_data: z.array(insufficientDataSchema)
  })
  .strict();

export const customerSchema = z
  .object({
    customer_id: z.string().min(1),
    name: z.string().min(1),
    company_alias: z.string().min(1).optional(),
    customer_type: z.string().min(1).nullable().optional(),
    business_unit_id: z.string().min(1).nullable().optional(),
    metadata: optionalMetadataSchema
  })
  .strict();

export const shipmentSchema = z
  .object({
    shipment_id: z.string().min(1),
    rfq_id: z.string().min(1).optional(),
    customer_id: z.string().min(1).optional(),
    status: z.string().min(1),
    metadata: optionalMetadataSchema
  })
  .strict();

export const unitPositionSchema = z
  .object({
    unit_id: z.string().min(1),
    vehicle_profile_id: z.string().min(1).nullable().optional(),
    city: z.string().min(1),
    state: z.string().min(1),
    country: z.string().length(2),
    available_at: z.string().datetime({ offset: true }).nullable().optional(),
    metadata: optionalMetadataSchema
  })
  .strict();

export const agreementSchema = z
  .object({
    agreement_id: z.string().min(1),
    customer_id: z.string().min(1),
    lane_id: z.string().min(1).nullable().optional(),
    rate_mxn: z.number().finite().nonnegative().nullable().optional(),
    effective_from: dateSchema,
    effective_to: dateSchema.nullable().optional(),
    metadata: optionalMetadataSchema
  })
  .strict();

export const writeQuoteInputSchema = z
  .object({
    quote_id: z.string().min(1),
    rfq_id: z.string().min(1),
    lane_id: z.string().min(1),
    rate_mxn: z.number().finite().nonnegative(),
    currency: z.literal("MXN"),
    metadata: optionalMetadataSchema
  })
  .strict();

export const writeQuoteResultSchema = z
  .object({
    quote_id: z.string().min(1),
    status: z.string().min(1)
  })
  .strict();

export const writeStatusInputSchema = z
  .object({
    entity_id: z.string().min(1),
    status: z.string().min(1),
    metadata: optionalMetadataSchema
  })
  .strict();

export const writeStatusResultSchema = z
  .object({
    entity_id: z.string().min(1),
    status: z.string().min(1)
  })
  .strict();

export const healthCheckResultSchema = z
  .object({
    ok: z.boolean(),
    latency_ms: z.number().finite().nonnegative().optional(),
    checked_at: z.string().datetime({ offset: true }).optional(),
    details: optionalMetadataSchema
  })
  .strict();

export type HistoricalSearchLayer = z.infer<typeof historicalSearchLayerSchema>;
export type HistoricalAnalysis = z.infer<typeof historicalAnalysisSchema>;
export type Customer = z.infer<typeof customerSchema>;
export type Shipment = z.infer<typeof shipmentSchema>;
export type UnitPosition = z.infer<typeof unitPositionSchema>;
export type Agreement = z.infer<typeof agreementSchema>;
export type WriteQuoteInput = z.infer<typeof writeQuoteInputSchema>;
export type WriteQuoteResult = z.infer<typeof writeQuoteResultSchema>;
export type WriteStatusInput = z.infer<typeof writeStatusInputSchema>;
export type WriteStatusResult = z.infer<typeof writeStatusResultSchema>;
export type HealthCheckResult = z.infer<typeof healthCheckResultSchema>;

export interface TmsConnector {
  readRfqs(): Promise<Array<z.infer<typeof rfqSchema>>>;
  readCustomers(): Promise<Customer[]>;
  readHistoricalQuotes(): Promise<HistoricalAnalysis[]>;
  readShipments(): Promise<Shipment[]>;
  readUnitPositions(): Promise<UnitPosition[]>;
  readAgreements(): Promise<Agreement[]>;
  writeQuote(quote: WriteQuoteInput): Promise<WriteQuoteResult>;
  writeStatus(status: WriteStatusInput): Promise<WriteStatusResult>;
  healthCheck(): Promise<HealthCheckResult>;
}
