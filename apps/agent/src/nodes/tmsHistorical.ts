import { type QuoteCoreInput } from "@quoteops/quote-core";
import type { QuoteWorkflowState } from "../state.js";
import { recordNodeEvent } from "./audit.js";

export async function tmsHistoricalNode(state: QuoteWorkflowState): Promise<QuoteWorkflowState> {
  if (!state.active_child_rfq || !state.route_evidence) {
    return recordNodeEvent(state, "tmsHistorical", "failed", {
      reason: "historical_inputs_missing"
    });
  }

  const historicalInput: QuoteCoreInput = {
    rfq: { ...state.active_child_rfq, client_id: state.client_id },
    manifest: state.manifest,
    route_evidence: state.route_evidence
  };
  try {
    const historical = await state.tools.searchHistorical(historicalInput);

    return recordNodeEvent(
      { ...state, historical_context: historical },
      "tmsHistorical",
      "completed",
      { selected_layer: historical?.selected_layer ?? null }
    );
  } catch (error) {
    return recordNodeEvent(
      {
        ...state,
        historical_context: {
          selected_layer: "unavailable",
          unavailable: true,
          error: error instanceof Error ? error.message : String(error)
        },
        runtime_review_reasons: [...state.runtime_review_reasons, "tms_historical_unavailable"]
      },
      "tmsHistorical",
      "failed",
      {
        reason: "tms_historical_unavailable",
        error: error instanceof Error ? error.message : String(error)
      }
    );
  }
}
