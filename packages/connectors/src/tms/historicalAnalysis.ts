import { historicalAnalysisSchema } from "@quoteops/contracts";
import type { HistoricalAnalysis, HistoricalSearchLayer } from "@quoteops/contracts";
import type { HistoricalSearchQuery } from "./TmsAdapter.js";

/**
 * Shared historical-quote analysis used by every TMS adapter (file, http-side
 * fallback, sql). Adapters fetch raw rows however they can; the layer
 * selection, comparables math, and insufficient-data reasons live here once so
 * a CSV export and a SQL query produce identical analyses.
 */

export type SourceRow = Record<string, unknown>;

export interface HistoricalQuoteRecord {
  quote_id: string | null;
  rfq_id: string | null;
  lane_id: string | null;
  customer_id: string | null;
  origin_city: string | null;
  origin_state: string | null;
  origin_country: string | null;
  destination_city: string | null;
  destination_state: string | null;
  destination_country: string | null;
  vehicle_profile_id: string | null;
  equipment_request: string | null;
  commodity: string | null;
  commodity_category: string | null;
  sector: string | null;
  weight_kg: number | null;
  rate_mxn: number;
  direct_cost_mxn: number | null;
  margin_pct: number | null;
  quoted_at: string | null;
  service_type: string | null;
  status: string | null;
}

type HistoricalComparable = HistoricalAnalysis["comparables"][number];
type InsufficientData = HistoricalAnalysis["insufficient_data"][number];

export function coerceHistoricalQuoteRecord(row: SourceRow): HistoricalQuoteRecord | null {
  const rate = fieldNumber(row, ["rate_mxn", "quoted_rate_mxn", "rate"]);
  if (rate === null) {
    return null;
  }

  return {
    quote_id: fieldText(row, ["quote_id", "id"]),
    rfq_id: fieldText(row, ["rfq_id"]),
    lane_id: fieldText(row, ["lane_id"]),
    customer_id: fieldText(row, ["customer_id"]),
    origin_city: fieldText(row, ["origin_city", "origen_ciudad"]),
    origin_state: fieldText(row, ["origin_state", "origen_estado"]),
    origin_country: fieldText(row, ["origin_country", "origen_pais"]),
    destination_city: fieldText(row, ["destination_city", "destino_ciudad"]),
    destination_state: fieldText(row, ["destination_state", "destino_estado"]),
    destination_country: fieldText(row, ["destination_country", "destino_pais"]),
    vehicle_profile_id: fieldText(row, ["vehicle_profile_id", "profile_id", "unit_profile"]),
    equipment_request: fieldText(row, ["equipment_request", "equipment", "unit_type"]),
    commodity: fieldText(row, ["commodity", "mercancia"]),
    commodity_category: fieldText(row, ["commodity_category", "commodity_type", "categoria"]),
    sector: fieldText(row, ["sector", "industry"]),
    weight_kg: fieldNumber(row, ["weight_kg", "peso_kg"]),
    rate_mxn: rate,
    direct_cost_mxn: fieldNumber(row, ["direct_cost_mxn", "cost_mxn"]),
    margin_pct: fieldNumber(row, ["margin_pct", "margin"]),
    quoted_at: fieldText(row, ["quoted_at", "created_at", "date"]),
    service_type: fieldText(row, ["service_type", "service"]),
    status: fieldText(row, ["status"])
  };
}

export function analyzeHistoricalQuotes(
  allRecords: HistoricalQuoteRecord[],
  query: HistoricalSearchQuery
): HistoricalAnalysis {
  const records = allRecords
    .filter((record) => isWithinTimeWindow(record.quoted_at, query.time_window))
    .filter((record) => matchesOptional(record.vehicle_profile_id, query.vehicle_profile_id));
  const searchLayers: HistoricalSearchLayer[] = [
    "route_unit_cost",
    "commodity_category",
    "sector",
    "weight_band",
    "service_type"
  ];
  const comparables: HistoricalComparable[] = [];
  const insufficientData: InsufficientData[] = [];

  const routeRows = records.filter(
    (record) => isExactRoute(record, query) && matchesCargoContext(record, query)
  );
  const routeComparable = buildComparable("route_unit_cost", "exact_route_exact_unit", routeRows);
  if (routeComparable) {
    comparables.push(routeComparable);
  } else {
    insufficientData.push({
      layer: "route_unit_cost",
      reason: "exact_route_unit_history_missing"
    });
  }

  const commodityCategory = cleanString(query.cargo?.commodity_category);
  const sector = cleanString(query.cargo?.sector);
  if (commodityCategory) {
    const commodityRows = records.filter(
      (record) =>
        normalized(record.commodity_category) === normalized(commodityCategory) &&
        (!sector || normalized(record.sector) === normalized(sector))
    );
    const commodityComparable = buildComparable(
      "commodity_category",
      sector ? "same_commodity_sector_same_unit" : "same_commodity_same_unit",
      commodityRows,
      {
        commodity_category: commodityCategory,
        ...(sector ? { sector } : {})
      }
    );

    if (commodityComparable) {
      comparables.push(commodityComparable);
    } else {
      insufficientData.push({
        layer: "commodity_category",
        reason: "commodity_category_history_missing"
      });
    }
  }

  if (sector) {
    const sectorRows = records.filter(
      (record) => normalized(record.sector) === normalized(sector)
    );
    const sectorComparable = buildComparable("sector", "same_sector_same_unit", sectorRows, {
      sector
    });

    if (sectorComparable) {
      comparables.push(sectorComparable);
    } else {
      insufficientData.push({
        layer: "sector",
        reason: "sector_history_missing"
      });
    }
  }

  const requestedWeight = query.cargo?.weight_kg;
  if (requestedWeight === null || requestedWeight === undefined) {
    insufficientData.push({
      layer: "weight_band",
      reason: "weight_kg_missing"
    });
  } else {
    const requestedBand = weightBand(requestedWeight);
    const weightRows = records.filter(
      (record) => record.weight_kg !== null && weightBand(record.weight_kg) === requestedBand
    );
    const weightComparable = buildComparable(
      "weight_band",
      "same_weight_band_same_unit",
      weightRows,
      {
        weight_band: requestedBand
      }
    );

    if (weightComparable) {
      comparables.push(weightComparable);
    } else {
      insufficientData.push({
        layer: "weight_band",
        reason: "weight_band_history_missing"
      });
    }
  }

  const serviceType = cleanString(query.service_type);
  if (serviceType) {
    const serviceRows = records.filter(
      (record) => normalized(record.service_type) === normalized(serviceType)
    );
    const serviceComparable = buildComparable(
      "service_type",
      "same_service_type_same_unit",
      serviceRows
    );

    if (serviceComparable) {
      comparables.push(serviceComparable);
    } else {
      insufficientData.push({
        layer: "service_type",
        reason: "service_type_history_missing"
      });
    }
  }

  return historicalAnalysisSchema.parse({
    request_id: query.request_id,
    search_layers: searchLayers,
    time_window: query.time_window,
    comparables,
    insufficient_data: insufficientData
  });
}

function buildComparable(
  layer: HistoricalSearchLayer,
  matchQuality: string,
  records: HistoricalQuoteRecord[],
  extras: Partial<HistoricalComparable> = {}
): HistoricalComparable | null {
  const rates = records.map((record) => record.rate_mxn).sort((a, b) => a - b);
  if (rates.length === 0) {
    return null;
  }

  const directCosts = records
    .map((record) => record.direct_cost_mxn)
    .filter((value): value is number => typeof value === "number");
  const margins = records
    .map((record) => record.margin_pct)
    .filter((value): value is number => typeof value === "number");

  return {
    layer,
    match_quality: matchQuality,
    count: rates.length,
    min_rate_mxn: rates[0]!,
    p25_rate_mxn: percentile(rates, 0.25),
    median_rate_mxn: median(rates),
    p75_rate_mxn: percentile(rates, 0.75),
    max_rate_mxn: rates[rates.length - 1]!,
    ...(directCosts.length > 0 ? { avg_direct_cost_mxn: average(directCosts) } : {}),
    ...(margins.length > 0 ? { avg_margin_pct: average(margins) } : {}),
    ...extras
  };
}

function isExactRoute(record: HistoricalQuoteRecord, query: HistoricalSearchQuery): boolean {
  return (
    normalized(record.origin_city) === normalized(query.origin.city) &&
    normalized(record.origin_state) === normalized(query.origin.state) &&
    normalized(record.origin_country) === normalized(query.origin.country) &&
    normalized(record.destination_city) === normalized(query.destination.city) &&
    normalized(record.destination_state) === normalized(query.destination.state) &&
    normalized(record.destination_country) === normalized(query.destination.country)
  );
}

function matchesCargoContext(
  record: HistoricalQuoteRecord,
  query: HistoricalSearchQuery
): boolean {
  const commodity = cleanString(query.cargo?.commodity);
  const commodityCategory = cleanString(query.cargo?.commodity_category);
  const sector = cleanString(query.cargo?.sector);

  return (
    (!commodity || normalized(record.commodity) === normalized(commodity)) &&
    (!commodityCategory ||
      normalized(record.commodity_category) === normalized(commodityCategory)) &&
    (!sector || normalized(record.sector) === normalized(sector))
  );
}

export function matchesOptional(
  actual: string | null,
  expected: string | null | undefined
): boolean {
  if (!expected) {
    return true;
  }

  return normalized(actual) === normalized(expected);
}

export function isWithinTimeWindow(
  value: string | null,
  timeWindow: HistoricalSearchQuery["time_window"]
): boolean {
  if (!value) {
    return true;
  }

  const date = value.slice(0, 10);
  return date >= timeWindow.from && date <= timeWindow.to;
}

export function cleanString(value: string | null | undefined): string | null {
  const cleaned = value?.trim();
  return cleaned ? cleaned : null;
}

export function normalized(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase();
}

export function fieldText(row: SourceRow, names: string[]): string | null {
  for (const name of names) {
    const value = row[name];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    } else if (value instanceof Date) {
      return value.toISOString();
    }
  }

  return null;
}

export function fieldNumber(row: SourceRow, names: string[]): number | null {
  for (const name of names) {
    const value = row[name];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }

  return null;
}

function median(sortedValues: number[]): number {
  const mid = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 0) {
    return roundMoney((sortedValues[mid - 1]! + sortedValues[mid]!) / 2);
  }

  return sortedValues[mid]!;
}

function percentile(sortedValues: number[], percentileValue: number): number {
  if (sortedValues.length === 1) {
    return sortedValues[0]!;
  }

  const index = (sortedValues.length - 1) * percentileValue;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const lowerValue = sortedValues[lower]!;
  const upperValue = sortedValues[upper]!;

  return roundMoney(lowerValue + (upperValue - lowerValue) * (index - lower));
}

function average(values: number[]): number {
  return roundMoney(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function weightBand(weightKg: number): string {
  if (weightKg < 5000) return "0t_5t";
  if (weightKg < 10000) return "5t_10t";
  if (weightKg < 15000) return "10t_15t";
  if (weightKg < 20000) return "15t_20t";
  return "20t_plus";
}
