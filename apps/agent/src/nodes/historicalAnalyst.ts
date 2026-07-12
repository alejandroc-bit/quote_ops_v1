import type { QuoteWorkflowState } from "../state.js";
import { recordNodeEvent } from "./audit.js";

export async function historicalAnalystNode(state: QuoteWorkflowState): Promise<QuoteWorkflowState> {
  return recordNodeEvent(state, "historicalAnalyst", "completed", {
    has_historical_context: Boolean(state.historical_context)
  });
}
