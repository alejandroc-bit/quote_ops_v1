import { z } from "zod";
import { assertSecretRef } from "./dataClassification.js";

const numericStringSchema = z.string().refine((value) => {
  if (value.trim().length === 0) return false;
  return Number.isFinite(Number(value));
}, "Expected a finite number or non-empty numeric string");

const finiteNumberSchema = z
  .union([z.number().finite(), numericStringSchema])
  .transform((value) => (typeof value === "number" ? value : Number(value)));
const nonnegativeFiniteNumberSchema = finiteNumberSchema.pipe(z.number().finite().nonnegative());
const nonnegativeIntegerSchema = finiteNumberSchema.pipe(z.number().int().nonnegative());
const latitudeSchema = finiteNumberSchema.pipe(z.number().finite().min(-90).max(90));
const longitudeSchema = finiteNumberSchema.pipe(z.number().finite().min(-180).max(180));
const sourceFieldSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

export const tmsCanonicalStatusSchema = z.enum(["Available", "En_Ruta", "Mantenimiento"]);

export const tmsCanonicalUnitSchema = z
  .object({
    unit_id: z.string().min(1),
    current_lat: latitudeSchema,
    current_lng: longitudeSchema,
    status: tmsCanonicalStatusSchema,
    next_destination_city: z.string().min(1).optional()
  })
  .strict();

export const tmsCanonicalRouteSchema = z
  .object({
    route_id: z.string().min(1),
    origin_city: z.string().min(1),
    destination_city: z.string().min(1),
    cargo_type: z.string().min(1),
    client_type: z.string().min(1),
    historical_cost: nonnegativeFiniteNumberSchema
  })
  .strict();

export const tmsCanonicalPerformanceSchema = z
  .object({
    unit_type: z.string().min(1),
    kpl_yield: nonnegativeFiniteNumberSchema,
    real_cost_per_km: nonnegativeFiniteNumberSchema
  })
  .strict();

export const tmsCanonicalPricingHistorySchema = z
  .object({
    pricing_history_id: z.string().min(1),
    route_id: z.string().min(1),
    client_id: z.string().min(1),
    cargo_type: z.string().min(1),
    quoted_price: nonnegativeFiniteNumberSchema,
    quoted_at: z.string().datetime({ offset: true })
  })
  .strict();

export const tmsCanonicalLiquidationSchema = z
  .object({
    liquidation_id: z.string().min(1),
    unit_id: z.string().min(1),
    route_id: z.string().min(1),
    settled_cost: nonnegativeFiniteNumberSchema,
    settled_at: z.string().datetime({ offset: true })
  })
  .strict();

export const tmsCanonicalAvailabilityZoneSchema = z
  .object({
    zone_id: z.string().min(1),
    city: z.string().min(1),
    state: z.string().min(1),
    country: z.string().length(2),
    available_units: nonnegativeIntegerSchema
  })
  .strict();

export const tmsMappingEntitySchema = z.enum([
  "units",
  "routes",
  "performance",
  "pricing_history",
  "liquidations",
  "availability_zones"
]);

export const tmsMappingCapabilitiesSchema = z
  .object({
    units: z.boolean().optional(),
    routes: z.boolean().optional(),
    performance: z.boolean().optional(),
    pricing_history: z.boolean().optional(),
    liquidations: z.boolean().optional(),
    availability_zones: z.boolean().optional()
  })
  .strict();

export const tmsMappingDriftStatusSchema = z.enum(["not_validated", "valid", "drift_detected"]);

export const tmsCanonicalUnitFieldMapSchema = z
  .object({
    unit_id: sourceFieldSchema.optional(),
    current_lat: sourceFieldSchema.optional(),
    current_lng: sourceFieldSchema.optional(),
    status: sourceFieldSchema.optional(),
    next_destination_city: sourceFieldSchema.optional()
  })
  .strict();

export const tmsCanonicalRouteFieldMapSchema = z
  .object({
    route_id: sourceFieldSchema.optional(),
    origin_city: sourceFieldSchema.optional(),
    destination_city: sourceFieldSchema.optional(),
    cargo_type: sourceFieldSchema.optional(),
    client_type: sourceFieldSchema.optional(),
    historical_cost: sourceFieldSchema.optional()
  })
  .strict();

export const tmsCanonicalPerformanceFieldMapSchema = z
  .object({
    unit_type: sourceFieldSchema.optional(),
    kpl_yield: sourceFieldSchema.optional(),
    real_cost_per_km: sourceFieldSchema.optional()
  })
  .strict();

export const tmsCanonicalPricingHistoryFieldMapSchema = z
  .object({
    pricing_history_id: sourceFieldSchema.optional(),
    route_id: sourceFieldSchema.optional(),
    client_id: sourceFieldSchema.optional(),
    cargo_type: sourceFieldSchema.optional(),
    quoted_price: sourceFieldSchema.optional(),
    quoted_at: sourceFieldSchema.optional()
  })
  .strict();

export const tmsCanonicalLiquidationFieldMapSchema = z
  .object({
    liquidation_id: sourceFieldSchema.optional(),
    unit_id: sourceFieldSchema.optional(),
    route_id: sourceFieldSchema.optional(),
    settled_cost: sourceFieldSchema.optional(),
    settled_at: sourceFieldSchema.optional()
  })
  .strict();

export const tmsCanonicalAvailabilityZoneFieldMapSchema = z
  .object({
    zone_id: sourceFieldSchema.optional(),
    city: sourceFieldSchema.optional(),
    state: sourceFieldSchema.optional(),
    country: sourceFieldSchema.optional(),
    available_units: sourceFieldSchema.optional()
  })
  .strict();

export const tmsMappingJsonSchema = z
  .object({
    units: tmsCanonicalUnitFieldMapSchema.optional(),
    routes: tmsCanonicalRouteFieldMapSchema.optional(),
    performance: tmsCanonicalPerformanceFieldMapSchema.optional(),
    pricing_history: tmsCanonicalPricingHistoryFieldMapSchema.optional(),
    liquidations: tmsCanonicalLiquidationFieldMapSchema.optional(),
    availability_zones: tmsCanonicalAvailabilityZoneFieldMapSchema.optional()
  })
  .strict();

const httpEndpointUrlSchema = z.string().url().refine((value) => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}, "endpoint_url must use http or https");

export const tmsMappingConfigSchema = z
  .object({
    client_id: z.string().min(1),
    endpoint_url: httpEndpointUrlSchema,
    auth_method: z.literal("api_key"),
    api_key_env: z.string().transform((value) => assertSecretRef(value)),
    transport: z.literal("http"),
    mapping_engine: z.literal("jsonpath"),
    schema_hash: z.string().min(1),
    mappings: z
      .object({
        units: z.string().min(1).optional(),
        routes: z.string().min(1).optional(),
        performance: z.string().min(1).optional(),
        pricing_history: z.string().min(1).optional(),
        liquidations: z.string().min(1).optional(),
        availability_zones: z.string().min(1).optional()
      })
      .strict(),
    mapping_json: tmsMappingJsonSchema.optional(),
    capabilities: tmsMappingCapabilitiesSchema.optional(),
    validation_timestamp: z.string().datetime({ offset: true }).optional(),
    drift_status: tmsMappingDriftStatusSchema.optional(),
    runtime_ai_calls_allowed: z.literal(false)
  })
  .strict();

export type TmsCanonicalStatus = z.infer<typeof tmsCanonicalStatusSchema>;
export type TmsCanonicalUnit = z.infer<typeof tmsCanonicalUnitSchema>;
export type TmsCanonicalRoute = z.infer<typeof tmsCanonicalRouteSchema>;
export type TmsCanonicalPerformance = z.infer<typeof tmsCanonicalPerformanceSchema>;
export type TmsCanonicalPricingHistory = z.infer<typeof tmsCanonicalPricingHistorySchema>;
export type TmsCanonicalLiquidation = z.infer<typeof tmsCanonicalLiquidationSchema>;
export type TmsCanonicalAvailabilityZone = z.infer<typeof tmsCanonicalAvailabilityZoneSchema>;
export type TmsMappingEntity = z.infer<typeof tmsMappingEntitySchema>;
export type TmsMappingCapabilities = z.infer<typeof tmsMappingCapabilitiesSchema>;
export type TmsMappingDriftStatus = z.infer<typeof tmsMappingDriftStatusSchema>;
export type TmsMappingJson = z.infer<typeof tmsMappingJsonSchema>;
export type TmsMappingConfig = z.infer<typeof tmsMappingConfigSchema>;
