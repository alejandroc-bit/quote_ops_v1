export function normalizeVersion(version: string): number[] {
  return version
    .trim()
    .replace(/^v/i, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
}

export function isUpdateAvailable(
  installed: string | null | undefined,
  latest: string | null | undefined
): boolean {
  if (!latest) return false;
  if (!installed) return true;
  const stableVersion = /^v?\d+\.\d+\.\d+$/;
  if (!stableVersion.test(installed.trim()) || !stableVersion.test(latest.trim())) return false;
  const a = normalizeVersion(installed);
  const b = normalizeVersion(latest);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (right > left) return true;
    if (right < left) return false;
  }
  return false;
}

export type PdfTemplateParseResult =
  | { ok: true; value: Record<string, unknown> | undefined }
  | { ok: false; error: string };

export function parsePdfTemplate(raw: string): PdfTemplateParseResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: undefined };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "La plantilla debe ser un objeto JSON, por ejemplo {\"title\": \"...\"}" };
    }
    const template = parsed as Record<string, unknown>;
    const supportedStringFields = ["title", "footer_note", "accent_color", "logo_base64"];
    const supportedFields = new Set([...supportedStringFields, "show_breakdown"]);
    const unsupported = Object.keys(template).find((key) => !supportedFields.has(key));
    if (unsupported) {
      return { ok: false, error: `Campo no soportado en la plantilla PDF: ${unsupported}.` };
    }
    const invalidStringField = supportedStringFields.find(
      (key) => key in template && typeof template[key] !== "string"
    );
    if (invalidStringField) {
      return { ok: false, error: `${invalidStringField} debe ser texto.` };
    }
    if ("show_breakdown" in template && typeof template.show_breakdown !== "boolean") {
      return { ok: false, error: "show_breakdown debe ser un valor booleano." };
    }
    return { ok: true, value: template };
  } catch {
    return { ok: false, error: "JSON inválido: revisa comillas, comas y llaves." };
  }
}
