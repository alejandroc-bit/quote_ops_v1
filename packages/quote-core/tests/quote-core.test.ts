import { describe, expect, it } from "vitest";
import {
  calculateQuote,
  planRfqBatch,
  resolveLanesFromText,
  resolveProfile,
  type QuoteCoreInput,
  type QuoteManifest
} from "../src/index";

const baseInput: QuoteCoreInput = {
  rfq: {
    rfq_id: "RFQ-2026-000001",
    lane_id: "RFQ-2026-000001-L01",
    requester_email: "compras@cliente.com",
    client_id: "cliente-demo",
    business_unit_id: "general",
    origin: { city: "Monterrey", state: "Nuevo Leon", country: "MX" },
    destination: { city: "Saltillo", state: "Coahuila", country: "MX" },
    vehicle_profile_id: "T3S2_53_DRYVAN",
    cargo: {
      weight_kg: 12000,
      value_mxn: 250000,
      commodity: "autopartes",
      commodity_category: "industrial",
      sector: "manufactura",
      hazmat: false
    },
    service: {
      return_policy: "sin_retorno",
      route_policy: "cuota"
    },
    commercial: {
      target_rate_mxn: null
    }
  },
  manifest: {
    client_id: "cliente-demo",
    business_units: [
      {
        business_unit_id: "general",
        requester_email_domains: ["cliente.com"],
        default: true
      }
    ],
    vehicle_profiles: [
      {
        vehicle_profile_id: "T3S2_53_DRYVAN",
        business_unit_id: "general",
        payload_capacity_kg: 24000,
        fuel_loaded_km_per_l: 3,
        fuel_empty_km_per_l: 3.4,
        operator_cost_per_km_mxn: 2.5,
        pricing_model: "formula",
        diesel_price_mxn_per_liter: 24,
        margin_target_pct: 0.25,
        minimum_margin_pct: 0.18,
        maintenance_per_km_mxn: 2,
        tires_per_km_mxn: 1.25,
        fixed_overhead_per_km_mxn: 1,
        depreciation_per_km_mxn: 1.5,
        insurance_rate: 0.002,
        insurance_min_mxn: 500
      }
    ],
    route_policy: {
      sakbe_required: true
    }
  },
  route_evidence: {
    status: "resolved",
    source: "sakbe",
    km_loaded: 80,
    estimated_minutes: 85,
    tolls_mxn: 600,
    requires_return_route: false
  },
  historical_context: {
    selected_layer: "route_unit_cost",
    median_rate_mxn: 9000,
    max_rate_mxn: 12000
  }
};

describe("calculateQuote", () => {
  it("calculates a simple quote with exact route and unit profile", () => {
    const result = calculateQuote(baseInput);

    expect(result.status).toBe("APPROVED");
    expect(result.quote_core_version).toBe("quote-core-2.0.0");
    expect(result.pricing_model).toBe("formula");
    expect(result.base_rate_mxn).toBeGreaterThan(result.direct_cost_mxn);
    expect(result.profile.profile_id).toBe(
      "cliente-demo:general:T3S2_53_DRYVAN"
    );
    expect(result.review_reasons).toEqual([]);
  });

  it("requires review when no exact operating profile exists", () => {
    const input: QuoteCoreInput = {
      ...baseInput,
      rfq: { ...baseInput.rfq, vehicle_profile_id: "T3S2_53_FLATBED" }
    };

    const result = calculateQuote(input);

    expect(result.status).toBe("REVIEW_REQUIRED");
    expect(result.review_reasons).toContain("operating_profile_missing");
  });

  it("requires review when SAKBE route evidence is missing and policy requires it", () => {
    const input: QuoteCoreInput = {
      ...baseInput,
      route_evidence: {
        status: "missing",
        source: "sakbe",
        km_loaded: null,
        estimated_minutes: null,
        tolls_mxn: null,
        requires_return_route: false
      }
    };

    const result = calculateQuote(input);

    expect(result.status).toBe("REVIEW_REQUIRED");
    expect(result.review_reasons).toContain("route_evidence_missing");
  });

  it("requires review when SAKBE policy receives mock route evidence", () => {
    const input: QuoteCoreInput = {
      ...baseInput,
      route_evidence: {
        ...baseInput.route_evidence,
        source: "mock"
      }
    };

    const result = calculateQuote(input);

    expect(result.status).toBe("REVIEW_REQUIRED");
    expect(result.review_reasons).toContain("route_evidence_source_not_sakbe");
  });

  it("requires review when required SAKBE toll evidence is missing", () => {
    const input: QuoteCoreInput = {
      ...baseInput,
      route_evidence: {
        ...baseInput.route_evidence,
        tolls_mxn: null
      }
    };

    const result = calculateQuote(input);

    expect(result.status).toBe("REVIEW_REQUIRED");
    expect(result.review_reasons).toContain("toll_evidence_missing");
  });

  it("does not change the base rate when historical context changes", () => {
    const lowHistory = calculateQuote({
      ...baseInput,
      historical_context: { selected_layer: "route_unit_cost", median_rate_mxn: 1 }
    });
    const highHistory = calculateQuote({
      ...baseInput,
      historical_context: {
        selected_layer: "route_unit_cost",
        median_rate_mxn: 100000
      }
    });

    expect(lowHistory.base_rate_mxn).toBe(highHistory.base_rate_mxn);
    expect(highHistory.historical_context?.median_rate_mxn).toBe(100000);
  });

  it("calculates profitability mode as base / (1 - RB)", () => {
    const input: QuoteCoreInput = {
      ...baseInput,
      manifest: {
        ...baseInput.manifest,
        vehicle_profiles: [
          {
            ...baseInput.manifest.vehicle_profiles[0],
            pricing_model: "profitability",
            profitability_rb_table: [{ max_km: null, rb_pct: 0.5 }]
          }
        ]
      }
    };

    const result = calculateQuote(input);

    expect(result.pricing_model).toBe("profitability");
    expect(result.rb_pct).toBe(0.5);
    expect(result.base_rate_mxn).toBe(result.rb_base_cost_mxn! / (1 - 0.5));
  });

  it("requires review instead of returning infinity for invalid RB policy", () => {
    const input: QuoteCoreInput = {
      ...baseInput,
      manifest: {
        ...baseInput.manifest,
        vehicle_profiles: [
          {
            ...baseInput.manifest.vehicle_profiles[0],
            pricing_model: "profitability",
            profitability_rb_table: [{ max_km: null, rb_pct: 1 }]
          }
        ]
      }
    };

    const result = calculateQuote(input);

    expect(result.status).toBe("REVIEW_REQUIRED");
    expect(result.review_reasons).toContain("invalid_margin_policy");
    expect(Number.isFinite(result.base_rate_mxn)).toBe(true);
  });

  it("requires review instead of returning infinity for invalid margin policy", () => {
    const input: QuoteCoreInput = {
      ...baseInput,
      manifest: {
        ...baseInput.manifest,
        vehicle_profiles: [
          {
            ...baseInput.manifest.vehicle_profiles[0],
            margin_target_pct: 1
          }
        ]
      }
    };

    const result = calculateQuote(input);

    expect(result.status).toBe("REVIEW_REQUIRED");
    expect(result.review_reasons).toContain("invalid_margin_policy");
    expect(Number.isFinite(result.base_rate_mxn)).toBe(true);
  });

  it("requires review when target margin is below configured minimum margin", () => {
    const input: QuoteCoreInput = {
      ...baseInput,
      manifest: {
        ...baseInput.manifest,
        vehicle_profiles: [
          {
            ...baseInput.manifest.vehicle_profiles[0],
            margin_target_pct: 0.1,
            minimum_margin_pct: 0.18
          }
        ]
      }
    };

    const result = calculateQuote(input);

    expect(result.status).toBe("REVIEW_REQUIRED");
    expect(result.review_reasons).toContain("margin_below_minimum");
  });

  it("requires review when return route evidence is required but missing", () => {
    const input: QuoteCoreInput = {
      ...baseInput,
      route_evidence: {
        ...baseInput.route_evidence,
        requires_return_route: true,
        km_return: null,
        return_tolls_mxn: null
      }
    };

    const result = calculateQuote(input);

    expect(result.status).toBe("REVIEW_REQUIRED");
    expect(result.review_reasons).toContain("return_route_evidence_missing");
  });

  it("requires review when return toll evidence is required but missing", () => {
    const input: QuoteCoreInput = {
      ...baseInput,
      route_evidence: {
        ...baseInput.route_evidence,
        requires_return_route: true,
        km_return: 80,
        return_tolls_mxn: null
      }
    };

    const result = calculateQuote(input);

    expect(result.status).toBe("REVIEW_REQUIRED");
    expect(result.review_reasons).toContain("return_toll_evidence_missing");
  });

  it("requires review when cargo exceeds payload capacity", () => {
    const input: QuoteCoreInput = {
      ...baseInput,
      rfq: {
        ...baseInput.rfq,
        cargo: {
          ...baseInput.rfq.cargo,
          weight_kg: 26000
        }
      }
    };

    const result = calculateQuote(input);

    expect(result.status).toBe("REVIEW_REQUIRED");
    expect(result.review_reasons).toContain("payload_capacity_exceeded");
  });
});

describe("resolveProfile", () => {
  it("resolves a profile by client, business unit, and vehicle profile", () => {
    const result = resolveProfile({
      requester_email: "compras@cliente.com",
      client_id: "cliente-demo",
      business_unit_id: "general",
      vehicle_profile_id: "T3S2_53_DRYVAN",
      manifest: baseInput.manifest
    });

    expect(result.status).toBe("resolved");
    expect(result.profile?.profile_id).toBe("cliente-demo:general:T3S2_53_DRYVAN");
  });

  it("falls back to profile keywords when the requested equipment is free text", () => {
    const manifest: QuoteManifest = {
      ...baseInput.manifest,
      vehicle_profiles: [
        {
          ...baseInput.manifest.vehicle_profiles[0],
          keywords: ["caja seca", "dry van"]
        }
      ]
    };

    const result = resolveProfile({
      requester_email: "compras@cliente.com",
      client_id: "cliente-demo",
      business_unit_id: "general",
      vehicle_profile_id: "caja seca 53 pies",
      manifest
    });

    expect(result.status).toBe("resolved");
    expect(result.profile?.vehicle_profile_id).toBe("T3S2_53_DRYVAN");
  });
});

describe("resolveLanesFromText", () => {
  const keywordManifest: QuoteManifest = {
    client_id: "cliente-demo",
    business_units: [
      {
        business_unit_id: "cajas",
        requester_email_domains: ["cliente.com"],
        keywords: ["caja seca"],
        default: true
      },
      {
        business_unit_id: "plataformas",
        requester_email_domains: [],
        keywords: ["plataforma"]
      }
    ],
    vehicle_profiles: [
      {
        ...baseInput.manifest.vehicle_profiles[0],
        vehicle_profile_id: "PLAT_SENCILLO",
        business_unit_id: "plataformas",
        keywords: ["sencillo"]
      },
      {
        ...baseInput.manifest.vehicle_profiles[0],
        vehicle_profile_id: "PLAT_FULL",
        business_unit_id: "plataformas",
        keywords: ["full"]
      },
      {
        ...baseInput.manifest.vehicle_profiles[0],
        vehicle_profile_id: "CAJA_53",
        business_unit_id: "cajas",
        keywords: ["53"]
      }
    ],
    route_policy: { sakbe_required: true }
  };

  it("maps business unit and both unit types from free text keywords", () => {
    const resolution = resolveLanesFromText({
      text: "Cotizame en full y sencillo un Monterrey - Mexico en plataformas",
      requester_email: "compras@cliente.com",
      manifest: keywordManifest
    });

    expect(resolution.business_unit_id).toBe("plataformas");
    expect(resolution.vehicle_profile_ids.sort()).toEqual(["PLAT_FULL", "PLAT_SENCILLO"]);
  });

  it("falls back to email domain when no business-unit keyword matches", () => {
    const resolution = resolveLanesFromText({
      text: "Cotizame un Monterrey - Saltillo en 53",
      requester_email: "compras@cliente.com",
      manifest: keywordManifest
    });

    expect(resolution.business_unit_id).toBe("cajas");
    expect(resolution.vehicle_profile_ids).toEqual(["CAJA_53"]);
  });

  it("matches keywords ignoring accents and case", () => {
    const resolution = resolveLanesFromText({
      text: "COTÍZAME EN PLATAFORMA SENCÍLLO",
      manifest: keywordManifest
    });

    expect(resolution.business_unit_id).toBe("plataformas");
    expect(resolution.vehicle_profile_ids).toEqual(["PLAT_SENCILLO"]);
  });
});

describe("planRfqBatch", () => {
  it("keeps a single-lane RFQ as one child with stable identity", () => {
    const batch = planRfqBatch({
      rfq_id: "RFQ-2026-000001",
      lanes: [baseInput.rfq]
    });

    expect(batch.parent_rfq_id).toBe("RFQ-2026-000001");
    expect(batch.children).toHaveLength(1);
    expect(batch.children[0].child_rfq_id).toBe("RFQ-2026-000001-L01");
  });
});
