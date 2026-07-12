import type { NodeContext, ResolvedLane } from "../types.js";

export async function resolveLane(lane: ResolvedLane, context: NodeContext) {
  return { route_evidence: await context.tools.resolveRoute(lane) };
}
