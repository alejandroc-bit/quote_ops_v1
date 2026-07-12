import type { NodeContext } from "../types.js";
import type { QuoteAgentState } from "../state.js";
import { resolveLane } from "./resolve.js";
import { quoteLane } from "./quote.js";
import { interpretHistoricalLane } from "./historical.js";
import { recommendLane } from "./recommend.js";

export async function processLaneNode(state: QuoteAgentState, context: NodeContext) {
  const lane = state.active_lane;
  if (!lane) throw new Error("lane processing requires active_lane");

  const resolved = await context.trace(state.run_id, "resolve", () => resolveLane(lane, context));
  const quoted = await context.trace(state.run_id, "quote", () =>
    quoteLane(lane, resolved.route_evidence, context)
  );
  const historical = await context.trace(state.run_id, "historical", () =>
    interpretHistoricalLane(lane, resolved.route_evidence, quoted.manifest, context)
  );
  const recommended = await context.trace(state.run_id, "recommend", () =>
    recommendLane(lane, quoted.quote, historical.historical_item, context)
  );

  return {
    quotes: [{ ...quoted.quote, lane_id: lane.lane_id }],
    historical: [historical.historical_item],
    recommendation: [recommended.recommendation_item],
    steps: [
      ...resolved.steps,
      ...quoted.steps,
      ...historical.steps,
      ...recommended.steps
    ],
    audit_events: [
      ...resolved.audit_events,
      ...quoted.audit_events,
      ...historical.audit_events,
      ...recommended.audit_events
    ]
  };
}
