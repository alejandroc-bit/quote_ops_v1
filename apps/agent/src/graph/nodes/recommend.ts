import type { QuoteCoreResult } from "@quoteops/quote-core";
import { z } from "zod";
import type { LaneHistoricalContext, NodeContext, ResolvedLane } from "../types.js";

const recommendationSchema = z
  .object({
    suggested_rate_mxn: z.number().finite().nonnegative(),
    reason: z.string().min(1)
  })
  .strict();

export async function recommendLane(
  lane: ResolvedLane,
  quote: QuoteCoreResult,
  historical: LaneHistoricalContext,
  context: NodeContext
) {
  const proposal = await context.model.withStructuredOutput(recommendationSchema).invoke([
    {
      role: "system",
      content: "Suggest an annotation for human review. The deterministic quote-core rate is immutable."
    },
    {
      role: "user",
      content: JSON.stringify({ quote_core_rate_mxn: quote.base_rate_mxn, historical })
    }
  ]);
  const clampedRate = historical.band
    ? Math.max(historical.band.min, Math.min(historical.band.max, proposal.suggested_rate_mxn))
    : proposal.suggested_rate_mxn;
  return {
    recommendation_item: {
      lane_id: lane.lane_id,
      verdict: "needs_review" as const,
      reason: proposal.reason,
      suggested_rate_mxn: clampedRate,
      ...(clampedRate !== proposal.suggested_rate_mxn ? { clamped: true } : {})
    }
  };
}
