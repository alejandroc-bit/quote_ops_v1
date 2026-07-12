import type { QuoteWorkflowState, QuoteWorkflowTools, QuoteWritebackResult } from "@quoteops/agent";
import type { ApprovalDecision } from "../storage/QuoteOpsStore.js";

const SUCCESSFUL_WRITEBACK_STATUSES = new Set(["written", "queued"]);

type LocalWriteback = (input: {
  quote: NonNullable<QuoteWorkflowState["base_quote"]>;
  recommendation: NonNullable<QuoteWorkflowState["recommendation"]>;
}) => ReturnType<QuoteWorkflowTools["writeback"]>;

export async function applyApprovalDecision(
  run: QuoteWorkflowState,
  decision: ApprovalDecision,
  tools: QuoteWorkflowTools
): Promise<QuoteWorkflowState> {
  // ponytail: runs stored before child_results existed load without the field
  const children = run.child_results?.length ? run.child_results : [run];
  const writable = children.filter((child) => child.base_quote && child.recommendation);

  if (writable.length === 0) {
    return {
      ...run,
      runtime_review_reasons: [...run.runtime_review_reasons, "approval_decision_without_quote"]
    };
  }

  if (decision.action === "reject" || decision.action === "request_review") {
    return {
      ...run,
      approval_state: {
        required: true,
        reasons: [...(run.approval_state?.reasons ?? []), decision.action]
      },
      writeback_result: null,
      writeback_results: [],
      node_status: {
        ...run.node_status,
        writeback: "review_required"
      }
    };
  }

  const writeback = tools.writeback as unknown as LocalWriteback;
  const results: QuoteWritebackResult[] = [];
  let lastApprovedRecommendation = run.recommendation;
  for (const child of writable) {
    const approvedRate =
      decision.action === "adjust" && typeof decision.rate_mxn === "number"
        ? decision.rate_mxn
        : child.recommendation!.recommended_rate_mxn;
    const approvedRecommendation = {
      ...child.recommendation!,
      recommended_rate_mxn: approvedRate,
      reason: decision.reason ?? child.recommendation!.reason
    };
    lastApprovedRecommendation = approvedRecommendation;
    const result = await writeback({
      quote: child.base_quote!,
      recommendation: approvedRecommendation
    }).catch((error) => ({
      status: "failed",
      error: error instanceof Error ? error.message : String(error)
    }));
    results.push(result);
  }

  const allSucceeded = results.every((result) =>
    SUCCESSFUL_WRITEBACK_STATUSES.has(result.status)
  );
  return {
    ...run,
    recommendation: lastApprovedRecommendation,
    approval_state: { required: false, reasons: [] },
    writeback_result: results[results.length - 1] ?? null,
    writeback_results: results,
    node_status: {
      ...run.node_status,
      writeback: allSucceeded ? "completed" : "failed"
    }
  };
}
