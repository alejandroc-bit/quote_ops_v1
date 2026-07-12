import type { QuoteCoreInput, RouteEvidence } from "@quoteops/quote-core";
import type { NodeContext } from "../types.js";
import type { QuoteAgentState } from "../state.js";

const validationRoute: RouteEvidence = {
  status: "missing",
  source: "tms",
  km_loaded: null,
  estimated_minutes: null,
  tolls_mxn: null,
  requires_return_route: false
};

export async function validateOperabilityNode(state: QuoteAgentState, context: NodeContext) {
  return context.trace(state.run_id, "validateOperability", async () => {
    if (state.intake_kind !== "bulk_file") return { inoperable: [] };
    const zones = context.tools.getAvailabilityZones
      ? await context.tools.getAvailabilityZones()
      : [];
    const inoperable: QuoteAgentState["inoperable"] = [];
    for (const lane of state.lanes) {
      const historical = await context.tools.searchHistorical({
        rfq: lane,
        manifest: context.manifest,
        route_evidence: validationRoute
      } satisfies QuoteCoreInput);
      const hasComparables = Array.isArray(historical?.comparables) && historical.comparables.length > 0;
      const hasAvailability = zones.some(
        (zone) =>
          normalize(zone.city) === normalize(lane.origin.city) &&
          normalize(zone.state) === normalize(lane.origin.state) &&
          zone.available_units > 0
      );
      if (!hasComparables && !hasAvailability) {
        inoperable.push({ lane, reason: "no_historical_comparables_and_no_availability_zone" });
      }
    }
    return { inoperable };
  });
}

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
}
