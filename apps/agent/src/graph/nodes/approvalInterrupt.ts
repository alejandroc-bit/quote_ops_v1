import { interrupt } from "@langchain/langgraph";
import type { AgentApproval, NodeContext } from "../types.js";
import type { QuoteAgentState } from "../state.js";

export async function approvalInterruptNode(state: QuoteAgentState, context: NodeContext) {
  return context.trace(state.run_id, "approval", async () => {
    const needsHuman =
      state.recommendation.some((item) => item.verdict !== "auto") || state.inoperable.length > 0;
    if (!needsHuman) return { approval: { action: "approve" as const } };
    const reasons = state.recommendation
      .filter((item) => item.verdict !== "auto")
      .map((item) => item.reason);
    if (state.inoperable.length > 0) reasons.push("inoperable_lanes_require_human_decision");
    const decision = interrupt({
      run_id: state.run_id,
      lanes: state.lanes,
      quotes: state.quotes,
      recommendation: state.recommendation,
      reasons
    }) as AgentApproval;
    if (decision.action === "approve" && state.quotes.length === 0 && state.inoperable.length > 0) {
      return {
        approval: { action: "request_review" as const },
        terminal_blocker: "all_lanes_inoperable"
      };
    }
    return { approval: decision };
  });
}
