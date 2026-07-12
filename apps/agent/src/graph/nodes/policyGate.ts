import type { AgentRecommendation, NodeContext } from "../types.js";
import type { QuoteAgentState } from "../state.js";

export async function policyGateNode(state: QuoteAgentState, context: NodeContext) {
  return context.trace(state.run_id, "policyGate", async () => {
    const recommendations = state.recommendation.map((item) => {
      const quote = state.quotes.find((candidate) => candidate.lane_id === item.lane_id);
      const historical = state.historical.find((candidate) => candidate.lane_id === item.lane_id);
      let verdict: AgentRecommendation["verdict"] = "auto";
      const reasons: string[] = [];
      if (historical?.quality === "none" || !historical?.band) {
        verdict = "unknown_route";
        reasons.push("historical_quality_none");
      } else if (
        !quote ||
        quote.status !== "APPROVED" ||
        quote.base_rate_mxn < historical.band.min ||
        quote.base_rate_mxn > historical.band.max
      ) {
        verdict = "needs_review";
        reasons.push(...(quote?.review_reasons ?? []));
        if (quote && historical.band && (quote.base_rate_mxn < historical.band.min || quote.base_rate_mxn > historical.band.max)) {
          reasons.push("quote_core_rate_outside_historical_band");
        }
      } else if (isCentralThird(quote.base_rate_mxn, historical.band)) {
        verdict = "needs_review";
        reasons.push("mid_band_confirmation_required");
      }
      return {
        ...item,
        verdict,
        reason: [item.reason, ...reasons].filter(Boolean).join("; ")
      };
    });
    return { recommendation: recommendations };
  });
}

function isCentralThird(rate: number, band: { min: number; max: number }): boolean {
  const width = band.max - band.min;
  if (width <= 0) return false;
  return rate >= band.min + width / 3 && rate <= band.max - width / 3;
}
