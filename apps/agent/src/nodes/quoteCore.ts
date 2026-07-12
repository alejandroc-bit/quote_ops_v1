import { calculateQuote, type QuoteCoreInput } from "@quoteops/quote-core";
import type { QuoteWorkflowState } from "../state.js";
import { recordNodeEvent } from "./audit.js";

export async function quoteCoreNode(state: QuoteWorkflowState): Promise<QuoteWorkflowState> {
  if (!state.active_child_rfq || !state.route_evidence) {
    return recordNodeEvent(state, "quoteCore", "failed", {
      reason: "quote_core_inputs_missing"
    });
  }

  const quoteInput: QuoteCoreInput = {
    rfq: {
      ...state.active_child_rfq,
      client_id: state.client_id
    },
    manifest: state.manifest,
    route_evidence: state.route_evidence,
    historical_context: state.historical_context
  };
  const quote = calculateQuote(quoteInput);

  return recordNodeEvent(
    {
      ...state,
      quote_core_version: quote.quote_core_version,
      base_quote: quote
    },
    "quoteCore",
    quote.status === "REVIEW_REQUIRED" ? "review_required" : "completed",
    {
      status: quote.status,
      review_reasons: quote.review_reasons
    }
  );
}
