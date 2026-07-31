import { z } from "zod";
import { locationSchema } from "./rfq.js";
import {
  timeWindowSchema,
  writeQuoteInputSchema,
  writeQuoteResultSchema
} from "./tms.js";
import {
  tmsCanonicalAvailabilityZoneSchema,
  tmsCanonicalPerformanceSchema,
  tmsCanonicalUnitSchema
} from "./tmsCanonical.js";

export const TMS_HTTP_V1_CONTRACT = "quoteops-tms-http-v1" as const;

export const TMS_HTTP_V1_PATHS = {
  health: "/quoteops/v1/health",
  historical_quotes: "/quoteops/v1/historical-quotes/search",
  units: "/quoteops/v1/units",
  unit_performance: "/quoteops/v1/unit-performance",
  availability_zones: "/quoteops/v1/availability-zones",
  write_quote: "/quoteops/v1/quotes"
} as const;

export const tmsHttpV1HistoricalSearchRequestSchema = z
  .object({
    request_id: z.string().min(1),
    origin: locationSchema,
    destination: locationSchema,
    vehicle_profile_id: z.string().min(1).nullable().optional(),
    equipment_request: z.string().min(1).nullable().optional(),
    customer_id: z.string().min(1).nullable().optional(),
    customer_type: z.string().min(1).nullable().optional(),
    cargo: z
      .object({
        commodity: z.string().min(1).nullable().optional(),
        commodity_category: z.string().min(1).nullable().optional(),
        sector: z.string().min(1).nullable().optional(),
        weight_kg: z.number().finite().nonnegative().nullable().optional(),
        hazmat: z.boolean().nullable().optional(),
        temperature_controlled: z.boolean().nullable().optional()
      })
      .strict()
      .optional(),
    service_type: z.string().min(1).nullable().optional(),
    time_window: timeWindowSchema,
    max_results: z.number().int().min(1).max(500).optional()
  })
  .strict();

export type TmsHttpV1HistoricalSearchRequest = z.infer<
  typeof tmsHttpV1HistoricalSearchRequestSchema
>;

export const historicalQuoteRecordSchema = z
  .object({
    quote_id: z.string().min(1).nullable().optional(),
    rfq_id: z.string().min(1).nullable().optional(),
    lane_id: z.string().min(1).nullable().optional(),
    customer_id: z.string().min(1).nullable().optional(),
    origin_city: z.string().min(1),
    origin_state: z.string().min(1),
    origin_country: z.string().length(2),
    destination_city: z.string().min(1),
    destination_state: z.string().min(1),
    destination_country: z.string().length(2),
    vehicle_profile_id: z.string().min(1),
    equipment_request: z.string().min(1).nullable().optional(),
    commodity: z.string().min(1).nullable().optional(),
    commodity_category: z.string().min(1).nullable().optional(),
    sector: z.string().min(1).nullable().optional(),
    weight_kg: z.number().finite().nonnegative().nullable().optional(),
    rate_mxn: z.number().finite().nonnegative(),
    direct_cost_mxn: z.number().finite().nonnegative().nullable().optional(),
    margin_pct: z.number().finite().nullable().optional(),
    quoted_at: z.string().datetime({ offset: true }),
    service_type: z.string().min(1).nullable().optional(),
    status: z.string().min(1).nullable().optional()
  })
  .strict();

export const tmsHttpV1HealthSchema = z
  .object({
    ok: z.literal(true),
    status: z.literal("ok"),
    contract_version: z.literal(TMS_HTTP_V1_CONTRACT),
    capabilities: z
      .object({
        historical_quotes: z.literal(true),
        units: z.literal(true),
        unit_performance: z.literal(true),
        availability_zones: z.literal(true),
        write_quote: z.literal(true)
      })
      .strict()
  })
  .strict();

export const tmsHttpV1HistoricalResponseSchema = z.array(
  historicalQuoteRecordSchema
);

export const tmsHttpV1UnitResponseSchema = z.array(tmsCanonicalUnitSchema);
export const tmsHttpV1PerformanceResponseSchema = z.array(
  tmsCanonicalPerformanceSchema
);
export const tmsHttpV1ZoneResponseSchema = z.array(
  tmsCanonicalAvailabilityZoneSchema
);
export const tmsHttpV1WriteQuoteRequestSchema = writeQuoteInputSchema;
export const tmsHttpV1WriteQuoteResponseSchema = writeQuoteResultSchema;

export const tmsHttpV1ErrorSchema = z
  .object({
    error: z.string().min(1),
    message: z.string().min(1),
    request_id: z.string().min(1).optional()
  })
  .strict();
