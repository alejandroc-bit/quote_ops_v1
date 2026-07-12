import { readFile } from "node:fs/promises";
import PDFDocument from "pdfkit";
import { z } from "zod";

export interface QuotePdfTemplate {
  title?: string;
  footer_note?: string;
  accent_color?: string;
  logo_base64?: string;
  show_breakdown?: boolean;
}

export interface QuotePdfInput {
  client_name: string;
  quote_id: string;
  date_iso: string;
  lanes: Array<{
    origin: string;
    destination: string;
    unit_type: string;
    commodity?: string;
    rate_mxn: number;
    currency: "MXN";
    lines: Array<{ concept: string; amount_mxn: number }>;
  }>;
  template?: QuotePdfTemplate;
}

export const DEFAULT_PDF_TEMPLATE: QuotePdfTemplate = {
  title: "Cotización de flete",
  accent_color: "#1a1a1a",
  show_breakdown: true
};

const templateSchema = z
  .object({
    title: z.string().optional(),
    footer_note: z.string().optional(),
    accent_color: z.string().optional(),
    logo_base64: z.string().optional(),
    show_breakdown: z.boolean().optional()
  })
  .strict();

export async function loadPdfTemplate(path?: string): Promise<QuotePdfTemplate> {
  const filePath = path ?? process.env.QUOTEOPS_PDF_TEMPLATE_PATH;
  if (!filePath) return { ...DEFAULT_PDF_TEMPLATE };
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8"));
    return { ...DEFAULT_PDF_TEMPLATE, ...templateSchema.parse(raw) };
  } catch {
    // ponytail: missing/invalid template file falls back to defaults
    return { ...DEFAULT_PDF_TEMPLATE };
  }
}

const mxn = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });

export function renderQuotePdf(input: QuotePdfInput): Promise<Buffer> {
  const t = { ...DEFAULT_PDF_TEMPLATE, ...input.template };
  const accent = t.accent_color ?? "#1a1a1a";

  // ponytail: compress:false keeps text inspectable in tests; enable if PDF size ever matters
  const doc = new PDFDocument({ size: "A4", margin: 50, compress: false });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  if (t.logo_base64) {
    try {
      doc.image(Buffer.from(t.logo_base64, "base64"), 50, 40, { fit: [120, 50] });
      doc.moveDown(2);
    } catch {
      // ponytail: bad logo data is ignored, PDF renders without it
    }
  }

  doc.fillColor(accent).fontSize(20).text(t.title ?? "Cotización de flete");
  doc.moveDown(0.5);
  doc.fillColor("#333333").fontSize(10);
  doc.text(`Cliente: ${input.client_name}`);
  doc.text(`Cotización: ${input.quote_id}`);
  doc.text(`Fecha: ${input.date_iso}`);
  doc.moveDown();

  for (const lane of input.lanes) {
    doc.fillColor(accent).fontSize(14).text(`${lane.origin} → ${lane.destination}`);
    doc.fillColor("#333333").fontSize(10);
    doc.text(`Tipo de unidad: ${lane.unit_type}`);
    if (lane.commodity) doc.text(`Mercancía: ${lane.commodity}`);
    doc.fontSize(12).text(`Tarifa: ${mxn.format(lane.rate_mxn)} ${lane.currency}`);
    if (t.show_breakdown !== false && lane.lines.length > 0) {
      doc.moveDown(0.3).fontSize(10).fillColor(accent).text("Desglose");
      doc.fillColor("#333333");
      for (const line of lane.lines) {
        doc.text(`${line.concept}: ${mxn.format(line.amount_mxn)}`, { indent: 12 });
      }
    }
    doc.moveDown();
  }

  if (t.footer_note) {
    doc.moveDown().fontSize(8).fillColor("#666666").text(t.footer_note);
  }

  doc.end();
  return done;
}
