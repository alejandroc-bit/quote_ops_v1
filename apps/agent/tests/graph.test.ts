import { describe, expect, it } from "vitest";
import { runQuoteWorkflow, type QuoteWorkflowInput } from "../src/index";

const input: QuoteWorkflowInput = {
  run_id: "RUN-001",
  client_id: "cliente-demo",
  manifest_version: "manifest-2026.06.16.1",
  criteria_version: "criteria-2026.06.16.1",
  connector_versions: {
    tms: "cliente-demo.tms.primary@1.0.0",
    route_provider: "sakbe@1.0.0"
  },
  raw_rfq: {
    rfq_id: "RFQ-2026-000001",
    source: "email",
    received_at: "2026-06-16T15:00:00-06:00",
    requester: {
      name: "Compras Cliente",
      email: "compras@cliente.com",
      company_alias: "Cliente"
    },
    raw: {
      subject: "Cotizacion Monterrey a Saltillo",
      body: "Necesito caja seca 53 de Monterrey a Saltillo, 12 toneladas.",
      attachments: []
    },
    parsed: {
      lanes: [
        {
          lane_id: "RFQ-2026-000001-L01",
          origin: { city: "Monterrey", state: "Nuevo Leon", country: "MX" },
          destination: { city: "Saltillo", state: "Coahuila", country: "MX" },
          equipment_request: "caja seca 53",
          vehicle_profile_id: "T3S2_53_DRYVAN",
          cargo: {
            commodity: "autopartes",
            commodity_category: "industrial",
            sector: "manufactura",
            weight_kg: 12000,
            value_mxn: 250000,
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
            customer_id: "CUST-1",
            customer_type: "industrial",
            business_unit_id: "general"
          },
          confidence: {
            overall: 0.9,
            missing_fields: [],
            review_reasons: []
          }
        }
      ]
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
  criteria_nodes: [
    {
      id: "criterion.margin.floor.general",
      type: "pricing_criterion",
      title: "No bajar de costo protegido",
      body: "Conservar tarifa base si el historico presiona por debajo del costo.",
      priority: 100,
      phases: ["pricing_recommendation", "approval"],
      applies_when: {},
      source: {
        kind: "director_input",
        owner_role: "direccion_comercial",
        captured_at: "2026-06-16"
      }
    }
  ],
  tools: {
    resolveRoute: async () => ({
      status: "resolved",
      source: "sakbe",
      km_loaded: 80,
      estimated_minutes: 85,
      tolls_mxn: 600,
      requires_return_route: false
    }),
    searchHistorical: async () => ({
      selected_layer: "route_unit_cost",
      median_rate_mxn: 19000
    }),
    writeback: async () => ({ status: "written", quote_id: "QUOTE-1" }),
    recommend: async ({ base_rate_mxn }) => ({
      recommended_rate_mxn: base_rate_mxn,
      reason: "Conservar tarifa base calculada por quote-core."
    })
  }
};

describe("runQuoteWorkflow", () => {
  it("completes the graph for a simple RFQ", async () => {
    const result = await runQuoteWorkflow(input);

    expect(result.node_status.audit).toBe("completed");
    expect(result.batch_queue).toHaveLength(1);
    expect(result.base_quote?.status).toBe("APPROVED");
    expect(result.approval_state?.required).toBe(false);
    expect(result.writeback_result?.status).toBe("written");
    expect(result.audit_events.map((event) => event.node_id)).toContain("quoteCore");
  });

  it("marks non-success writeback statuses as failed", async () => {
    const unknownWriteback = cloneWorkflowInput(input);
    unknownWriteback.tools.writeback = async (payload) => {
      expect(payload.approval_state).toMatchObject({ required: false, reasons: [] });
      return { status: "accepted" };
    };

    const result = await runQuoteWorkflow(unknownWriteback);

    expect(result.writeback_result?.status).toBe("accepted");
    expect(result.node_status.writeback).toBe("failed");
  });

  it("quotes and writes back every lane of a multi-route RFQ", async () => {
    const multi = cloneWorkflowInput(input);
    const writebackCalls: string[] = [];
    multi.tools.writeback = async ({ quote }) => {
      writebackCalls.push(quote.quote_id);
      return { status: "written", quote_id: quote.quote_id };
    };
    multi.raw_rfq.parsed.lanes.push({
      ...multi.raw_rfq.parsed.lanes[0],
      lane_id: "RFQ-2026-000001-L02",
      destination: { city: "Puebla", state: "Puebla", country: "MX" }
    });

    const result = await runQuoteWorkflow(multi);

    expect(result.batch_queue.map((child) => child.child_rfq_id)).toEqual([
      "RFQ-2026-000001-L01",
      "RFQ-2026-000001-L02"
    ]);
    expect(result.child_results).toHaveLength(2);
    expect(result.child_results.every((child) => child.base_quote?.status === "APPROVED")).toBe(
      true
    );
    expect(result.child_results.every((child) => child.recommendation?.status === "completed")).toBe(
      true
    );
    expect(result.approval_state?.required).toBe(false);
    expect(result.writeback_results).toHaveLength(2);
    expect(writebackCalls).toHaveLength(2);
    expect(new Set(writebackCalls).size).toBe(2);
    expect(result.email_draft?.subject).toContain("2 cotizaciones");
    expect(result.email_draft?.body).toContain("RFQ-2026-000001-L01");
    expect(result.email_draft?.body).toContain("RFQ-2026-000001-L02");
  });

  it("stops in review when the profile is missing", async () => {
    const missingProfile = cloneWorkflowInput(input);
    missingProfile.raw_rfq.parsed.lanes[0].vehicle_profile_id = "UNKNOWN";

    const result = await runQuoteWorkflow(missingProfile);

    expect(result.base_quote?.status).toBe("REVIEW_REQUIRED");
    expect(result.approval_state?.required).toBe(true);
    expect(result.approval_state?.reasons).toContain("operating_profile_missing");
    expect(result.writeback_result).toBeNull();
  });

  it("stops in review when critical route evidence is missing", async () => {
    const missingRoute: QuoteWorkflowInput = {
      ...input,
      tools: {
        ...input.tools,
        resolveRoute: async () => ({
          status: "missing",
          source: "sakbe",
          km_loaded: null,
          estimated_minutes: null,
          tolls_mxn: null,
          requires_return_route: false
        })
      }
    };

    const result = await runQuoteWorkflow(missingRoute);

    expect(result.base_quote?.status).toBe("REVIEW_REQUIRED");
    expect(result.approval_state?.reasons).toContain("route_evidence_missing");
  });

  it("keeps quote-core output and marks review when the AI recommendation fails", async () => {
    const aiFailure: QuoteWorkflowInput = {
      ...input,
      tools: {
        ...input.tools,
        recommend: async () => {
          throw new Error("model unavailable");
        }
      }
    };

    const result = await runQuoteWorkflow(aiFailure);

    expect(result.base_quote?.base_rate_mxn).toBeGreaterThan(0);
    expect(result.recommendation?.status).toBe("failed");
    expect(result.approval_state?.required).toBe(true);
    expect(result.approval_state?.reasons).toContain("ai_recommendation_failed");
  });

  it("preserves quote-core recommended rate even when AI recommends a different rate", async () => {
    const aiRateChange = cloneWorkflowInput(input);
    let capturedQuoteCoreRate: number | null = null;

    aiRateChange.tools.recommend = async ({ base_rate_mxn }) => ({
      recommended_rate_mxn: (capturedQuoteCoreRate = base_rate_mxn) + 12345,
      reason: "AI attempted to change deterministic price."
    });

    const result = await runQuoteWorkflow(aiRateChange);
    const pricingEvent = result.audit_events.find(
      (event) => event.node_id === "pricingRecommendation" && event.event_type === "completed"
    );
    const modelSuggestedRate = pricingEvent?.payload.model_suggested_rate_mxn;

    expect(capturedQuoteCoreRate).toBeGreaterThan(0);
    const quoteCoreRate = capturedQuoteCoreRate as number;

    expect(result.base_quote?.base_rate_mxn).toBe(quoteCoreRate);
    expect(result.recommendation?.status).toBe("completed");
    expect(result.recommendation?.recommended_rate_mxn).toBe(quoteCoreRate);
    expect(result.recommendation?.reason).toContain("AI attempted to change deterministic price.");
    expect(pricingEvent?.payload).toMatchObject({
      recommended_rate_mxn: quoteCoreRate,
      model_suggested_rate_mxn: quoteCoreRate + 12345,
      policy: "quote_core_rate_preserved"
    });
    expect(result.base_quote?.base_rate_mxn).not.toBe(modelSuggestedRate);
    expect(result.recommendation?.recommended_rate_mxn).not.toBe(modelSuggestedRate);
  });

  it("feeds local knowledge hits into the criteria context passed to recommend", async () => {
    const withKnowledge = cloneWorkflowInput(input);
    let capturedQuery: string | null = null;
    let recommendCriteria: unknown = null;

    withKnowledge.tools.retrieveKnowledge = async (query, clientId) => {
      capturedQuery = query;
      expect(clientId).toBe("cliente-demo");
      return [{ chunk_id: "chunk-1", text: "Prioriza margen en manufactura." }];
    };
    withKnowledge.tools.recommend = async ({ base_rate_mxn, criteria_context }) => {
      recommendCriteria = criteria_context;
      return { recommended_rate_mxn: base_rate_mxn, reason: "ok" };
    };

    await runQuoteWorkflow(withKnowledge);

    // query is built from the lane so retrieval is scoped to this RFQ
    expect(capturedQuery).toContain("Monterrey");
    expect(recommendCriteria).toMatchObject({
      knowledge_hits: [{ chunk_id: "chunk-1", text: "Prioriza margen en manufactura." }]
    });
  });
});

function cloneWorkflowInput(source: QuoteWorkflowInput): QuoteWorkflowInput {
  return {
    ...source,
    connector_versions: { ...source.connector_versions },
    raw_rfq: structuredClone(source.raw_rfq),
    manifest: structuredClone(source.manifest),
    criteria_nodes: structuredClone(source.criteria_nodes),
    tools: { ...source.tools }
  };
}
