import { approvalGateNode } from "./nodes/approvalGate.js";
import { batchSplitterNode } from "./nodes/batchSplitter.js";
import { commsAgentNode } from "./nodes/commsAgent.js";
import { criteriaRetrieverNode } from "./nodes/criteriaRetriever.js";
import { historicalAnalystNode } from "./nodes/historicalAnalyst.js";
import { intakePlannerNode } from "./nodes/intakePlanner.js";
import { normalizerNode } from "./nodes/normalizer.js";
import { pricingRecommendationNode } from "./nodes/pricingRecommendation.js";
import { profileResolverNode } from "./nodes/profileResolver.js";
import { quoteCoreNode } from "./nodes/quoteCore.js";
import { routeEvidenceNode } from "./nodes/routeEvidence.js";
import { tmsHistoricalNode } from "./nodes/tmsHistorical.js";
import { writebackNode } from "./nodes/writeback.js";
import { recordNodeEvent } from "./nodes/audit.js";
import { initialWorkflowState, type QuoteWorkflowInput, type QuoteWorkflowState } from "./state.js";

export const quoteWorkflowNodeOrder = [
  "intakePlanner",
  "normalizer",
  "profileResolver",
  "batchSplitter",
  "routeEvidence",
  "quoteCore",
  "tmsHistorical",
  "criteriaRetriever",
  "historicalAnalyst",
  "pricingRecommendation",
  "approvalGate",
  "commsAgent",
  "writeback",
  "audit"
] as const;

export async function runQuoteWorkflow(input: QuoteWorkflowInput): Promise<QuoteWorkflowState> {
  let state = initialWorkflowState(input);

  state = await intakePlannerNode(state);
  state = await normalizerNode(state);
  state = await profileResolverNode(state);
  state = await batchSplitterNode(state);

  for (const child of state.batch_queue) {
    state = {
      ...state,
      active_child_rfq: child.lane,
      route_evidence: null,
      base_quote: null,
      historical_context: null,
      criteria_context: null,
      recommendation: null
    };
    state = await routeEvidenceNode(state);
    state = await quoteCoreNode(state);
    state = await tmsHistoricalNode(state);
    state = await criteriaRetrieverNode(state);
    state = await historicalAnalystNode(state);
    state = await pricingRecommendationNode(state);
    state = {
      ...state,
      child_results: [
        ...state.child_results,
        {
          child_rfq_id: child.child_rfq_id,
          lane_id: child.lane_id,
          lane: child.lane,
          route_evidence: state.route_evidence,
          base_quote: state.base_quote,
          historical_context: state.historical_context,
          criteria_context: state.criteria_context,
          recommendation: state.recommendation
        }
      ]
    };
  }
  if (state.batch_queue.length === 0) {
    state = {
      ...state,
      runtime_review_reasons: [...state.runtime_review_reasons, "rfq_has_no_lanes"]
    };
  }

  state = await approvalGateNode(state);
  state = await commsAgentNode(state);
  state = await writebackNode(state);

  return recordNodeEvent(state, "audit", "completed", {
    node_count: quoteWorkflowNodeOrder.length,
    children_quoted: state.child_results.length
  });
}
