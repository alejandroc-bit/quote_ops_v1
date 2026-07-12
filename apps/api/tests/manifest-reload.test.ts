import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadApplianceManifest } from "../src/index";

describe("loadApplianceManifest", () => {
  it("re-reads the manifest after the file changes (add unit without restart)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "manifest-reload-"));
    const path = join(dir, "client-manifest.yaml");

    await writeFile(
      path,
      [
        "client_id: DEMO",
        "business_units:",
        "  - business_unit_id: flota",
        "    default: true",
        "vehicle_profiles:",
        "  - vehicle_profile_id: PLAT_FULL",
        "    business_unit_id: flota",
        "    payload_capacity_kg: 30000",
        "    fuel_loaded_km_per_l: 2.5",
        "    fuel_empty_km_per_l: 3",
        "    operator_cost_per_km_mxn: 2.8",
        "    pricing_model: profitability",
        "    diesel_price_mxn_per_liter: 24",
        "    margin_target_pct: 0.2",
        "    minimum_margin_pct: 0.14",
        "route_policy:",
        "  sakbe_required: true"
      ].join("\n")
    );

    const first = await loadApplianceManifest(path);
    expect(first?.vehicle_profiles).toHaveLength(1);

    // onboarding CLI adds a second unit; mtime must advance for the reload
    await new Promise((resolve) => setTimeout(resolve, 12));
    await writeFile(
      path,
      [
        "client_id: DEMO",
        "business_units:",
        "  - business_unit_id: flota",
        "    default: true",
        "vehicle_profiles:",
        "  - vehicle_profile_id: PLAT_FULL",
        "    business_unit_id: flota",
        "    payload_capacity_kg: 30000",
        "    fuel_loaded_km_per_l: 2.5",
        "    fuel_empty_km_per_l: 3",
        "    operator_cost_per_km_mxn: 2.8",
        "    pricing_model: profitability",
        "    diesel_price_mxn_per_liter: 24",
        "    margin_target_pct: 0.2",
        "    minimum_margin_pct: 0.14",
        "  - vehicle_profile_id: PLAT_SENCILLO",
        "    business_unit_id: flota",
        "    payload_capacity_kg: 17000",
        "    fuel_loaded_km_per_l: 3.4",
        "    fuel_empty_km_per_l: 3.9",
        "    operator_cost_per_km_mxn: 2.4",
        "    pricing_model: formula",
        "    diesel_price_mxn_per_liter: 24",
        "    margin_target_pct: 0.2",
        "    minimum_margin_pct: 0.14",
        "route_policy:",
        "  sakbe_required: true"
      ].join("\n")
    );

    const second = await loadApplianceManifest(path);
    expect(second?.vehicle_profiles).toHaveLength(2);
  });
});
