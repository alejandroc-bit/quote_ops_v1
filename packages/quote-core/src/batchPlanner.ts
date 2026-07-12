import type { QuoteRfqLaneInput } from "./profileResolver.js";

export type RfqBatchPlanInput = {
  rfq_id: string;
  lanes: QuoteRfqLaneInput[];
};

export type RfqBatchChild = {
  child_rfq_id: string;
  lane_id: string;
  sequence: number;
  lane: QuoteRfqLaneInput;
};

export type RfqBatchPlan = {
  parent_rfq_id: string;
  children: RfqBatchChild[];
};

export function planRfqBatch(input: RfqBatchPlanInput): RfqBatchPlan {
  return {
    parent_rfq_id: input.rfq_id,
    children: input.lanes.map((lane, index) => ({
      child_rfq_id: lane.lane_id || `${input.rfq_id}-L${String(index + 1).padStart(2, "0")}`,
      lane_id: lane.lane_id,
      sequence: index + 1,
      lane
    }))
  };
}
