import type { NodeContext } from "../types.js";
import type { QuoteAgentState } from "../state.js";

export async function writebackNode(state: QuoteAgentState, context: NodeContext) {
  return context.trace(state.run_id, "writeback", async () => {
    if (!state.response_sent || state.approval?.action === "reject" || state.approval?.action === "request_review") {
      return {};
    }
    for (const [index, quote] of state.quotes.entries()) {
      const rate =
        index === 0 && state.approval?.action === "adjust" && state.approval.rate_mxn
          ? state.approval.rate_mxn
          : quote.base_rate_mxn;
      await context.tools.writeback({
        quote,
        recommendation: {
          status: "completed",
          recommended_rate_mxn: rate,
          reason: state.approval?.action === "adjust" ? "Human-adjusted rate" : "quote-core rate preserved"
        },
        approval_state: { required: false, reasons: [] }
      });
    }
    return {};
  });
}
