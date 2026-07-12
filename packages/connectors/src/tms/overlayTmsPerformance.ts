import type { QuoteManifest, QuoteVehicleProfile } from "@quoteops/quote-core";
import type { TmsCanonicalPerformance } from "@quoteops/contracts";

export interface OverlayResult {
  manifest: QuoteManifest;
  /** Profile ids whose yield was refreshed from the TMS. */
  applied: string[];
  /** Profiles declaring performance_source: tms with no matching TMS row. */
  stale: string[];
}

/**
 * Overlays TMS-sourced fuel yield onto the manifest's vehicle profiles so
 * rendimientos are never frozen in config. Only profiles that opt in with
 * `performance_source: tms` are touched; a profile with no matching TMS row
 * (matched by `performance.unit_type === vehicle_profile_id`) keeps its manifest
 * values and is reported as stale so the caller can flag review. kpl_yield
 * overwrites both loaded and empty km/l (the TMS reports one real figure — we
 * do not invent a loaded/empty split); real_cost_per_km is attached as context,
 * never silently substituted into the formula components.
 */
export function overlayTmsPerformance(
  manifest: QuoteManifest,
  performance: TmsCanonicalPerformance[]
): OverlayResult {
  const byUnitType = new Map(performance.map((row) => [normalize(row.unit_type), row]));
  const applied: string[] = [];
  const stale: string[] = [];

  const vehicle_profiles = manifest.vehicle_profiles.map((profile): QuoteVehicleProfile => {
    if (profile.performance_source !== "tms") {
      return profile;
    }
    const match = byUnitType.get(normalize(profile.vehicle_profile_id));
    if (!match) {
      stale.push(profile.vehicle_profile_id);
      return profile;
    }
    applied.push(profile.vehicle_profile_id);
    return {
      ...profile,
      fuel_loaded_km_per_l: match.kpl_yield,
      fuel_empty_km_per_l: match.kpl_yield,
      tms_real_cost_per_km: match.real_cost_per_km
    };
  });

  return { manifest: { ...manifest, vehicle_profiles }, applied, stale };
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
