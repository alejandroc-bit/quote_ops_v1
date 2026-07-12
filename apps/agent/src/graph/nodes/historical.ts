import type { HistoricalContext, QuoteManifest, RouteEvidence } from "@quoteops/quote-core";
import { z } from "zod";
import type { NodeContext, ResolvedLane } from "../types.js";

const historicalInterpretationSchema = z
  .object({
    quality: z.enum(["good", "thin", "none"]),
    relevance_notes: z.string().min(1)
  })
  .strict();

export async function interpretHistoricalLane(
  lane: ResolvedLane,
  routeEvidence: RouteEvidence,
  manifest: QuoteManifest,
  context: NodeContext
) {
  const contextValue = await context.tools.searchHistorical({
    rfq: lane,
    manifest,
    route_evidence: routeEvidence
  });
  const interpretation = await context.model
    .withStructuredOutput(historicalInterpretationSchema)
    .invoke([
      {
        role: "system",
        content: "Interpret historical relevance only. Never calculate or change a freight rate."
      },
      { role: "user", content: JSON.stringify(contextValue) }
    ]);
  return {
    historical_item: {
      lane_id: lane.lane_id,
      context: contextValue,
      ...interpretation,
      band: historicalBand(contextValue)
    }
  };
}

function historicalBand(context: HistoricalContext): { min: number; max: number } | null {
  if (!context) return null;
  const record = context as Record<string, unknown>;
  const min = finite(record.min_rate_mxn) ?? comparableBound(record.comparables, "min_rate_mxn");
  const max = finite(record.max_rate_mxn) ?? comparableBound(record.comparables, "max_rate_mxn");
  if (min === null || max === null || min > max) return null;
  return { min, max };
}

function comparableBound(value: unknown, key: string): number | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (item && typeof item === "object") {
      const parsed = finite((item as Record<string, unknown>)[key]);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
