import type { QuoteWorkflowState } from "../state.js";
import { recordNodeEvent } from "./audit.js";

export async function pricingRecommendationNode(
  state: QuoteWorkflowState
): Promise<QuoteWorkflowState> {
  if (!state.base_quote || !state.criteria_context) {
    return recordNodeEvent(state, "pricingRecommendation", "failed", {
      reason: "recommendation_inputs_missing"
    });
  }

  try {
    const recommendation = await state.tools.recommend({
      base_rate_mxn: state.base_quote.base_rate_mxn,
      historical_context: state.historical_context,
      criteria_context: state.criteria_context
    });

    return recordNodeEvent(
      {
        ...state,
        recommendation: {
          status: "completed",
          recommended_rate_mxn: state.base_quote.base_rate_mxn,
          reason: recommendation.reason
        }
      },
      "pricingRecommendation",
      "completed",
      {
        recommended_rate_mxn: state.base_quote.base_rate_mxn,
        model_suggested_rate_mxn: recommendation.recommended_rate_mxn,
        policy: "quote_core_rate_preserved"
      }
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    return recordNodeEvent(
      {
        ...state,
        recommendation: {
          status: "failed",
          recommended_rate_mxn: state.base_quote.base_rate_mxn,
          reason: "AI recommendation failed; quote-core output preserved for review.",
          error: errorMessage
        }
      },
      "pricingRecommendation",
      "failed",
      {
        reason: "ai_recommendation_failed",
        recommended_rate_mxn: state.base_quote.base_rate_mxn,
        policy: "quote_core_rate_preserved",
        error: errorMessage
      }
    );
  }
}
