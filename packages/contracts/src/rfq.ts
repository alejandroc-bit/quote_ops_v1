import { z } from "zod";

const optionalNullableStringSchema = z.string().min(1).nullable();
const moneySchema = z.number().finite().nonnegative().nullable();

export const sourceSchema = z.enum(["email", "api", "manual", "tms"]);

export const rfqIdSchema = z.string().regex(/^RFQ-\d{4}-\d{6}$/);

export const laneIdSchema = z.string().regex(/^RFQ-\d{4}-\d{6}-L\d{2,}$/);

export const locationSchema = z
  .object({
    city: z.string().min(1),
    state: z.string().min(1),
    country: z.string().length(2)
  })
  .strict();

export const requesterSchema = z
  .object({
    name: z.string().min(1),
    email: z.string().email(),
    company_alias: z.string().min(1)
  })
  .strict();

export const rawRfqSchema = z
  .object({
    subject: z.string(),
    body: z.string(),
    attachments: z.array(z.string())
  })
  .strict();

export const cargoSchema = z
  .object({
    commodity: optionalNullableStringSchema,
    commodity_category: optionalNullableStringSchema,
    sector: optionalNullableStringSchema,
    weight_kg: z.number().finite().nonnegative().nullable(),
    value_mxn: moneySchema,
    hazmat: z.boolean(),
    temperature_controlled: z.boolean()
  })
  .strict();

export const serviceSchema = z
  .object({
    return_policy: z.string().min(1),
    route_policy: z.string().min(1),
    requested_pickup_at: z.string().datetime({ offset: true }).nullable()
  })
  .strict();

export const commercialSchema = z
  .object({
    target_rate_mxn: moneySchema,
    customer_id: optionalNullableStringSchema,
    customer_type: optionalNullableStringSchema,
    business_unit_id: optionalNullableStringSchema
  })
  .strict();

export const confidenceSchema = z
  .object({
    overall: z.number().finite().min(0).max(1),
    missing_fields: z.array(z.string().min(1)),
    review_reasons: z.array(z.string().min(1))
  })
  .strict();

export const rfqLaneSchema = z
  .object({
    lane_id: laneIdSchema,
    origin: locationSchema,
    destination: locationSchema,
    equipment_request: z.string().min(1),
    vehicle_profile_id: optionalNullableStringSchema,
    cargo: cargoSchema,
    service: serviceSchema,
    commercial: commercialSchema,
    confidence: confidenceSchema
  })
  .strict();

export const parsedRfqSchema = z
  .object({
    lanes: z.array(rfqLaneSchema).min(1)
  })
  .strict();

export const rfqSchema = z
  .object({
    rfq_id: rfqIdSchema,
    source: sourceSchema,
    received_at: z.string().datetime({ offset: true }),
    requester: requesterSchema,
    raw: rawRfqSchema,
    parsed: parsedRfqSchema
  })
  .strict();

export type RfqSource = z.infer<typeof sourceSchema>;
export type Rfq = z.infer<typeof rfqSchema>;
export type RfqLane = z.infer<typeof rfqLaneSchema>;
export type RfqRequester = z.infer<typeof requesterSchema>;
export type RfqLocation = z.infer<typeof locationSchema>;
