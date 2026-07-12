import type { QuoteWorkflowState } from "../state.js";
import { recordNodeEvent } from "./audit.js";

export async function routeEvidenceNode(state: QuoteWorkflowState): Promise<QuoteWorkflowState> {
  if (!state.active_child_rfq) {
    return recordNodeEvent(state, "routeEvidence", "failed", {
      reason: "active_child_rfq_missing"
    });
  }

  try {
    const route = await state.tools.resolveRoute(state.active_child_rfq);
    return recordNodeEvent({ ...state, route_evidence: route }, "routeEvidence", "completed", {
      source: route.source,
      status: route.status
    });
  } catch (error) {
    return recordNodeEvent(
      {
        ...state,
        route_evidence: {
          status: "failed",
          source: "sakbe",
          km_loaded: null,
          estimated_minutes: null,
          tolls_mxn: null,
          requires_return_route: false
        },
        runtime_review_reasons: [...state.runtime_review_reasons, "route_provider_unavailable"]
      },
      "routeEvidence",
      "failed",
      {
        reason: "route_provider_unavailable",
        error: error instanceof Error ? error.message : String(error)
      }
    );
  }
}
