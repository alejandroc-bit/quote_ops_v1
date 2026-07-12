import { describe, expect, it } from "vitest";
import { runQuoteWorkflow } from "@quoteops/agent";
import {
  createNmxWorkflowInput,
  nmxSakbeRoute,
  nmxManifest
} from "../fixtures/nmx/clientPack";

describe("NMX client emulation", () => {
  it("quotes NMX using live SAKBE evidence and profitability pricing", async () => {
    const result = await runQuoteWorkflow(createNmxWorkflowInput());

    expect(result.client_id).toBe("NMX");
    expect(result.route_evidence).toMatchObject({
      source: "sakbe",
      status: "resolved",
      km_loaded: nmxSakbeRoute.km_loaded,
      tolls_mxn: nmxSakbeRoute.tolls_mxn
    });
    expect(result.base_quote?.status).toBe("APPROVED");
    expect(result.base_quote?.pricing_model).toBe("profitability");
    expect(result.base_quote?.profile.profile_id).toBe(
      "NMX:DV_53_FT:T3S3_53_DRYVAN"
    );
    expect(result.base_quote?.rb_pct).toBe(0.57);
    expect(result.base_quote?.base_rate_mxn).toBe(36574.12);
    expect(result.approval_state?.required).toBe(false);
    expect(result.writeback_result?.status).toBe("queued");
  });

  it("fails closed when live SAKBE route resolution is unavailable", async () => {
    const result = await runQuoteWorkflow(
      createNmxWorkflowInput({
        resolveRoute: async () => {
          throw new Error("SAKBE API unavailable");
        }
      })
    );

    expect(result.route_evidence).toMatchObject({
      source: "sakbe",
      status: "failed",
      km_loaded: null,
      tolls_mxn: null
    });
    expect(result.base_quote?.status).toBe("REVIEW_REQUIRED");
    expect(result.approval_state?.required).toBe(true);
    expect(result.approval_state?.reasons).toContain("route_provider_unavailable");
    expect(result.approval_state?.reasons).toContain("route_evidence_missing");
    expect(result.writeback_result).toBeNull();
  });

  it("requires review when an NMX RFQ is missing weight", async () => {
    const input = createNmxWorkflowInput({
      searchHistorical: async () => ({
        selected_layer: "unavailable",
        insufficient_data: [{ layer: "weight_band", reason: "weight_kg_missing" }]
      })
    });
    input.raw_rfq.parsed.lanes[0].cargo.weight_kg = null;

    const result = await runQuoteWorkflow(input);

    expect(result.base_quote?.status).toBe("APPROVED");
    expect(result.approval_state?.required).toBe(true);
    expect(result.approval_state?.reasons).toContain("historical_context_insufficient");
    expect(result.writeback_result).toBeNull();
  });

  it("keeps NMX manifest aligned to the V1 Supabase operating profile", () => {
    const profile = nmxManifest.vehicle_profiles[0];

    expect(profile.vehicle_profile_id).toBe("T3S3_53_DRYVAN");
    expect(profile.business_unit_id).toBe("DV_53_FT");
    expect(profile.pricing_model).toBe("profitability");
    expect(profile.diesel_price_mxn_per_liter).toBe(29);
    expect(profile.fuel_loaded_km_per_l).toBe(2.8);
    expect(profile.operator_cost_per_km_mxn).toBe(2.75);
    expect(profile.maintenance_per_km_mxn).toBe(3.6);
    expect(profile.tires_per_km_mxn).toBe(2.01);
    expect(profile.profitability_rb_table).toContainEqual({ max_km: 1000, rb_pct: 0.57 });
  });
});
