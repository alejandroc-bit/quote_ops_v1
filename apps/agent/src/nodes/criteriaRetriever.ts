import { retrieveCriteria, type KnowledgeHit } from "@quoteops/criteria";
import type { QuoteWorkflowState } from "../state.js";
import { recordNodeEvent } from "./audit.js";

export async function criteriaRetrieverNode(state: QuoteWorkflowState): Promise<QuoteWorkflowState> {
  const criteria = retrieveCriteria({
    criteria_version: state.criteria_version,
    client_id: state.client_id,
    phase: "pricing_recommendation",
    context: {
      sector: state.active_child_rfq?.cargo.sector ?? null,
      approval_risk: state.base_quote?.review_reasons ?? []
    },
    nodes: state.criteria_nodes
  });

  // pull the client's own commercial criteria from the local vector store so
  // the pricing guide reasons with their brain, not a generic prompt
  let knowledgeHits: KnowledgeHit[] = [];
  if (state.tools.retrieveKnowledge) {
    const lane = state.active_child_rfq;
    const query = [
      lane?.origin.city,
      lane?.destination.city,
      lane?.cargo.commodity,
      lane?.cargo.sector,
      lane?.vehicle_profile_id
    ]
      .filter(Boolean)
      .join(" ");
    try {
      knowledgeHits = await state.tools.retrieveKnowledge(query || state.client_id, state.client_id);
    } catch {
      knowledgeHits = [];
    }
  }

  return recordNodeEvent(
    {
      ...state,
      criteria_context: { ...criteria, knowledge_hits: knowledgeHits }
    },
    "criteriaRetriever",
    "completed",
    { criteria_count: criteria.nodes.length, knowledge_hits: knowledgeHits.length }
  );
}
