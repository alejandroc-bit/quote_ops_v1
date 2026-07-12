import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runQuoteWorkflow, type QuoteWorkflowInput } from "@quoteops/agent";
import type { Rfq } from "@quoteops/contracts";

const fixtureDir = new URL("./rfqs", import.meta.url);

describe("Quote System V2 regression harness", () => {
  it("covers base RFQ variants from sanitized fixtures", async () => {
    const simple = await loadFixture("simple-route.json");
    const commodity = await loadFixture("commodity-weight-specific.json");
    const multiRoute = await loadFixture("multi-route.json");
    const multiUnit = await loadFixture("multi-unit.json");
    const genericNoCommodity = mutateLane(simple, {
      commodity: null,
      commodity_category: null,
      sector: null,
      weight_kg: null
    });
    const targetRate = mutateCommercial(simple, { target_rate_mxn: 12500 });

    const cases = [
      genericNoCommodity,
      simple,
      commodity,
      mutateLane(commodity, { weight_kg: 18000 }),
      mutateLane(commodity, { sector: "automotriz" }),
      targetRate,
      multiRoute,
      multiUnit
    ];

    const results = await Promise.all(cases.map((rfq, index) => runQuoteWorkflow(baseInput(rfq, `RUN-BASE-${index}`))));

    expect(results).toHaveLength(8);
    expect(results.every((result) => result.base_quote?.base_rate_mxn !== undefined)).toBe(true);
    expect(results[6].batch_queue).toHaveLength(2);
    expect(results[7].batch_queue).toHaveLength(2);
  });

  it("keeps deterministic quote-core output when TMS historical lookup fails", async () => {
    const result = await runQuoteWorkflow(
      baseInput(await loadFixture("simple-route.json"), "RUN-TMS-FAIL", {
        searchHistorical: async () => {
          throw new Error("TMS unavailable");
        }
      })
    );

    expect(result.base_quote?.base_rate_mxn).toBeGreaterThan(0);
    expect(result.approval_state?.required).toBe(true);
    expect(result.approval_state?.reasons).toContain("tms_historical_unavailable");
  });

  it("marks review when SAKBE does not respond", async () => {
    const result = await runQuoteWorkflow(
      baseInput(await loadFixture("simple-route.json"), "RUN-SAKBE-FAIL", {
        resolveRoute: async () => {
          throw new Error("SAKBE timeout");
        }
      })
    );

    expect(result.base_quote?.status).toBe("REVIEW_REQUIRED");
    expect(result.approval_state?.reasons).toContain("route_provider_unavailable");
  });

  it("requires review when no operating profile is available", async () => {
    const rfq = await loadFixture("simple-route.json");
    rfq.parsed.lanes[0].vehicle_profile_id = "UNKNOWN";

    const result = await runQuoteWorkflow(baseInput(rfq, "RUN-NO-PROFILE"));

    expect(result.approval_state?.required).toBe(true);
    expect(result.approval_state?.reasons).toContain("operating_profile_missing");
  });

  it("requires review when historical context is insufficient", async () => {
    const result = await runQuoteWorkflow(
      baseInput(await loadFixture("simple-route.json"), "RUN-NO-HISTORY", {
        searchHistorical: async () => ({
          selected_layer: "route_unit_cost",
          insufficient_data: [{ layer: "route_unit_cost", reason: "not_enough_comparables" }]
        })
      })
    );

    expect(result.approval_state?.required).toBe(true);
    expect(result.approval_state?.reasons).toContain("historical_context_insufficient");
  });

  it("keeps quote-core output when AI recommendation fails", async () => {
    const result = await runQuoteWorkflow(
      baseInput(await loadFixture("simple-route.json"), "RUN-AI-FAIL", {
        recommend: async () => {
          throw new Error("model unavailable");
        }
      })
    );

    expect(result.base_quote?.base_rate_mxn).toBeGreaterThan(0);
    expect(result.approval_state?.reasons).toContain("ai_recommendation_failed");
  });

  it("keeps approved local quote when writeback fails", async () => {
    const result = await runQuoteWorkflow(
      baseInput(await loadFixture("simple-route.json"), "RUN-WRITEBACK-FAIL", {
        writeback: async () => {
          throw new Error("TMS writeback failed");
        }
      })
    );

    expect(result.base_quote?.status).toBe("APPROVED");
    expect(result.writeback_result?.status).toBe("failed");
    expect(result.node_status.writeback).toBe("failed");
  });
});

async function loadFixture(name: string): Promise<Rfq> {
  return JSON.parse(await readFile(join(fixtureDir.pathname, name), "utf8")) as Rfq;
}

function mutateLane(rfq: Rfq, cargo: Partial<Rfq["parsed"]["lanes"][number]["cargo"]>): Rfq {
  const next = structuredClone(rfq);
  next.parsed.lanes[0].cargo = { ...next.parsed.lanes[0].cargo, ...cargo };
  return next;
}

function mutateCommercial(
  rfq: Rfq,
  commercial: Partial<Rfq["parsed"]["lanes"][number]["commercial"]>
): Rfq {
  const next = structuredClone(rfq);
  next.parsed.lanes[0].commercial = { ...next.parsed.lanes[0].commercial, ...commercial };
  return next;
}

function baseInput(
  rfq: Rfq,
  runId: string,
  toolOverrides: Partial<QuoteWorkflowInput["tools"]> = {}
): QuoteWorkflowInput {
  return {
    run_id: runId,
    client_id: "cliente-demo",
    manifest_version: "manifest-2026.06.16.1",
    criteria_version: "criteria-2026.06.16.1",
    connector_versions: {
      tms: "cliente-demo.tms.primary@1.0.0",
      route_provider: "sakbe@1.0.0"
    },
    raw_rfq: rfq,
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
        vehicleProfile("T3S2_53_DRYVAN", "formula"),
        vehicleProfile("T3S2_53_FLATBED", "formula")
      ],
      route_policy: { sakbe_required: true }
    },
    criteria_nodes: [],
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
      recommend: async ({ base_rate_mxn }) => ({
        recommended_rate_mxn: base_rate_mxn,
        reason: "Regression harness preserves quote-core base rate."
      }),
      writeback: async () => ({ status: "written", quote_id: "QUOTE-REGRESSION" }),
      ...toolOverrides
    }
  };
}

function vehicleProfile(
  vehicle_profile_id: string,
  pricing_model: "formula" | "profitability"
): QuoteWorkflowInput["manifest"]["vehicle_profiles"][number] {
  return {
    vehicle_profile_id,
    business_unit_id: "general",
    payload_capacity_kg: vehicle_profile_id.includes("FLATBED") ? 26000 : 24000,
    fuel_loaded_km_per_l: vehicle_profile_id.includes("FLATBED") ? 2.7 : 3,
    fuel_empty_km_per_l: vehicle_profile_id.includes("FLATBED") ? 3.1 : 3.4,
    operator_cost_per_km_mxn: vehicle_profile_id.includes("FLATBED") ? 2.75 : 2.5,
    pricing_model,
    diesel_price_mxn_per_liter: 24,
    margin_target_pct: 0.25,
    minimum_margin_pct: 0.18,
    maintenance_per_km_mxn: 2,
    tires_per_km_mxn: 1.25,
    fixed_overhead_per_km_mxn: 1,
    depreciation_per_km_mxn: 1.5,
    insurance_rate: 0.002,
    insurance_min_mxn: 500
  };
}

