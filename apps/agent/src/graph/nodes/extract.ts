import { z } from "zod";
import { createHash } from "node:crypto";
import { buildRfqFromEmail } from "../../intake/extractRfq.js";
import type { QuoteRfqLaneInput } from "@quoteops/quote-core";
import type { NodeContext, ResolvedLane } from "../types.js";
import type { QuoteAgentState } from "../state.js";

const locationSchema = z.object({ city: z.string().min(1), state: z.string().min(1), country: z.string().optional() });
const extractedLanesSchema = z
  .object({
    lanes: z.array(
      z.object({
        origin: locationSchema,
        destination: locationSchema,
        equipment_text: z.string().nullable(),
        weight_kg: z.number().nullable(),
        commodity: z.string().nullable(),
        value_mxn: z.number().nullable(),
        hazmat: z.boolean(),
        target_rate_mxn: z.number().nullable()
      })
    ).min(1)
  })
  .strict();

export async function extractNode(state: QuoteAgentState, context: NodeContext) {
  return context.trace(state.run_id, "extract", async () => {
    const rfq = await buildRfqFromEmail({
      email: state.message,
      manifest: context.manifest,
      rfqId: rfqIdFromRun(state.run_id, context.now()),
      // buildRfqFromEmail ignores the model when a real XLSX attachment is
      // present. Keeping it available here makes extraction robust if graph
      // state ever contains an inconsistent intake_kind.
      model: async (parts) =>
        context.model.withStructuredOutput(extractedLanesSchema).invoke(parts)
    });
    const lanes: ResolvedLane[] = rfq.parsed.lanes.map((lane) =>
      laneToQuoteInput(rfq.rfq_id, rfq.requester.email, context.manifest.client_id, lane)
    );
    return { rfqs: [rfq], lanes };
  });
}

function rfqIdFromRun(runId: string, now: Date): string {
  const year = now.getUTCFullYear();
  const numeric = Number.parseInt(createHash("sha256").update(runId).digest("hex").slice(0, 8), 16);
  return `RFQ-${year}-${String(numeric % 1_000_000).padStart(6, "0")}`;
}

function laneToQuoteInput(
  rfqId: string,
  requesterEmail: string,
  clientId: string,
  lane: import("@quoteops/contracts").RfqLane
): QuoteRfqLaneInput {
  return {
    rfq_id: rfqId,
    lane_id: lane.lane_id,
    requester_email: requesterEmail,
    client_id: clientId,
    business_unit_id: lane.commercial.business_unit_id,
    origin: lane.origin,
    destination: lane.destination,
    vehicle_profile_id: lane.vehicle_profile_id ?? lane.equipment_request ?? "sin especificar",
    cargo: lane.cargo,
    service: lane.service,
    commercial: lane.commercial
  };
}
