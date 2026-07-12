import {
  tmsCanonicalAvailabilityZoneSchema,
  tmsCanonicalLiquidationSchema,
  tmsCanonicalPerformanceSchema,
  tmsCanonicalPricingHistorySchema,
  tmsCanonicalRouteSchema,
  tmsCanonicalUnitSchema,
  tmsMappingConfigSchema,
  type TmsCanonicalAvailabilityZone,
  type TmsCanonicalLiquidation,
  type TmsCanonicalPerformance,
  type TmsCanonicalPricingHistory,
  type TmsCanonicalRoute,
  type TmsCanonicalUnit,
  type TmsMappingConfig,
  type TmsMappingEntity,
  type TmsMappingJson
} from "@quoteops/contracts";

export interface TmsCanonicalByEntity {
  units: TmsCanonicalUnit;
  routes: TmsCanonicalRoute;
  performance: TmsCanonicalPerformance;
  pricing_history: TmsCanonicalPricingHistory;
  liquidations: TmsCanonicalLiquidation;
  availability_zones: TmsCanonicalAvailabilityZone;
}

export interface DeterministicTmsMappingInput<EntityType extends TmsMappingEntity> {
  entity_type: EntityType;
  raw: unknown;
  config: unknown;
  jsonPathSearch(payload: unknown, expression: string): unknown[];
}

export function applyDeterministicTmsMapping<EntityType extends TmsMappingEntity>(
  input: DeterministicTmsMappingInput<EntityType>
): Array<TmsCanonicalByEntity[EntityType]> {
  if (!isRecord(input.config) || input.config.runtime_ai_calls_allowed !== false) {
    throw new Error("TMS runtime AI calls are forbidden");
  }

  const config = tmsMappingConfigSchema.parse(input.config);
  const mapping = config.mappings[input.entity_type];
  if (!mapping) {
    throw new Error(`missing TMS mapping: ${input.entity_type}`);
  }

  const rows = input.jsonPathSearch(input.raw, mapping);
  return rows.map((row) =>
    parseCanonicalRow(input.entity_type, row, config.mapping_json?.[input.entity_type])
  );
}

function parseCanonicalRow<EntityType extends TmsMappingEntity>(
  entityType: EntityType,
  row: unknown,
  fieldMap: TmsMappingJson[EntityType] | undefined
): TmsCanonicalByEntity[EntityType] {
  const canonicalRow = applyFieldMap(row, fieldMap);

  switch (entityType) {
    case "units":
      return tmsCanonicalUnitSchema.parse(canonicalRow) as TmsCanonicalByEntity[EntityType];
    case "routes":
      return tmsCanonicalRouteSchema.parse(canonicalRow) as TmsCanonicalByEntity[EntityType];
    case "performance":
      return tmsCanonicalPerformanceSchema.parse(canonicalRow) as TmsCanonicalByEntity[EntityType];
    case "pricing_history":
      return tmsCanonicalPricingHistorySchema.parse(canonicalRow) as TmsCanonicalByEntity[EntityType];
    case "liquidations":
      return tmsCanonicalLiquidationSchema.parse(canonicalRow) as TmsCanonicalByEntity[EntityType];
    case "availability_zones":
      return tmsCanonicalAvailabilityZoneSchema.parse(canonicalRow) as TmsCanonicalByEntity[EntityType];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
