import {
  resolveProfile,
  type ProfitabilityRbBracket,
  type QuoteManifest,
  type QuoteRfqLaneInput,
  type ResolvedProfile
} from "./profileResolver.js";

export const QUOTE_CORE_VERSION = "quote-core-2.0.0";

export type RouteEvidence = {
  status: "resolved" | "missing" | "failed";
  source: "sakbe" | "manual" | "tms" | "mock";
  km_loaded: number | null;
  estimated_minutes: number | null;
  tolls_mxn: number | null;
  requires_return_route: boolean;
  km_return?: number | null;
  return_tolls_mxn?: number | null;
};

export type HistoricalContext = {
  selected_layer?: string;
  median_rate_mxn?: number;
  max_rate_mxn?: number;
  [key: string]: unknown;
} | null;

export type QuoteCoreInput = {
  rfq: QuoteRfqLaneInput;
  manifest: QuoteManifest;
  route_evidence: RouteEvidence;
  historical_context?: HistoricalContext;
};

export type QuoteCoreStatus = "APPROVED" | "REVIEW_REQUIRED";

export type QuoteCoreResult = {
  quote_core_version: typeof QUOTE_CORE_VERSION;
  quote_id: string;
  status: QuoteCoreStatus;
  pricing_model: "formula" | "profitability";
  profile: {
    profile_id: string | null;
    vehicle_profile_id: string;
    business_unit_id: string | null;
  };
  direct_cost_mxn: number;
  base_rate_mxn: number;
  margin_real_pct: number;
  review_reasons: string[];
  route_source: RouteEvidence["source"];
  historical_context: HistoricalContext;
  rb_pct?: number;
  rb_base_cost_mxn?: number;
};

const DEFAULT_RB_TABLE: ProfitabilityRbBracket[] = [
  { max_km: 100, rb_pct: 0.6 },
  { max_km: 500, rb_pct: 0.6 },
  { max_km: 1000, rb_pct: 0.57 },
  { max_km: 2000, rb_pct: 0.55 },
  { max_km: 3000, rb_pct: 0.52 },
  { max_km: null, rb_pct: 0.5 }
];

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function positive(value: number | null | undefined): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : 0;
}

function isMissingNumber(value: number | null | undefined): boolean {
  return value === null || value === undefined || !Number.isFinite(value);
}

function isValidMarginPct(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value < 1;
}

function lookupRbForKm(kmTotal: number, rbTable: ProfitabilityRbBracket[]): number {
  for (const bracket of rbTable) {
    if (bracket.max_km === null || kmTotal <= bracket.max_km) {
      return bracket.rb_pct;
    }
  }
  return 0.5;
}

function calculateBaseCost({
  rfq,
  profile,
  route
}: {
  rfq: QuoteRfqLaneInput;
  profile: ResolvedProfile;
  route: RouteEvidence;
}): {
  formulaCost: number;
  rbBaseCost: number;
  kmOperational: number;
} {
  const kmLoaded = positive(route.km_loaded);
  const kmReturn = positive(route.km_return);
  const kmOperational = kmLoaded + kmReturn;
  const loadedPerformance = Math.max(0.1, profile.fuel_loaded_km_per_l);
  const emptyPerformance = Math.max(0.1, profile.fuel_empty_km_per_l);
  const fuelCost = round2(
    (kmLoaded / loadedPerformance + kmReturn / emptyPerformance) *
      profile.diesel_price_mxn_per_liter
  );
  const tollCost = positive(route.tolls_mxn) + positive(route.return_tolls_mxn);
  const operatorCost = round2(kmOperational * profile.operator_cost_per_km_mxn);
  const maintenance = round2(kmOperational * positive(profile.maintenance_per_km_mxn));
  const tires = round2(kmOperational * positive(profile.tires_per_km_mxn));
  const overhead = round2(kmOperational * positive(profile.fixed_overhead_per_km_mxn));
  const depreciation = round2(kmOperational * positive(profile.depreciation_per_km_mxn));
  const insurance = Math.max(
    positive(profile.insurance_min_mxn),
    round2(positive(rfq.cargo.value_mxn) * positive(profile.insurance_rate))
  );
  const rbBaseCost = round2(fuelCost + tollCost + operatorCost);
  const formulaCost = round2(
    rbBaseCost + maintenance + tires + overhead + depreciation + insurance
  );

  return { formulaCost, rbBaseCost, kmOperational };
}

export function calculateQuote(input: QuoteCoreInput): QuoteCoreResult {
  const profileResolution = resolveProfile({
    requester_email: input.rfq.requester_email,
    client_id: input.rfq.client_id,
    business_unit_id: input.rfq.business_unit_id,
    vehicle_profile_id: input.rfq.vehicle_profile_id,
    manifest: input.manifest
  });
  const reviewReasons: string[] = [...profileResolution.review_reasons];

  if (input.manifest.route_policy.sakbe_required) {
    if (input.route_evidence.source !== "sakbe") {
      reviewReasons.push("route_evidence_source_not_sakbe");
    }

    if (
      input.route_evidence.status !== "resolved" ||
      isMissingNumber(input.route_evidence.km_loaded) ||
      positive(input.route_evidence.km_loaded) === 0 ||
      isMissingNumber(input.route_evidence.estimated_minutes)
    ) {
      reviewReasons.push("route_evidence_missing");
    }

    if (isMissingNumber(input.route_evidence.tolls_mxn)) {
      reviewReasons.push("toll_evidence_missing");
    }

    if (input.route_evidence.requires_return_route) {
      if (
        isMissingNumber(input.route_evidence.km_return) ||
        positive(input.route_evidence.km_return) === 0
      ) {
        reviewReasons.push("return_route_evidence_missing");
      }

      if (isMissingNumber(input.route_evidence.return_tolls_mxn)) {
        reviewReasons.push("return_toll_evidence_missing");
      }
    }
  }

  const fallbackVehicleProfileId = input.rfq.vehicle_profile_id;
  if (profileResolution.status === "missing") {
    return {
      quote_core_version: QUOTE_CORE_VERSION,
      quote_id: `quote-v2-${input.rfq.lane_id}`,
      status: "REVIEW_REQUIRED",
      pricing_model: "formula",
      profile: {
        profile_id: null,
        vehicle_profile_id: fallbackVehicleProfileId,
        business_unit_id: input.rfq.business_unit_id || null
      },
      direct_cost_mxn: 0,
      base_rate_mxn: 0,
      margin_real_pct: 0,
      review_reasons: reviewReasons,
      route_source: input.route_evidence.source,
      historical_context: input.historical_context || null
    };
  }

  if (positive(input.rfq.cargo.weight_kg) > profileResolution.profile.payload_capacity_kg) {
    reviewReasons.push("payload_capacity_exceeded");
  }

  if (
    !isValidMarginPct(profileResolution.profile.margin_target_pct) ||
    !isValidMarginPct(profileResolution.profile.minimum_margin_pct)
  ) {
    reviewReasons.push("invalid_margin_policy");
  }

  const { formulaCost, rbBaseCost, kmOperational } = calculateBaseCost({
    rfq: input.rfq,
    profile: profileResolution.profile,
    route: input.route_evidence
  });
  const pricingModel = profileResolution.profile.pricing_model;
  let directCost = formulaCost;
  const safeMarginTarget = isValidMarginPct(profileResolution.profile.margin_target_pct)
    ? profileResolution.profile.margin_target_pct
    : 0;
  let baseRate = round2(formulaCost / (1 - safeMarginTarget));
  let rbPct: number | undefined;
  let resultRbBaseCost: number | undefined;

  if (pricingModel === "profitability") {
    const table = profileResolution.profile.profitability_rb_table || DEFAULT_RB_TABLE;
    rbPct = lookupRbForKm(kmOperational, table);
    if (!isValidMarginPct(rbPct)) {
      reviewReasons.push("invalid_margin_policy");
      rbPct = 0;
    }
    directCost = rbBaseCost;
    resultRbBaseCost = rbBaseCost;
    baseRate = round2(rbBaseCost / (1 - rbPct));
  }

  const marginRealPct = baseRate > 0 ? round4((baseRate - directCost) / baseRate) : 0;
  if (
    isValidMarginPct(profileResolution.profile.minimum_margin_pct) &&
    marginRealPct < profileResolution.profile.minimum_margin_pct
  ) {
    reviewReasons.push("margin_below_minimum");
  }
  const status = reviewReasons.length > 0 ? "REVIEW_REQUIRED" : "APPROVED";

  return {
    quote_core_version: QUOTE_CORE_VERSION,
    quote_id: `quote-v2-${input.rfq.lane_id}`,
    status,
    pricing_model: pricingModel,
    profile: {
      profile_id: profileResolution.profile.profile_id,
      vehicle_profile_id: profileResolution.profile.vehicle_profile_id,
      business_unit_id: profileResolution.profile.business_unit_id
    },
    direct_cost_mxn: directCost,
    base_rate_mxn: baseRate,
    margin_real_pct: marginRealPct,
    review_reasons: reviewReasons,
    route_source: input.route_evidence.source,
    historical_context: input.historical_context || null,
    ...(rbPct != null ? { rb_pct: rbPct } : {}),
    ...(resultRbBaseCost != null ? { rb_base_cost_mxn: resultRbBaseCost } : {})
  };
}
