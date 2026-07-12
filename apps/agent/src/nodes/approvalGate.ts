import type { QuoteChildResult, QuoteWorkflowState } from "../state.js";
import { recordNodeEvent } from "./audit.js";

function historicalContextInsufficient(
  historical: QuoteWorkflowState["historical_context"]
): boolean {
  return (
    Boolean(
      historical &&
        Array.isArray(historical.insufficient_data) &&
        historical.insufficient_data.length > 0
    ) || Boolean(historical && historical.unavailable)
  );
}

function childReviewReasons(child: {
  base_quote: QuoteChildResult["base_quote"];
  recommendation: QuoteChildResult["recommendation"];
  historical_context: QuoteChildResult["historical_context"];
}): string[] {
  return [
    ...(child.base_quote?.review_reasons ?? []),
    ...(child.recommendation?.status === "failed" ? ["ai_recommendation_failed"] : []),
    ...(historicalContextInsufficient(child.historical_context)
      ? ["historical_context_insufficient"]
      : [])
  ];
}

export async function approvalGateNode(state: QuoteWorkflowState): Promise<QuoteWorkflowState> {
  const children = state.child_results.length > 0 ? state.child_results : [state];
  const reasons = Array.from(
    new Set([
      ...children.flatMap((child) => childReviewReasons(child)),
      ...state.runtime_review_reasons
    ])
  );
  const approval = {
    required: reasons.length > 0,
    reasons
  };

  return recordNodeEvent(
    { ...state, approval_state: approval },
    "approvalGate",
    approval.required ? "review_required" : "completed",
    approval
  );
}
