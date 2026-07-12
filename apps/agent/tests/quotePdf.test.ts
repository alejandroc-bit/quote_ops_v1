import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PDF_TEMPLATE,
  loadPdfTemplate,
  renderQuotePdf,
  type QuotePdfInput
} from "../src/pdf/quotePdf.js";

const input: QuotePdfInput = {
  client_name: "NMX Logística",
  quote_id: "Q-2026-001",
  date_iso: "2026-07-11",
  lanes: [
    {
      origin: "Monterrey",
      destination: "CDMX",
      unit_type: "caja seca 53",
      commodity: "abarrotes",
      rate_mxn: 28500,
      currency: "MXN",
      lines: [
        { concept: "Diesel", amount_mxn: 12000 },
        { concept: "Operador", amount_mxn: 5500 }
      ]
    }
  ]
};

describe("renderQuotePdf", () => {
  it("renders a non-empty PDF buffer", async () => {
    const buf = await renderQuotePdf(input);
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("includes rate digits in the output", async () => {
    const buf = await renderQuotePdf(input);
    const text = buf.toString("latin1");
    // pdfkit hex-encodes text strings; "28,500" -> hex of its chars
    expect(text).toContain(Buffer.from("28,500").toString("hex"));
  });

  it("honors template overrides (title changes output)", async () => {
    const a = await renderQuotePdf(input);
    const b = await renderQuotePdf({
      ...input,
      template: { title: "Propuesta de servicio", accent_color: "#0044cc" }
    });
    expect(a.equals(b)).toBe(false);
  });
});

describe("loadPdfTemplate", () => {
  it("returns defaults when no path is set", async () => {
    delete process.env.QUOTEOPS_PDF_TEMPLATE_PATH;
    expect(await loadPdfTemplate()).toEqual(DEFAULT_PDF_TEMPLATE);
  });

  it("merges a JSON template file over defaults", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quotepdf-"));
    const file = join(dir, "template.json");
    await writeFile(file, JSON.stringify({ title: "Custom", footer_note: "Vigencia 15 días" }));
    const tpl = await loadPdfTemplate(file);
    expect(tpl.title).toBe("Custom");
    expect(tpl.footer_note).toBe("Vigencia 15 días");
    expect(tpl.show_breakdown).toBe(true);
  });

  it("falls back to defaults on invalid file", async () => {
    expect(await loadPdfTemplate("/nonexistent/tpl.json")).toEqual(DEFAULT_PDF_TEMPLATE);
  });
});
