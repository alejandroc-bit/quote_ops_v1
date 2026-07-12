import type { Rfq } from "@quoteops/contracts";
import type { CriteriaNode } from "@quoteops/criteria";
import type { RouteEvidence } from "@quoteops/quote-core";
import type { QuoteWorkflowInput } from "@quoteops/agent";

export const nmxManifest = {
  client_id: "NMX",
  business_units: [
    {
      business_unit_id: "DV_53_FT",
      requester_email_domains: ["nuevomex.mx"],
      default: true
    }
  ],
  vehicle_profiles: [
    {
      vehicle_profile_id: "T3S3_53_DRYVAN",
      business_unit_id: "DV_53_FT",
      payload_capacity_kg: 29000,
      fuel_loaded_km_per_l: 2.8,
      fuel_empty_km_per_l: 3.2,
      operator_cost_per_km_mxn: 2.75,
      pricing_model: "profitability",
      diesel_price_mxn_per_liter: 29,
      margin_target_pct: 0.2,
      minimum_margin_pct: 0.12,
      maintenance_per_km_mxn: 3.6,
      tires_per_km_mxn: 2.01,
      fixed_overhead_per_km_mxn: 3.625,
      depreciation_per_km_mxn: 3.1792,
      insurance_rate: 0.003,
      insurance_min_mxn: 1200,
      profitability_rb_table: [
        { max_km: 100, rb_pct: 0.6 },
        { max_km: 500, rb_pct: 0.6 },
        { max_km: 1000, rb_pct: 0.57 },
        { max_km: 2000, rb_pct: 0.55 },
        { max_km: 3000, rb_pct: 0.52 },
        { max_km: null, rb_pct: 0.5 }
      ]
    }
  ],
  route_policy: {
    sakbe_required: true
  }
} satisfies QuoteWorkflowInput["manifest"];

export const nmxSakbeRoute: RouteEvidence & {
  cache_key: string;
  cached_at: string;
  expires_at: string;
} = {
  cache_key: "NMX:T3S3_53_DRYVAN:Monterrey-Nuevo Leon:Ciudad de Mexico-Ciudad de Mexico:cuota",
  cached_at: "2026-06-15T06:29:09.579Z",
  expires_at: "2026-06-22T01:00:00.000Z",
  status: "resolved",
  source: "sakbe",
  km_loaded: 905.45,
  estimated_minutes: 565.82,
  tolls_mxn: 3859,
  requires_return_route: false
};

export const nmxRfq: Rfq = {
  rfq_id: "RFQ-2026-000901",
  source: "email",
  received_at: "2026-06-19T16:30:00-06:00",
  requester: {
    name: "Compras NuevoMex",
    email: "compras@nuevomex.mx",
    company_alias: "Autolineas NuevoMex"
  },
  raw: {
    subject: "Cotizacion Monterrey a Ciudad de Mexico",
    body: "Necesito caja seca 53 de Monterrey a Ciudad de Mexico, 18 toneladas.",
    attachments: []
  },
  parsed: {
    lanes: [
      {
        lane_id: "RFQ-2026-000901-L01",
        origin: { city: "Monterrey", state: "Nuevo Leon", country: "MX" },
        destination: { city: "Ciudad de Mexico", state: "Ciudad de Mexico", country: "MX" },
        equipment_request: "caja seca 53",
        vehicle_profile_id: "T3S3_53_DRYVAN",
        cargo: {
          commodity: "carga general",
          commodity_category: "general",
          sector: "industrial",
          weight_kg: 18000,
          value_mxn: 400000,
          hazmat: false,
          temperature_controlled: false
        },
        service: {
          return_policy: "sin_retorno",
          route_policy: "cuota",
          requested_pickup_at: null
        },
        commercial: {
          target_rate_mxn: null,
          customer_id: "NMX-CUST-DEMO",
          customer_type: "industrial",
          business_unit_id: "DV_53_FT"
        },
        confidence: {
          overall: 0.92,
          missing_fields: [],
          review_reasons: []
        }
      }
    ]
  }
};

export const nmxCriteriaNodes: CriteriaNode[] = [
  {
    id: "nmx.pricing.profitability.rb",
    type: "pricing_criterion",
    title: "NMX uses RB profitability pricing",
    body: "For NMX dry van lanes, quote-core uses the configured RB table; historical data is advisory and does not override deterministic profitability pricing.",
    priority: 100,
    phases: ["pricing_recommendation", "approval"],
    applies_when: {
      client_id: ["NMX"],
      vehicle_profile_id: ["T3S3_53_DRYVAN"]
    },
    source: {
      kind: "supabase_snapshot",
      owner_role: "pricing_ops",
      captured_at: "2026-06-19"
    }
  },
  {
    id: "nmx.route.sakbe.required",
    type: "operational_risk_criterion",
    title: "SAKBE route evidence required",
    body: "NMX emulation treats live SAKBE evidence as valid route evidence only when it contains km, minutes and tolls.",
    priority: 90,
    phases: ["approval"],
    applies_when: {
      client_id: ["NMX"]
    },
    source: {
      kind: "route_cache",
      owner_role: "ops",
      captured_at: "2026-06-19"
    }
  }
];

export function createNmxWorkflowInput(
  overrides: Partial<QuoteWorkflowInput["tools"]> = {}
): QuoteWorkflowInput {
  return {
    run_id: "RUN-NMX-001",
    client_id: "NMX",
    manifest_version: "nmx-supabase-snapshot-2026.06.15.5",
    criteria_version: "nmx-criteria-2026.06.19.1",
    connector_versions: {
      tms: "nmx.supabase-tms-fixture@2026.06.19",
      route_provider: "sakbe-live@2026.06.22"
    },
    raw_rfq: structuredClone(nmxRfq),
    manifest: structuredClone(nmxManifest),
    criteria_nodes: structuredClone(nmxCriteriaNodes),
    tools: {
      resolveRoute: async () => ({ ...nmxSakbeRoute }),
      searchHistorical: async () => ({
        selected_layer: "route_unit_cost",
        median_rate_mxn: 36574.12,
        max_rate_mxn: 51269.8,
        source: "supabase_quote_workflow_fixture"
      }),
      recommend: async ({ base_rate_mxn }) => ({
        recommended_rate_mxn: base_rate_mxn,
        reason: "NMX fixture preserves quote-core RB profitability rate."
      }),
      writeback: async ({ quote }) => ({
        status: "queued",
        quote_id: quote.quote_id,
        target: "tms_quote_writebacks_fixture"
      }),
      ...overrides
    }
  };
}
