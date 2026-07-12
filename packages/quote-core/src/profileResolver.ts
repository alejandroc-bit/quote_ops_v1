export type QuoteLocation = {
  city: string;
  state: string;
  country: string;
};

export type QuoteRfqLaneInput = {
  rfq_id: string;
  lane_id: string;
  requester_email?: string;
  client_id?: string | null;
  business_unit_id?: string | null;
  origin: QuoteLocation;
  destination: QuoteLocation;
  vehicle_profile_id: string;
  cargo: {
    weight_kg: number | null;
    value_mxn?: number | null;
    commodity?: string | null;
    commodity_category?: string | null;
    sector?: string | null;
    hazmat?: boolean;
  };
  service: {
    return_policy: string;
    route_policy: string;
  };
  commercial: {
    target_rate_mxn?: number | null;
  };
};

export type QuoteBusinessUnit = {
  business_unit_id: string;
  requester_email_domains?: string[];
  keywords?: string[];
  default?: boolean;
};

export type ProfitabilityRbBracket = {
  max_km: number | null;
  rb_pct: number;
};

export type QuoteVehicleProfile = {
  vehicle_profile_id: string;
  business_unit_id: string;
  keywords?: string[];
  payload_capacity_kg: number;
  fuel_loaded_km_per_l: number;
  fuel_empty_km_per_l: number;
  operator_cost_per_km_mxn: number;
  pricing_model: "formula" | "profitability";
  diesel_price_mxn_per_liter: number;
  margin_target_pct: number;
  minimum_margin_pct: number;
  maintenance_per_km_mxn?: number;
  tires_per_km_mxn?: number;
  fixed_overhead_per_km_mxn?: number;
  depreciation_per_km_mxn?: number;
  insurance_rate?: number;
  insurance_min_mxn?: number;
  profitability_rb_table?: ProfitabilityRbBracket[];
  /** When "tms", the appliance overlays fuel yield from the TMS at runtime. */
  performance_source?: "tms" | "manifest";
  /** Real settled cost/km from the TMS, attached as context for the guide. */
  tms_real_cost_per_km?: number;
};

export type QuoteManifest = {
  client_id: string;
  business_units: QuoteBusinessUnit[];
  vehicle_profiles: QuoteVehicleProfile[];
  route_policy: {
    sakbe_required: boolean;
  };
};

export type ResolvedProfile = QuoteVehicleProfile & {
  profile_id: string;
  client_id: string;
};

export type ProfileResolution =
  | {
      status: "resolved";
      profile: ResolvedProfile;
      review_reasons: [];
    }
  | {
      status: "missing";
      profile: null;
      review_reasons: ["operating_profile_missing"];
    };

function normalize(value: string | null | undefined): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function emailDomain(email: string | null | undefined): string {
  const normalized = normalize(email);
  const at = normalized.lastIndexOf("@");
  return at >= 0 ? normalized.slice(at + 1) : normalized;
}

function textMatchesKeywords(text: string, keywords: string[] | undefined): boolean {
  const normalizedText = normalize(text);
  return (keywords ?? []).some((keyword) => {
    const normalizedKeyword = normalize(keyword);
    return normalizedKeyword.length > 0 && normalizedText.includes(normalizedKeyword);
  });
}

function resolveBusinessUnitId({
  requester_email,
  business_unit_id,
  text,
  manifest
}: {
  requester_email?: string;
  business_unit_id?: string | null;
  text?: string | null;
  manifest: QuoteManifest;
}): string {
  if (business_unit_id) return business_unit_id;

  const keywordBusinessUnit = text
    ? manifest.business_units.find((unit) => textMatchesKeywords(text, unit.keywords))
    : undefined;
  if (keywordBusinessUnit) return keywordBusinessUnit.business_unit_id;

  const domain = emailDomain(requester_email);
  const domainBusinessUnit = manifest.business_units.find((unit) =>
    (unit.requester_email_domains || []).map(normalize).includes(domain)
  );
  return (
    domainBusinessUnit?.business_unit_id ||
    manifest.business_units.find((unit) => unit.default)?.business_unit_id ||
    manifest.business_units[0]?.business_unit_id ||
    ""
  );
}

export type TextLaneResolution = {
  business_unit_id: string;
  vehicle_profile_ids: string[];
};

/**
 * Deterministic keyword resolution for free-text RFQs ("cotizame en full y
 * sencillo un Monterrey - Mexico en plataformas"): the business unit comes
 * from its keywords (or email domain / default), and every vehicle profile of
 * that unit whose keywords appear in the text produces one lane.
 */
export function resolveLanesFromText({
  text,
  requester_email,
  manifest
}: {
  text: string;
  requester_email?: string;
  manifest: QuoteManifest;
}): TextLaneResolution {
  const businessUnitId = resolveBusinessUnitId({ requester_email, text, manifest });
  const vehicleProfileIds = manifest.vehicle_profiles
    .filter(
      (profile) =>
        normalize(profile.business_unit_id) === normalize(businessUnitId) &&
        textMatchesKeywords(text, profile.keywords)
    )
    .map((profile) => profile.vehicle_profile_id);

  return {
    business_unit_id: businessUnitId,
    vehicle_profile_ids: vehicleProfileIds
  };
}

export function resolveProfile({
  requester_email,
  client_id,
  business_unit_id,
  vehicle_profile_id,
  manifest
}: {
  requester_email?: string;
  client_id?: string | null;
  business_unit_id?: string | null;
  vehicle_profile_id: string;
  manifest: QuoteManifest;
}): ProfileResolution {
  const resolvedBusinessUnitId = resolveBusinessUnitId({
    requester_email,
    business_unit_id,
    manifest
  });

  const unitProfiles = manifest.vehicle_profiles.filter(
    (candidate) => normalize(candidate.business_unit_id) === normalize(resolvedBusinessUnitId)
  );
  const profile =
    unitProfiles.find(
      (candidate) => normalize(candidate.vehicle_profile_id) === normalize(vehicle_profile_id)
    ) ??
    unitProfiles.find((candidate) => textMatchesKeywords(vehicle_profile_id, candidate.keywords));

  if (!profile || normalize(client_id) !== normalize(manifest.client_id)) {
    return {
      status: "missing",
      profile: null,
      review_reasons: ["operating_profile_missing"]
    };
  }

  return {
    status: "resolved",
    profile: {
      ...profile,
      client_id: manifest.client_id,
      profile_id: `${manifest.client_id}:${profile.business_unit_id}:${profile.vehicle_profile_id}`
    },
    review_reasons: []
  };
}

