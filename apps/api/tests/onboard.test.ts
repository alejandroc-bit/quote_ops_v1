import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { QuoteManifest } from "@quoteops/quote-core";
import type { TmsCanonicalPerformance } from "@quoteops/contracts";
import { renderBanner } from "../src/onboard/tronUi.js";
import {
  buildProfileStub,
  buildTmsAdapterYaml,
  createCopilot,
  mergeProfileStubs,
  upsertEnvLine
} from "../src/onboard/onboardConfig.js";

describe("onboard TUI", () => {
  it("renders the INDUCTA banner", () => {
    const banner = renderBanner();
    expect(banner).toContain("Q U O T E");
    // ansi reset code present => it is styled
    expect(banner).toContain("\u001b[0m");
  });
});

describe("secret env upsert", () => {
  it("escapes shell-active chars and replaces existing keys", () => {
    let body = "";
    body = upsertEnvLine(body, "OPENROUTER_API_KEY", "sk-old");
    body = upsertEnvLine(body, "MAILBOX_USER", "ops@nmx.example");
    body = upsertEnvLine(body, "OPENROUTER_API_KEY", 'sk-"new"$`x\\');

    expect(body).toContain('MAILBOX_USER="ops@nmx.example"');
    // only one line for the replaced key
    expect(body.match(/OPENROUTER_API_KEY=/g)).toHaveLength(1);
    expect(body).toContain('OPENROUTER_API_KEY="sk-\\"new\\"\\$\\`x\\\\"');
  });

  it("rejects invalid keys and newline values", () => {
    expect(() => upsertEnvLine("", "bad-key", "x")).toThrow(/invalid secret key/);
    expect(() => upsertEnvLine("", "GOOD_KEY", "a\nb")).toThrow(/newlines/);
  });
});

describe("tms adapter yaml", () => {
  it("builds file_import with canonical env paths", () => {
    const config = parseYaml(buildTmsAdapterYaml({ provider: "file_import" }));
    expect(config.provider).toBe("file_import");
    expect(config.performance_path_env).toBe("QUOTEOPS_TMS_PERFORMANCE_PATH");
  });

  it("builds http with endpoint paths", () => {
    const config = parseYaml(
      buildTmsAdapterYaml({
        provider: "http",
        base_url_env: "TMS_HTTP_BASE_URL",
        endpoints: { get_units_endpoint_path: "/units" }
      })
    );
    expect(config).toMatchObject({
      provider: "http",
      base_url_env: "TMS_HTTP_BASE_URL",
      get_units_endpoint_path: "/units"
    });
  });

  it("builds sql with dialect, queries and optional write", () => {
    const config = parseYaml(
      buildTmsAdapterYaml({
        provider: "sql",
        dialect: "postgres",
        connection_url_env: "TMS_SQL_URL",
        queries: { performance: "SELECT tipo AS unit_type FROM rendimientos" },
        write_quote: "INSERT INTO outbox VALUES (:quote_id)"
      })
    );
    expect(config).toMatchObject({
      provider: "sql",
      dialect: "postgres",
      connection_url_env: "TMS_SQL_URL",
      queries: { performance: "SELECT tipo AS unit_type FROM rendimientos" },
      write_quote: { statement: "INSERT INTO outbox VALUES (:quote_id)" }
    });
  });
});

describe("profile stubs from TMS performance", () => {
  const perf: TmsCanonicalPerformance = {
    unit_type: "T3S2_53_DRYVAN",
    kpl_yield: 2.8,
    real_cost_per_km: 21.5
  };

  it("uses the unit_type as id + keyword and marks it tms-sourced", () => {
    const stub = buildProfileStub(perf, {
      business_unit_id: "general",
      pricing_model: "formula",
      margin_target_pct: 0.25,
      minimum_margin_pct: 0.18
    });
    expect(stub.vehicle_profile_id).toBe("T3S2_53_DRYVAN");
    expect(stub.keywords).toContain("T3S2_53_DRYVAN");
    expect(stub.performance_source).toBe("tms");
    expect(stub.fuel_loaded_km_per_l).toBe(2.8);
    expect(stub.tms_real_cost_per_km).toBe(21.5);
  });

  it("preserves an existing profile's commercial layer on re-sync", () => {
    const manifest: QuoteManifest = {
      client_id: "NMX",
      business_units: [{ business_unit_id: "general", default: true }],
      vehicle_profiles: [
        {
          vehicle_profile_id: "T3S2_53_DRYVAN",
          business_unit_id: "general",
          payload_capacity_kg: 24000,
          fuel_loaded_km_per_l: 3,
          fuel_empty_km_per_l: 3.4,
          operator_cost_per_km_mxn: 2.5,
          pricing_model: "profitability",
          diesel_price_mxn_per_liter: 24,
          margin_target_pct: 0.3,
          minimum_margin_pct: 0.2
        }
      ],
      route_policy: { sakbe_required: true }
    };
    const stub = buildProfileStub(perf, {
      business_unit_id: "general",
      pricing_model: "formula",
      margin_target_pct: 0.25,
      minimum_margin_pct: 0.18
    });
    const merged = mergeProfileStubs(manifest, [stub]);
    const profile = merged.vehicle_profiles[0]!;
    // human-tuned margins survive; only the TMS-sourced fields refresh
    expect(profile.margin_target_pct).toBe(0.3);
    expect(profile.pricing_model).toBe("profitability");
    expect(profile.performance_source).toBe("tms");
    expect(profile.tms_real_cost_per_km).toBe(21.5);
    expect(merged.vehicle_profiles).toHaveLength(1);
  });
});

describe("copilot", () => {
  it("falls back to static text when the model call fails", async () => {
    const copilot = createCopilot({
      provider: "openrouter",
      apiKey: "sk-test",
      model: "x",
      fetch: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch
    });
    const text = await copilot.explain("texto estático", "explica el paso");
    expect(text).toBe("texto estático");
  });

  it("never leaks the api key into the model prompt body", async () => {
    let capturedBody = "";
    const copilot = createCopilot({
      provider: "openrouter",
      apiKey: "sk-super-secret",
      model: "x",
      fetch: (async (_url: string, init: RequestInit) => {
        capturedBody = String(init.body);
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: "hola" } }] })
        };
      }) as unknown as typeof fetch
    });
    await copilot.explain("fallback", "explica el paso de TMS");
    // the key rides in the auth header, never in the prompt content
    expect(capturedBody).not.toContain("sk-super-secret");
  });
});
