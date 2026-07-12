import type { QuoteWorkflowState } from "../state.js";
import { recordNodeEvent } from "./audit.js";

export async function intakePlannerNode(state: QuoteWorkflowState): Promise<QuoteWorkflowState> {
  return recordNodeEvent(state, "intakePlanner", "completed", {
    rfq_id: state.raw_rfq.rfq_id,
    lanes: state.raw_rfq.parsed.lanes.length
  });
}
