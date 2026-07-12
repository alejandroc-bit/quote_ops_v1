import { describe, expect, it } from "vitest";
import {
  approvalSchema,
  historicalAnalysisSchema,
  recommendationSchema,
  rfqSchema,
  type TmsConnector
} from "../src/index";

const validRfq = {
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
        vehicle_profile_id: null,
        cargo: {
          commodity: null,
          commodity_category: null,
          sector: null,
          weight_kg: 12000,
          value_mxn: null,
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
          customer_id: null,
          customer_type: null,
          business_unit_id: null
        },
        confidence: {
          overall: 0.82,
          missing_fields: ["commodity_category", "customer_type"],
          review_reasons: []
        }
      }
    ]
  }
};

describe("RFQ contract", () => {
  it("accepts a valid RFQ with one lane", () => {
    expect(rfqSchema.parse(validRfq)).toEqual(validRfq);
  });

  it("rejects unknown RFQ keys at the contract boundary", () => {
    const rfq = { ...validRfq, unexpected: true };

    expect(() => rfqSchema.parse(rfq)).toThrow();
  });

  it("rejects an RFQ lane without origin", () => {
    const rfq = structuredClone(validRfq);
    delete (rfq.parsed.lanes[0] as Partial<(typeof validRfq.parsed.lanes)[number]>).origin;

    expect(() => rfqSchema.parse(rfq)).toThrow();
  });

  it("rejects an RFQ lane without destination", () => {
    const rfq = structuredClone(validRfq);
    delete (rfq.parsed.lanes[0] as Partial<(typeof validRfq.parsed.lanes)[number]>)
      .destination;

    expect(() => rfqSchema.parse(rfq)).toThrow();
  });
});

describe("TMS contract", () => {
  it("accepts a valid historical record with layers", () => {
    const historicalAnalysis = {
      request_id: "RFQ-2026-000001-L01",
      search_layers: [
        "route_unit_cost",
        "customer_type",
        "commodity_category",
        "sector",
        "weight_band",
        "service_type"
      ],
      time_window: {
        from: "2025-06-16",
        to: "2026-06-16"
      },
      comparables: [
        {
          layer: "route_unit_cost",
          match_quality: "exact_route_exact_unit",
          count: 12,
          min_rate_mxn: 16500,
          p25_rate_mxn: 17400,
          median_rate_mxn: 18200,
          p75_rate_mxn: 19300,
          max_rate_mxn: 21000,
          avg_direct_cost_mxn: 13250,
          avg_margin_pct: 0.24
        },
        {
          layer: "commodity_category",
          match_quality: "same_category_same_unit_near_route",
          count: 7,
          commodity_category: "industrial",
          sector: "manufactura",
          weight_band: "10t_15t",
          min_rate_mxn: 17800,
          median_rate_mxn: 19000,
          max_rate_mxn: 22600
        }
      ],
      insufficient_data: [
        {
          layer: "customer_type",
          reason: "customer_type_missing_in_rfq"
        }
      ]
    };

    expect(historicalAnalysisSchema.parse(historicalAnalysis)).toEqual(historicalAnalysis);
  });

  it("rejects invalid calendar dates and reversed time windows", () => {
    const invalidDate = {
      request_id: "RFQ-2026-000001-L01",
      search_layers: ["route_unit_cost"],
      time_window: { from: "2026-99-99", to: "2026-06-16" },
      comparables: [],
      insufficient_data: []
    };
    const reversedWindow = {
      ...invalidDate,
      time_window: { from: "2026-06-17", to: "2026-06-16" }
    };

    expect(() => historicalAnalysisSchema.parse(invalidDate)).toThrow();
    expect(() => historicalAnalysisSchema.parse(reversedWindow)).toThrow();
  });

  it("defines the required connector functions", () => {
    const connector: TmsConnector = {
      readRfqs: async () => [],
      readCustomers: async () => [],
      readHistoricalQuotes: async () => [],
      readShipments: async () => [],
      readUnitPositions: async () => [],
      readAgreements: async () => [],
      writeQuote: async () => ({ quote_id: "QUOTE-1", status: "written" }),
      writeStatus: async () => ({ entity_id: "RFQ-1", status: "updated" }),
      healthCheck: async () => ({ ok: true })
    };

    expect(Object.keys(connector).sort()).toEqual([
      "healthCheck",
      "readAgreements",
      "readCustomers",
      "readHistoricalQuotes",
      "readRfqs",
      "readShipments",
      "readUnitPositions",
      "writeQuote",
      "writeStatus"
    ]);
  });
});

describe("recommendation contract", () => {
  it("accepts a valid recommendation with base and recommended rate", () => {
    const recommendation = {
      recommendation_id: "REC-2026-000001-L01",
      base_rate_mxn: 18450,
      recommended_rate_mxn: 19000,
      adjustment: {
        direction: "raise",
        amount_mxn: 550,
        percent: 0.0298,
        reason:
          "El historico para carga industrial de 10t a 15t en unidad compatible esta por encima de la tarifa base."
      },
      historical_bounds: {
        selected_layer: "commodity_category",
        min_rate_mxn: 17800,
        median_rate_mxn: 19000,
        max_rate_mxn: 22600
      },
      criteria_used: [
        "criterion.margin.floor.general",
        "criterion.customer_type.industrial.priority"
      ],
      approval: {
        required: false,
        level: "auto",
        reasons: []
      }
    };

    expect(recommendationSchema.parse(recommendation)).toEqual(recommendation);
  });

  it("rejects recommendations with contradictory direction and rate relationships", () => {
    const invalidRecommendation = {
      recommendation_id: "REC-2026-000001-L01",
      base_rate_mxn: 19000,
      recommended_rate_mxn: 18450,
      adjustment: {
        direction: "raise",
        amount_mxn: 550,
        percent: 0.0298,
        reason: "Contradictory rate direction."
      },
      historical_bounds: {
        selected_layer: "commodity_category",
        min_rate_mxn: 17800,
        median_rate_mxn: 19000,
        max_rate_mxn: 22600
      },
      criteria_used: ["criterion.margin.floor.general"],
      approval: {
        required: false,
        level: "auto",
        reasons: []
      }
    };

    expect(() => recommendationSchema.parse(invalidRecommendation)).toThrow();
  });

  it("rejects recommendations with invalid historical bound ordering", () => {
    const invalidRecommendation = {
      recommendation_id: "REC-2026-000001-L01",
      base_rate_mxn: 18450,
      recommended_rate_mxn: 19000,
      adjustment: {
        direction: "raise",
        amount_mxn: 550,
        percent: 0.0298,
        reason: "Invalid bounds."
      },
      historical_bounds: {
        selected_layer: "commodity_category",
        min_rate_mxn: 22600,
        median_rate_mxn: 19000,
        max_rate_mxn: 17800
      },
      criteria_used: ["criterion.margin.floor.general"],
      approval: {
        required: false,
        level: "auto",
        reasons: []
      }
    };

    expect(() => recommendationSchema.parse(invalidRecommendation)).toThrow();
  });
});

describe("approval contract", () => {
  it("accepts a valid approval with status pending", () => {
    const approval = {
      approval_id: "APR-2026-000001-L01",
      status: "pending",
      required_role: "pricing_manager",
      reason_codes: ["margin_below_target"],
      options: [
        { action: "approve", rate_mxn: 19000 },
        { action: "adjust", min_rate_mxn: 18450, max_rate_mxn: 22600 },
        { action: "reject", requires_reason: true }
      ],
      audit: {
        base_quote_version: "quote-v2-2026-000001-L01",
        criteria_version: "criteria-2026.06.16.1",
        connector_version: "cliente-demo.tms.primary@1.0.0"
      }
    };

    expect(approvalSchema.parse(approval)).toEqual(approval);
  });

  it("rejects action options that do not match their action contract", () => {
    const invalidApproval = {
      approval_id: "APR-2026-000001-L01",
      status: "pending",
      required_role: "pricing_manager",
      reason_codes: ["margin_below_target"],
      options: [
        { action: "approve" },
        { action: "adjust", min_rate_mxn: 18450 },
        { action: "reject", rate_mxn: 19000, requires_reason: true }
      ],
      audit: {
        base_quote_version: "quote-v2-2026-000001-L01",
        criteria_version: "criteria-2026.06.16.1",
        connector_version: "cliente-demo.tms.primary@1.0.0"
      }
    };

    expect(() => approvalSchema.parse(invalidApproval)).toThrow();
  });
});
