import { readFile } from "node:fs/promises";
import { calculateQuote, type QuoteManifest, type RouteEvidence } from "@quoteops/quote-core";
import { z } from "zod";
import { overlayTmsPerformance } from "@quoteops/connectors";
import type { NodeContext, ResolvedLane } from "../types.js";

export async function quoteLane(
  lane: ResolvedLane,
  routeEvidence: RouteEvidence,
  context: NodeContext
) {
  const settingsManifest = await pricingModelOverlay(context.manifest, context.env);
  const { manifest, stale } = await performanceOverlay(settingsManifest, context);
  const calculated = calculateQuote({ rfq: lane, manifest, route_evidence: routeEvidence });
  const selectedPerformanceStale = stale.includes(lane.vehicle_profile_id);
  return {
    manifest,
    quote: selectedPerformanceStale
      ? {
          ...calculated,
          status: "REVIEW_REQUIRED" as const,
          review_reasons: [...new Set([...calculated.review_reasons, "tms_performance_stale"])]
        }
      : calculated
  };
}

async function performanceOverlay(
  manifest: QuoteManifest,
  context: NodeContext
): Promise<{ manifest: QuoteManifest; stale: string[] }> {
  const optedIn = manifest.vehicle_profiles
    .filter((profile) => profile.performance_source === "tms")
    .map((profile) => profile.vehicle_profile_id);
  if (optedIn.length === 0) return { manifest, stale: [] };
  if (!context.tools.getUnitPerformance) return { manifest, stale: optedIn };
  try {
    const overlaid = overlayTmsPerformance(manifest, await context.tools.getUnitPerformance());
    return { manifest: overlaid.manifest, stale: overlaid.stale };
  } catch {
    return { manifest, stale: optedIn };
  }
}

async function pricingModelOverlay(
  manifest: QuoteManifest,
  env: NodeJS.ProcessEnv
): Promise<QuoteManifest> {
  const path = env.QUOTEOPS_SETTINGS_PATH?.trim();
  if (!path) return manifest;
  try {
    const settings = z
      .object({ pricing_model: z.enum(["formula", "profitability"]).optional() })
      .passthrough()
      .parse(JSON.parse(await readFile(path, "utf8")));
    if (!settings.pricing_model) return manifest;
    return {
      ...manifest,
      vehicle_profiles: manifest.vehicle_profiles.map((profile) => ({
        ...profile,
        pricing_model: settings.pricing_model as "formula" | "profitability"
      }))
    };
  } catch {
    return manifest;
  }
}
