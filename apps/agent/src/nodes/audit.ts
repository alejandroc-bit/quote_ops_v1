import { appendAuditEvent, createAuditEvent } from "@quoteops/audit";
import type { QuoteWorkflowNode, QuoteWorkflowState, NodeStatus } from "../state.js";

export function recordNodeEvent(
  state: QuoteWorkflowState,
  node_id: QuoteWorkflowNode,
  status: NodeStatus,
  payload: Record<string, unknown> = {}
): QuoteWorkflowState {
  const event = createAuditEvent({
    run_id: state.run_id,
    node_id,
    event_type: status,
    payload
  });

  return {
    ...state,
    audit_events: appendAuditEvent(state.audit_events, event),
    node_status: {
      ...state.node_status,
      [node_id]: status
    }
  };
}
