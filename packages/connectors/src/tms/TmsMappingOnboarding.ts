import { JSONPath } from "jsonpath-plus";
import { z } from "zod";
import {
  tmsCanonicalAvailabilityZoneSchema,
  tmsCanonicalLiquidationSchema,
  tmsCanonicalPerformanceSchema,
  tmsCanonicalPricingHistorySchema,
  tmsCanonicalRouteSchema,
  tmsCanonicalUnitSchema,
  tmsMappingJsonSchema,
  type TmsMappingEntity,
  type TmsMappingJson
} from "@quoteops/contracts";
import { getTmsCriticalCanonicalFields } from "./TmsSchemaDrift.js";

export const MIN_TMS_MAPPING_PROPOSAL_CONFIDENCE = 0.65;

export const tmsMappingProposalSchema = z
  .object({
    mapping_engine: z.literal("jsonpath"),
    mapping_expression: z.string().min(1),
    source_fields_used: z.array(z.string().min(1)).min(1),
    canonical_fields_covered: z.array(z.string().min(1)).min(1),
    warnings: z.array(z.string()),
    confidence: z.number().finite().min(0).max(1),
    mapping_json: tmsMappingJsonSchema.optional()
  })
  .strict();

export type TmsMappingProposal = z.infer<typeof tmsMappingProposalSchema>;
export type TmsMappingModelCallback = (prompt: string) => unknown | Promise<unknown>;

export interface ProposeTmsMappingFromSampleInput {
  client_id: string;
  entity_type: TmsMappingEntity;
  raw_json_sample: unknown;
  model: TmsMappingModelCallback;
  mapping_engine?: TmsMappingProposal["mapping_engine"];
}

export async function proposeTmsMappingFromSample(
  input: ProposeTmsMappingFromSampleInput
): Promise<TmsMappingProposal> {
  assertRawJsonSampleInput(input);
  const prompt = buildTmsMappingOnboardingPrompt(input);
  const modelResult = await input.model(prompt);

  return validateTmsMappingProposal({
    entity_type: input.entity_type,
    raw_json_sample: input.raw_json_sample,
    expected_mapping_engine: input.mapping_engine,
    proposal: modelResult
  });
}

function assertRawJsonSampleInput(input: ProposeTmsMappingFromSampleInput): void {
  const record = input as unknown as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, "sample")) {
    throw new Error("TMS mapping onboarding input must use raw_json_sample, not sample");
  }
  if (!Object.prototype.hasOwnProperty.call(record, "raw_json_sample") || record.raw_json_sample === undefined) {
    throw new Error("raw_json_sample is required for TMS mapping onboarding");
  }
}

export function buildTmsMappingOnboardingPrompt(
  input: Omit<ProposeTmsMappingFromSampleInput, "model">
): string {
  const requiredFields = getTmsCriticalCanonicalFields(input.entity_type);
  const optionalFields = TMS_OPTIONAL_CANONICAL_FIELDS[input.entity_type];
  const preferredEngine = input.mapping_engine ?? "jsonpath";

  return [
    "Create an onboarding-only TMS mapping proposal. Runtime TMS mapping is deterministic and must not call an LLM.",
    `Client: ${input.client_id}`,
    `Entity: ${input.entity_type}`,
    `Preferred mapping_engine: ${preferredEngine}`,
    `Required canonical fields: ${requiredFields.join(", ")}`,
    `Optional canonical fields: ${optionalFields.length > 0 ? optionalFields.join(", ") : "none"}`,
    "Return only strict JSON with mapping_engine, mapping_expression, source_fields_used, canonical_fields_covered, warnings, confidence, and optional mapping_json.",
    "mapping_json, when present, must use the entity key and map canonical fields to source field names or ordered fallback source field names.",
    `raw_json_sample: ${stringifyBounded(input.raw_json_sample, 8000)}`
  ].join("\n");
}

export function validateTmsMappingProposal(input: {
  entity_type: TmsMappingEntity;
  raw_json_sample: unknown;
  proposal: unknown;
  expected_mapping_engine?: TmsMappingProposal["mapping_engine"];
}): TmsMappingProposal {
  const parsed = tmsMappingProposalSchema.parse(parseProposalPayload(input.proposal));

  if (input.expected_mapping_engine && parsed.mapping_engine !== input.expected_mapping_engine) {
    throw new Error(
      `TMS mapping proposal engine mismatch: expected ${input.expected_mapping_engine}, received ${parsed.mapping_engine}`
    );
  }

  if (!isValidMappingExpression(parsed.mapping_engine, parsed.mapping_expression)) {
    throw new Error(`Invalid ${parsed.mapping_engine} mapping expression: ${parsed.mapping_expression}`);
  }

  if (parsed.confidence < MIN_TMS_MAPPING_PROPOSAL_CONFIDENCE) {
    throw new Error(
      `TMS mapping proposal confidence ${parsed.confidence} is below ${MIN_TMS_MAPPING_PROPOSAL_CONFIDENCE}`
    );
  }

  assertCanonicalCoverage(input.entity_type, parsed.canonical_fields_covered);
  assertMappingJsonCoverage(input.entity_type, parsed.mapping_json, parsed.source_fields_used);
  const selectedRows = evaluateJsonPath(input.raw_json_sample, parsed.mapping_expression);
  assertSelectedRows(input.entity_type, selectedRows);
  assertMappedSourceFieldsPresent(input.entity_type, selectedRows, parsed.mapping_json);
  parseCanonicalRows(input.entity_type, selectedRows, parsed.mapping_json);

  return parsed;
}

function assertCanonicalCoverage(entityType: TmsMappingEntity, coveredFields: readonly string[]): void {
  const covered = new Set(coveredFields);
  const missing = getTmsCriticalCanonicalFields(entityType).filter((field) => !covered.has(field));
  if (missing.length > 0) {
    throw new Error(`TMS mapping proposal missing canonical fields for ${entityType}: ${missing.join(", ")}`);
  }
}

function assertMappingJsonCoverage(
  entityType: TmsMappingEntity,
  mappingJson: TmsMappingJson | undefined,
  sourceFieldsUsed: readonly string[]
): void {
  if (!mappingJson) return;

  const entityMap = mappingJson[entityType];
  if (!entityMap) {
    throw new Error(`TMS mapping proposal mapping_json is missing entity map: ${entityType}`);
  }

  const fieldMap = entityMap as Record<string, string | string[] | undefined>;
  const missing = getTmsCriticalCanonicalFields(entityType).filter(
    (field) => !Object.prototype.hasOwnProperty.call(fieldMap, field) || fieldMap[field] === undefined
  );
  if (missing.length > 0) {
    throw new Error(`TMS mapping proposal mapping_json missing fields for ${entityType}: ${missing.join(", ")}`);
  }

  const sourceFieldSet = new Set(sourceFieldsUsed);
  const mappedSourceFields = Object.values(fieldMap).flatMap((value) => {
    if (value === undefined) return [];
    return Array.isArray(value) ? value : [value];
  });
  const undocumentedSourceFields = mappedSourceFields.filter((field) => !sourceFieldSet.has(field));
  if (undocumentedSourceFields.length > 0) {
    throw new Error(
      `TMS mapping proposal mapping_json references source fields not listed in source_fields_used: ${[
        ...new Set(undocumentedSourceFields)
      ].join(", ")}`
    );
  }
}

function evaluateJsonPath(rawJsonSample: unknown, expression: string): unknown[] {
  if (rawJsonSample === undefined) {
    throw new Error("raw_json_sample is required for TMS mapping proposal validation");
  }

  try {
    const result = JSONPath({
      path: expression,
      json: rawJsonSample as JsonPathRoot,
      wrap: true
    });
    if (!Array.isArray(result)) {
      throw new Error("JSONPath did not return an array");
    }
    if (result.length === 0) {
      throw new Error("JSONPath selected zero rows");
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid jsonpath mapping expression: ${message}`);
  }
}

function assertSelectedRows(entityType: TmsMappingEntity, rows: readonly unknown[]): void {
  const invalidRowIndex = rows.findIndex((row) => !isRecord(row));
  if (invalidRowIndex !== -1) {
    throw new Error(`TMS mapping proposal selected a non-object ${entityType} row at index ${invalidRowIndex}`);
  }
}

function assertMappedSourceFieldsPresent(
  entityType: TmsMappingEntity,
  rows: readonly unknown[],
  mappingJson: TmsMappingJson | undefined
): void {
  const entityMap = mappingJson?.[entityType];
  if (!entityMap) return;

  const fieldMap = entityMap as Record<string, string | string[] | undefined>;
  for (const [rowIndex, row] of rows.entries()) {
    if (!isRecord(row)) continue;

    for (const [canonicalField, sourceFields] of Object.entries(fieldMap)) {
      if (sourceFields === undefined) continue;

      const sourceFieldList = Array.isArray(sourceFields) ? sourceFields : [sourceFields];
      const hasMappedSource = sourceFieldList.some((sourceField) =>
        Object.prototype.hasOwnProperty.call(row, sourceField)
      );
      if (!hasMappedSource) {
        throw new Error(
          `TMS mapping proposal source field missing for ${entityType}.${canonicalField} at row ${rowIndex}: ${sourceFieldList.join(", ")}`
        );
      }
    }
  }
}

function parseCanonicalRows(
  entityType: TmsMappingEntity,
  rows: readonly unknown[],
  mappingJson: TmsMappingJson | undefined
): void {
  for (const row of rows) {
    const canonicalRow = applyFieldMap(row, mappingJson?.[entityType]);
    switch (entityType) {
      case "units":
        tmsCanonicalUnitSchema.parse(canonicalRow);
        break;
      case "routes":
        tmsCanonicalRouteSchema.parse(canonicalRow);
        break;
      case "performance":
        tmsCanonicalPerformanceSchema.parse(canonicalRow);
        break;
      case "pricing_history":
        tmsCanonicalPricingHistorySchema.parse(canonicalRow);
        break;
      case "liquidations":
        tmsCanonicalLiquidationSchema.parse(canonicalRow);
        break;
      case "availability_zones":
        tmsCanonicalAvailabilityZoneSchema.parse(canonicalRow);
        break;
    }
  }
}

function applyFieldMap(row: unknown, fieldMap: Record<string, string | string[]> | undefined): unknown {
  if (!fieldMap) return row;
  if (!isRecord(row)) return row;

  const canonicalRow: Record<string, unknown> = {};
  for (const [canonicalField, sourceFields] of Object.entries(fieldMap)) {
    const sourceFieldList = Array.isArray(sourceFields) ? sourceFields : [sourceFields];
    canonicalRow[canonicalField] = firstMappedValue(row, sourceFieldList);
  }
  return canonicalRow;
}

function firstMappedValue(row: Record<string, unknown>, sourceFields: string[]): unknown {
  for (const sourceField of sourceFields) {
    if (Object.prototype.hasOwnProperty.call(row, sourceField)) {
      return row[sourceField];
    }
  }
  return undefined;
}

function parseProposalPayload(payload: unknown): unknown {
  if (typeof payload !== "string") return payload;

  const trimmed = payload.trim();
  const fencedJson = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fencedJson ? fencedJson[1] ?? "" : trimmed);
}

function isValidMappingExpression(engine: TmsMappingProposal["mapping_engine"], expression: string): boolean {
  const trimmed = expression.trim();
  if (trimmed.length === 0) return false;
  return engine === "jsonpath" && trimmed.startsWith("$");
}

function stringifyBounded(value: unknown, maxChars: number): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch {
    serialized = String(value);
  }

  if (serialized.length <= maxChars) return serialized;
  return `${serialized.slice(0, maxChars)}\n[truncated]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type JsonPathRoot = string | number | boolean | object | unknown[] | null;

const TMS_OPTIONAL_CANONICAL_FIELDS = {
  units: ["next_destination_city"],
  routes: [],
  performance: [],
  pricing_history: [],
  liquidations: [],
  availability_zones: []
} as const satisfies Record<TmsMappingEntity, readonly string[]>;
