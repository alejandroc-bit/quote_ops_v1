import { planRfqBatch, type QuoteRfqLaneInput } from "@quoteops/quote-core";
import type { RfqLane } from "@quoteops/contracts";
import type { QuoteWorkflowState } from "../state.js";
import { recordNodeEvent } from "./audit.js";

export async function batchSplitterNode(state: QuoteWorkflowState): Promise<QuoteWorkflowState> {
  const rfq = state.normalized_rfq ?? state.raw_rfq;
  const lanes = rfq.parsed.lanes.map((lane) => laneToQuoteCoreInput(rfq, lane));
  const batch = planRfqBatch({ rfq_id: rfq.rfq_id, lanes });

  return recordNodeEvent(
    {
      ...state,
      batch_queue: batch.children,
      active_child_rfq: batch.children[0]?.lane ?? null
    },
    "batchSplitter",
    "completed",
    { children: batch.children.length }
  );
}

function laneToQuoteCoreInput(rfq: QuoteWorkflowState["raw_rfq"], lane: RfqLane): QuoteRfqLaneInput {
  return {
    rfq_id: rfq.rfq_id,
    lane_id: lane.lane_id,
    requester_email: rfq.requester.email,
    client_id: lane.commercial.customer_id ? rfq.requester.company_alias.toLowerCase() : undefined,
    business_unit_id: lane.commercial.business_unit_id,
    origin: lane.origin,
    destination: lane.destination,
    vehicle_profile_id: lane.vehicle_profile_id ?? lane.equipment_request,
    cargo: {
      weight_kg: lane.cargo.weight_kg,
      value_mxn: lane.cargo.value_mxn,
      commodity: lane.cargo.commodity,
      commodity_category: lane.cargo.commodity_category,
      sector: lane.cargo.sector,
      hazmat: lane.cargo.hazmat
    },
    service: {
      return_policy: lane.service.return_policy,
      route_policy: lane.service.route_policy
    },
    commercial: {
      target_rate_mxn: lane.commercial.target_rate_mxn
    }
  };
}
