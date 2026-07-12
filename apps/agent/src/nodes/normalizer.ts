import { rfqSchema } from "@quoteops/contracts";
import type { QuoteWorkflowState } from "../state.js";
import { recordNodeEvent } from "./audit.js";

export async function normalizerNode(state: QuoteWorkflowState): Promise<QuoteWorkflowState> {
  const normalized = rfqSchema.parse(state.raw_rfq);
  return recordNodeEvent({ ...state, normalized_rfq: normalized }, "normalizer", "completed", {
    rfq_id: normalized.rfq_id
  });
}
