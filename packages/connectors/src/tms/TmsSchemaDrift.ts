import type { TmsMappingEntity } from "@quoteops/contracts";

export type TmsSchemaDriftStatus = "ok" | "needs_remap";
export type TmsSchemaDriftRfqEffect = "none" | "REVIEW_REQUIRED";

export interface TmsSchemaDriftInput {
  entity_type: TmsMappingEntity;
  validation_errors?: unknown;
}

export interface TmsSchemaDriftClassification {
  status: TmsSchemaDriftStatus;
  rfq_effect: TmsSchemaDriftRfqEffect;
  reason_codes: string[];
}

export interface TmsMappingRemediationJob {
  job_type: "tms_mapping_remediation";
  client_id: string;
  entity_type: TmsMappingEntity;
  requested_action: "recalculate_mapping_in_onboarding";
  reason_codes: string[];
  rfq_effect: "REVIEW_REQUIRED";
  runtime_llm_allowed: false;
  created_at: string;
}

export const TMS_CRITICAL_CANONICAL_FIELDS = {
  units: ["unit_id", "current_lat", "current_lng", "status"],
  routes: ["route_id", "origin_city", "destination_city", "cargo_type", "client_type", "historical_cost"],
  performance: ["unit_type", "kpl_yield", "real_cost_per_km"],
  pricing_history: ["pricing_history_id", "route_id", "client_id", "cargo_type", "quoted_price", "quoted_at"],
  liquidations: ["liquidation_id", "unit_id", "route_id", "settled_cost", "settled_at"],
  availability_zones: ["zone_id", "city", "state", "country", "available_units"]
} as const satisfies Record<TmsMappingEntity, readonly string[]>;

const TMS_CANONICAL_FIELDS = {
  units: [...TMS_CRITICAL_CANONICAL_FIELDS.units, "next_destination_city"],
  routes: TMS_CRITICAL_CANONICAL_FIELDS.routes,
  performance: TMS_CRITICAL_CANONICAL_FIELDS.performance,
  pricing_history: TMS_CRITICAL_CANONICAL_FIELDS.pricing_history,
  liquidations: TMS_CRITICAL_CANONICAL_FIELDS.liquidations,
  availability_zones: TMS_CRITICAL_CANONICAL_FIELDS.availability_zones
} as const satisfies Record<TmsMappingEntity, readonly string[]>;

export function getTmsCriticalCanonicalFields(entityType: TmsMappingEntity): readonly string[] {
  return TMS_CRITICAL_CANONICAL_FIELDS[entityType];
}

export function classifyTmsSchemaDrift(input: TmsSchemaDriftInput): TmsSchemaDriftClassification {
  const issues = normalizeValidationErrors(input.validation_errors);
  if (issues.length === 0) {
    return { status: "ok", rfq_effect: "none", reason_codes: [] };
  }

  const criticalFields = new Set(getTmsCriticalCanonicalFields(input.entity_type));
  const reasonCodes = new Set<string>();
  let hasCriticalIssue = false;

  for (const issue of issues) {
    const field = issueField(issue, input.entity_type);
    if (field && criticalFields.has(field)) {
      hasCriticalIssue = true;
      const driftKind = isMissingIssue(issue) ? "critical_field_missing" : "critical_field_invalid";
      reasonCodes.add(`${driftKind}:${input.entity_type}.${field}`);
      continue;
    }

    if (field) {
      reasonCodes.add(`noncritical_field_issue:${input.entity_type}.${field}`);
      continue;
    }

    hasCriticalIssue = true;
    reasonCodes.add(`unclassified_schema_drift:${input.entity_type}`);
  }

  return {
    status: hasCriticalIssue ? "needs_remap" : "ok",
    rfq_effect: hasCriticalIssue ? "REVIEW_REQUIRED" : "none",
    reason_codes: [...reasonCodes].sort()
  };
}

export function createTmsMappingRemediationJob(input: {
  client_id: string;
  entity_type: TmsMappingEntity;
  reason_codes: string[];
  created_at?: string;
}): TmsMappingRemediationJob {
  return {
    job_type: "tms_mapping_remediation",
    client_id: input.client_id,
    entity_type: input.entity_type,
    requested_action: "recalculate_mapping_in_onboarding",
    reason_codes: [...new Set(input.reason_codes)].sort(),
    rfq_effect: "REVIEW_REQUIRED",
    runtime_llm_allowed: false,
    created_at: input.created_at ?? new Date().toISOString()
  };
}

function normalizeValidationErrors(value: unknown): Record<string, unknown>[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap((entry) => normalizeValidationErrors(entry));
  if (!isRecord(value)) return [{ message: String(value) }];

  const issues = value.issues;
  if (Array.isArray(issues)) return issues.filter(isRecord);

  const errors = value.errors;
  if (Array.isArray(errors)) return errors.filter(isRecord);

  return [value];
}

function issueField(issue: Record<string, unknown>, entityType: TmsMappingEntity): string | undefined {
  const path = issue.path;
  if (Array.isArray(path)) {
    const knownFields: ReadonlySet<string> = new Set(TMS_CANONICAL_FIELDS[entityType]);
    const stringSegments = [...path].reverse().filter(
      (segment): segment is string => typeof segment === "string" && segment.length > 0
    );
    const knownField = stringSegments.find((segment) => knownFields.has(segment));
    if (knownField) return knownField;
    const fallbackField = stringSegments[0];
    if (fallbackField) return fallbackField;
  }

  const field = issue.field;
  if (typeof field === "string" && field.length > 0) return field;

  const keys = issue.keys;
  if (Array.isArray(keys)) {
    return keys.find((key): key is string => typeof key === "string" && key.length > 0);
  }

  return undefined;
}

function isMissingIssue(issue: Record<string, unknown>): boolean {
  if (issue.received === "undefined") return true;
  const message = issue.message;
  return typeof message === "string" && /required|missing/i.test(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
