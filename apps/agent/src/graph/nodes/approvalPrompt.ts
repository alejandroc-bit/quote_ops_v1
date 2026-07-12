import type { NodeContext } from "../types.js";
import type { QuoteAgentState } from "../state.js";

export async function approvalPromptNode(state: QuoteAgentState, context: NodeContext) {
  return context.trace(state.run_id, "approvalPrompt", async () => {
    const requiresPrompt = state.recommendation.some((item) =>
      item.reason.includes("mid_band_confirmation_required")
    );
    if (!requiresPrompt || state.confirmation_prompt_sent) return {};
    const channel = context.channels[state.channel];
    if (!channel) throw new Error(`quote response channel is not configured: ${state.channel}`);
    const approver = context.env.QUOTEOPS_APPROVER_EMAIL?.trim();
    if (!approver) throw new Error("mid-band confirmation requires QUOTEOPS_APPROVER_EMAIL");
    await channel.send({
      to: approver,
      ...(state.channel === "email" ? { subject: `Confirmación de cotización ${state.run_id}` } : {}),
      body_md: [
        "La tarifa calculada está en el rango medio histórico. ¿Confirmo y envío la cotización?",
        `Run ID: ${state.run_id}`,
        `Decide en el portal mediante POST /api/approvals/${state.run_id}/decision.`
      ].join("\n\n")
    });
    return { confirmation_prompt_sent: true };
  });
}
