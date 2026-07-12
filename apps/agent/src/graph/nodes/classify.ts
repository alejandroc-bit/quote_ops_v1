import { z } from "zod";
import type { NodeContext } from "../types.js";
import type { QuoteAgentState } from "../state.js";

const classificationSchema = z
  .object({
    kind: z.enum(["single", "multi_text", "bulk_file"]),
    unit_type_hints: z.array(z.string()),
    confidence: z.number().min(0).max(1)
  })
  .strict();

export async function classifyNode(state: QuoteAgentState, context: NodeContext) {
  return context.trace(state.run_id, "classify", async () => {
    const hasXlsx = state.message.attachments.some(
      (attachment) => /\.xlsx?$/i.test(attachment.filename) || attachment.mimeType.includes("spreadsheet")
    );
    if (hasXlsx) return { intake_kind: "bulk_file" as const };

    const units = context.tools.getUnits ? await context.tools.getUnits() : [];
    const availableUnitTypes = units.map((unit) => unit.unit_id);
    const classified = await context.model.withStructuredOutput(classificationSchema).invoke([
      {
        role: "system",
        content:
          "Classify the freight RFQ intake. Do not calculate prices. Available unit types: " +
          JSON.stringify(availableUnitTypes)
      },
      {
        role: "user",
        content: `${state.message.subject}\n${state.message.body_text}`
      }
    ]);
    return { intake_kind: classified.kind };
  });
}
