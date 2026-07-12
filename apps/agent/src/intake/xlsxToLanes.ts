import * as XLSX from "xlsx";

export type DraftLane = {
  origin: { city: string; state: string; country?: string };
  destination: { city: string; state: string; country?: string };
  equipment_text?: string | null;
  vehicle_profile_id?: string | null;
  business_unit_id?: string | null;
  weight_kg?: number | null;
  commodity?: string | null;
  commodity_category?: string | null;
  sector?: string | null;
  value_mxn?: number | null;
  hazmat?: boolean;
  target_rate_mxn?: number | null;
  customer_id?: string | null;
  customer_type?: string | null;
};

const REQUIRED_COLUMNS = ["origin_city", "origin_state", "destination_city", "destination_state"];

/**
 * Deterministic batch intake: one draft lane per spreadsheet row. Expected
 * headers match the install-pack rfqs.csv template (origin_city, origin_state,
 * destination_city, destination_state, equipment_request, weight_kg, ...).
 */
export function xlsxToDraftLanes(content: Buffer | Uint8Array): DraftLane[] {
  const workbook = XLSX.read(content, { type: "buffer" });
  const sheet = workbook.SheetNames[0] ? workbook.Sheets[workbook.SheetNames[0]] : undefined;
  if (!sheet) {
    throw new Error("xlsx attachment has no sheets");
  }

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: null
  });
  if (rows.length === 0) {
    throw new Error("xlsx attachment has no data rows");
  }

  return rows.map((rawRow, index) => {
    const row = normalizeRowKeys(rawRow);
    for (const column of REQUIRED_COLUMNS) {
      if (!stringCell(row[column])) {
        throw new Error(`xlsx row ${index + 2} is missing required column: ${column}`);
      }
    }

    return {
      origin: {
        city: stringCell(row.origin_city)!,
        state: stringCell(row.origin_state)!,
        country: stringCell(row.origin_country) ?? undefined
      },
      destination: {
        city: stringCell(row.destination_city)!,
        state: stringCell(row.destination_state)!,
        country: stringCell(row.destination_country) ?? undefined
      },
      equipment_text: stringCell(row.equipment_request),
      vehicle_profile_id: stringCell(row.vehicle_profile_id),
      business_unit_id: stringCell(row.business_unit_id),
      weight_kg: numberCell(row.weight_kg),
      commodity: stringCell(row.commodity),
      commodity_category: stringCell(row.commodity_category),
      sector: stringCell(row.sector),
      value_mxn: numberCell(row.value_mxn),
      target_rate_mxn: numberCell(row.target_rate_mxn),
      customer_id: stringCell(row.customer_id),
      customer_type: stringCell(row.customer_type)
    };
  });
}

function normalizeRowKeys(row: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[key.trim().toLowerCase().replace(/\s+/g, "_")] = value;
  }
  return normalized;
}

function stringCell(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function numberCell(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/[$,\s]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
