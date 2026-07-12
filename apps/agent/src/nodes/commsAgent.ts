import type { QuoteWorkflowState } from "../state.js";
import { recordNodeEvent } from "./audit.js";

export async function commsAgentNode(state: QuoteWorkflowState): Promise<QuoteWorkflowState> {
  const quoted = state.child_results.filter((child) => child.recommendation);
  const count = quoted.length || 1;
  const subject = count === 1 ? "1 cotizacion QuoteOps" : `${count} cotizaciones QuoteOps`;

  let body: string;
  if (state.approval_state?.required) {
    body = "Cotizacion retenida para revision interna con evidencia adjunta.";
  } else if (quoted.length > 1) {
    body = quoted
      .map(
        (child) =>
          `${child.lane_id}: $${Math.round(child.recommendation?.recommended_rate_mxn ?? 0)} MXN`
      )
      .join("\n");
  } else {
    const rate =
      quoted[0]?.recommendation?.recommended_rate_mxn ??
      state.recommendation?.recommended_rate_mxn ??
      0;
    body = `Tarifa recomendada: $${Math.round(rate)} MXN.`;
  }

  return recordNodeEvent(
    { ...state, email_draft: { subject, body } },
    "commsAgent",
    "completed",
    { subject }
  );
}
