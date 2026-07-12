import { z } from "zod";

export const criteriaNodeTypeSchema = z.enum([
  "company_policy",
  "commercial_strategy",
  "pricing_criterion",
  "operational_risk_criterion",
  "customer_preference",
  "commodity_rule",
  "sector_rule",
  "approval_rule",
  "communication_rule",
  "exception_pattern",
  "learning_summary"
]);

export const criteriaPhaseSchema = z.enum([
  "intake",
  "profile_resolution",
  "historical_analysis",
  "pricing_recommendation",
  "approval",
  "communication"
]);

export const criteriaNodeSchema = z
  .object({
    id: z.string().min(1),
    type: criteriaNodeTypeSchema,
    title: z.string().min(1),
    body: z.string().min(1),
    priority: z.number().int().min(0).max(1000),
    phases: z.array(criteriaPhaseSchema).min(1),
    applies_when: z.record(z.array(z.string().min(1))).default({}),
    source: z
      .object({
        kind: z.string().min(1),
        owner_role: z.string().min(1),
        captured_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
      })
      .strict(),
    payload: z.unknown().optional()
  })
  .strict()
  .superRefine((node, ctx) => {
    if (containsHeavyPayload(node.payload)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Criteria nodes cannot contain heavy operational payloads",
        path: ["payload"]
      });
    }
  });

export type CriteriaNodeType = z.infer<typeof criteriaNodeTypeSchema>;
export type CriteriaPhase = z.infer<typeof criteriaPhaseSchema>;
export type CriteriaNode = z.infer<typeof criteriaNodeSchema>;

function containsHeavyPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const stack: unknown[] = [payload];
  let objectCount = 0;

  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    objectCount += 1;
    if (objectCount > 500) return true;

    if (Array.isArray(current)) {
      if (current.length > 100) return true;
      stack.push(...current);
      continue;
    }

    const record = current as Record<string, unknown>;
    if (
      Array.isArray(record.rows) ||
      Array.isArray(record.historical_quotes) ||
      Array.isArray(record.shipments) ||
      Array.isArray(record.rfqs)
    ) {
      return true;
    }
    stack.push(...Object.values(record));
  }

  return JSON.stringify(payload).length > 20_000;
}

export function validateCriteriaNode(node: unknown): CriteriaNode {
  return criteriaNodeSchema.parse(node);
}

