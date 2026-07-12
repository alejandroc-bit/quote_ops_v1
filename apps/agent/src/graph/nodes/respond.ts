import { renderQuotePdf, loadPdfTemplate } from "../../pdf/quotePdf.js";
import type { NodeContext } from "../types.js";
import type { QuoteAgentState } from "../state.js";

export async function respondNode(state: QuoteAgentState, context: NodeContext) {
  return context.trace(state.run_id, "respond", async () => {
    if (state.terminal_blocker || state.quotes.length === 0) return { response_sent: false };
    if (state.approval?.action === "reject" || state.approval?.action === "request_review") {
      return { response_sent: false };
    }
    const quotedLanes = state.quotes.map((quote, index) => {
      const lane = state.lanes.find((candidate) => candidate.lane_id === quote.lane_id);
      const adjusted = index === 0 && state.approval?.action === "adjust" && state.approval.rate_mxn;
      return {
        origin: formatLocation(lane?.origin),
        destination: formatLocation(lane?.destination),
        unit_type: lane?.vehicle_profile_id ?? quote.profile.vehicle_profile_id,
        ...(lane?.cargo.commodity ? { commodity: lane.cargo.commodity } : {}),
        rate_mxn: adjusted || quote.base_rate_mxn,
        currency: "MXN" as const,
        lines: [
          { concept: "Costo directo", amount_mxn: quote.direct_cost_mxn },
          { concept: "Tarifa quote-core", amount_mxn: quote.base_rate_mxn }
        ]
      };
    });
    const pdf = await renderQuotePdf({
      client_name: context.manifest.client_id,
      quote_id: state.run_id,
      date_iso: context.now().toISOString().slice(0, 10),
      lanes: quotedLanes,
      template: await loadPdfTemplate(context.env?.QUOTEOPS_PDF_TEMPLATE_PATH)
    });
    const channel = context.channels[state.channel];
    if (!channel) throw new Error(`quote response channel is not configured: ${state.channel}`);
    await channel.send({
      to: state.message.from_email,
      ...(state.channel === "email" ? { subject: replySubject(state.message.subject) } : {}),
      body_md: "Adjunto encontrarás la cotización calculada por quote-core.",
      ...(state.message.rfc_message_id
        ? {
            reply_to: {
              message_id: state.message.rfc_message_id,
              references: state.message.references ?? [],
              subject: state.message.subject
            }
          }
        : {}),
      attachments: [
        { filename: `${state.run_id}.pdf`, content: pdf, content_type: "application/pdf" }
      ]
    });
    return { response_sent: true };
  });
}

function replySubject(subject: string): string {
  const trimmed = subject.trim() || "Cotización";
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

function formatLocation(location: { city: string; state: string } | undefined): string {
  return location ? `${location.city}, ${location.state}` : "Ruta no especificada";
}
