import type { QuoteWorkflowState, QuoteWritebackResult } from "../state.js";
import { recordNodeEvent } from "./audit.js";

const SUCCESSFUL_WRITEBACK_STATUSES = new Set(["written", "queued"]);

export async function writebackNode(state: QuoteWorkflowState): Promise<QuoteWorkflowState> {
  const children = state.child_results.length > 0 ? state.child_results : [state];
  const writable = children.filter((child) => child.base_quote && child.recommendation);

  if (state.approval_state?.required || writable.length === 0) {
    return recordNodeEvent(
      { ...state, writeback_result: null, writeback_results: [] },
      "writeback",
      "review_required",
      { skipped: true }
    );
  }

  const results: QuoteWritebackResult[] = [];
  for (const child of writable) {
    const result = await state.tools
      .writeback({
        quote: child.base_quote!,
        recommendation: child.recommendation!,
        approval_state: state.approval_state
      })
      .catch((error) => ({
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      }));
    results.push(result);
  }

  const allSucceeded = results.every((result) =>
    SUCCESSFUL_WRITEBACK_STATUSES.has(result.status)
  );
  return recordNodeEvent(
    {
      ...state,
      writeback_result: results[results.length - 1] ?? null,
      writeback_results: results
    },
    "writeback",
    allSucceeded ? "completed" : "failed",
    { results: results.map((result) => result.status) }
  );
}
