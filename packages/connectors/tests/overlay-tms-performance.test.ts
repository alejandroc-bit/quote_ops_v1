import { describe, expect, it } from "vitest";
import type { QuoteManifest } from "@quoteops/quote-core";
import { overlayTmsPerformance } from "../src/index";

const baseProfile = {
  business_unit_id: "flota",
  payload_capacity_kg: 30000,
  fuel_loaded_km_per_l: 2.5,
  fuel_empty_km_per_l: 3.0,
  operator_cost_per_km_mxn: 2.8,
  pricing_model: "profitability" as const,
  diesel_price_mxn_per_liter: 24,
  margin_target_pct: 0.2,
  minimum_margin_pct: 0.14
};

function manifestWith(profiles: QuoteManifest["vehicle_profiles"]): QuoteManifest {
  return {
    client_id: "DEMO",
    business_units: [{ business_unit_id: "flota", default: true }],
    vehicle_profiles: profiles,
    route_policy: { sakbe_required: true }
  };
}

describe("overlayTmsPerformance", () => {
  it("overwrites both fuel yields from the TMS and attaches real cost", () => {
    const manifest = manifestWith([
      { ...baseProfile, vehicle_profile_id: "PLAT_FULL", performance_source: "tms" }
    ]);
    const result = overlayTmsPerformance(manifest, [
      { unit_type: "PLAT_FULL", kpl_yield: 3.1, real_cost_per_km: 15.2 }
    ]);

    const profile = result.manifest.vehicle_profiles[0]!;
    expect(profile.fuel_loaded_km_per_l).toBe(3.1);
    expect(profile.fuel_empty_km_per_l).toBe(3.1);
    expect(profile.tms_real_cost_per_km).toBe(15.2);
    expect(result.applied).toEqual(["PLAT_FULL"]);
    expect(result.stale).toEqual([]);
  });

  it("leaves manifest profiles untouched when they don't opt in", () => {
    const manifest = manifestWith([{ ...baseProfile, vehicle_profile_id: "CAJA_53" }]);
    const result = overlayTmsPerformance(manifest, [
      { unit_type: "CAJA_53", kpl_yield: 9.9, real_cost_per_km: 1 }
    ]);

    expect(result.manifest.vehicle_profiles[0]!.fuel_loaded_km_per_l).toBe(2.5);
    expect(result.applied).toEqual([]);
    expect(result.stale).toEqual([]);
  });

  it("reports a tms-sourced profile as stale when the TMS has no matching row", () => {
    const manifest = manifestWith([
      { ...baseProfile, vehicle_profile_id: "PLAT_FULL", performance_source: "tms" }
    ]);
    const result = overlayTmsPerformance(manifest, [
      { unit_type: "OTRO", kpl_yield: 3.1, real_cost_per_km: 15 }
    ]);

    expect(result.manifest.vehicle_profiles[0]!.fuel_loaded_km_per_l).toBe(2.5);
    expect(result.applied).toEqual([]);
    expect(result.stale).toEqual(["PLAT_FULL"]);
  });
});
