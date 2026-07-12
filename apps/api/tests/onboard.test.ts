import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { QuoteManifest } from "@quoteops/quote-core";
import type { TmsCanonicalPerformance } from "@quoteops/contracts";
import { renderBanner } from "../src/onboard/tronUi.js";
import {
  applyAuthorizationToAgentConfig,
  buildProfileStub,
  buildTmsAdapterYaml,
  createCopilot,
  mergeConfiguredProfileStubs,
  mergeProfileStubs,
  upsertEnvLine
} from "../src/onboard/onboardConfig.js";
import {
  applyAuthorization,
  buildSampleQuoteRows,
  parseDomainList,
  parseRbTable,
  renderQuoteTable,
  runSampleValidationLoop,
  validateAuthorization,
  validateMinimumMargin,
  validateMarginParams
} from "../src/onboard/wizardSteps.js";

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
    expect(profile.fuel_loaded_km_per_l).toBe(2.8);
    expect(profile.fuel_empty_km_per_l).toBe(2.8);
    expect(profile.operator_cost_per_km_mxn).toBe(21.5);
    expect(merged.vehicle_profiles).toHaveLength(1);
  });

  it("applies the operator's new pricing selection after TMS prefill", () => {
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
    const commercial = {
      business_unit_id: "general",
      pricing_model: "formula" as const,
      margin_target_pct: 0.27,
      minimum_margin_pct: 0.19
    };
    const stub = buildProfileStub(perf, commercial);

    const merged = mergeConfiguredProfileStubs(manifest, [{ stub, commercial }]);

    expect(merged.vehicle_profiles[0]).toMatchObject({
      pricing_model: "formula",
      margin_target_pct: 0.27,
      minimum_margin_pct: 0.19,
      fuel_loaded_km_per_l: 2.8,
      operator_cost_per_km_mxn: 21.5
    });
  });
});

describe("pricing and authorization wizard steps", () => {
  const manifest: QuoteManifest = {
    client_id: "NMX",
    business_units: [{ business_unit_id: "general", default: true }],
    vehicle_profiles: [
      {
        vehicle_profile_id: "T3S2_53_DRYVAN",
        business_unit_id: "general",
        payload_capacity_kg: 24000,
        fuel_loaded_km_per_l: 2.8,
        fuel_empty_km_per_l: 3.2,
        operator_cost_per_km_mxn: 2.5,
        pricing_model: "formula",
        diesel_price_mxn_per_liter: 24,
        margin_target_pct: 0.25,
        minimum_margin_pct: 0.18
      }
    ],
    route_policy: { sakbe_required: false }
  };

  it("validates formula margins and profitability RB brackets", () => {
    expect(validateMarginParams(0.25, 0.18)).toEqual([]);
    expect(validateMarginParams(0.1, 0.18)).toContain(
      "minimum_margin_pct no puede ser mayor que margin_target_pct"
    );
    expect(validateMinimumMargin(0.18)).toEqual([]);
    expect(validateMinimumMargin(Number.NaN)).toHaveLength(1);
    expect(parseRbTable("100:0.6, 500:0.55, *:0.5")).toEqual([
      { max_km: 100, rb_pct: 0.6 },
      { max_km: 500, rb_pct: 0.55 },
      { max_km: null, rb_pct: 0.5 }
    ]);
    expect(() => parseRbTable("500:0.55, 100:0.6, *:0.5")).toThrow(/ascendente/);
  });

  it("normalizes tenant authorization into the manifest and agent config", () => {
    const authorization = {
      approver_email: " Boss@Example.COM ",
      allowed_domains: parseDomainList("Example.com, CLIENT.mx"),
      whatsapp_approver_phone: "+52 (81) 1234-5678"
    };
    expect(validateAuthorization(authorization)).toEqual([]);
    expect(
      validateAuthorization({ ...authorization, whatsapp_approver_phone: "" })
    ).toContain('teléfono WhatsApp inválido: ""');

    const updated = applyAuthorization(manifest, authorization);
    expect(updated.authorization).toEqual({
      approver_email: "boss@example.com",
      allowed_domains: ["example.com", "client.mx"],
      whatsapp_approver_phone: "+528112345678"
    });
    expect(updated.business_units[0]?.requester_email_domains).toEqual([
      "example.com",
      "client.mx"
    ]);

    const config = parseYaml(
      applyAuthorizationToAgentConfig(
        [
          "model:",
          "  provider: deterministic",
          "  model_name: quote-core-preserver",
          "authorization:",
          "  tools:",
          "    route.resolve:",
          "      effect: read",
          "      mode: allowed",
          ""
        ].join("\n"),
        updated.authorization!
      )
    );
    expect(config.authorization).toMatchObject({
      approver_email: "boss@example.com",
      allowed_domains: ["example.com", "client.mx"],
      whatsapp_approver_phone: "+528112345678"
    });
    expect(config.authorization.tools["route.resolve"]).toEqual({
      effect: "read",
      mode: "allowed"
    });
  });

  it("revokes removed domains across every business unit on authorization rerun", () => {
    const previouslyAuthorized = applyAuthorization(
      {
        ...manifest,
        business_units: [
          {
            business_unit_id: "general",
            default: true,
            requester_email_domains: ["old.example", "keep.example"]
          },
          {
            business_unit_id: "north",
            requester_email_domains: ["old.example", "north.example"]
          }
        ]
      },
      {
        approver_email: "old-boss@old.example",
        allowed_domains: ["old.example", "keep.example"],
        whatsapp_approver_phone: "+528100000000"
      }
    );
    const revoked = applyAuthorization(previouslyAuthorized, {
      approver_email: "new-boss@keep.example",
      allowed_domains: ["keep.example", "KEEP.example"],
      whatsapp_approver_phone: "+528111111111"
    });

    expect(revoked.authorization?.allowed_domains).toEqual(["keep.example"]);
    expect(revoked.business_units.map((unit) => unit.requester_email_domains)).toEqual([
      ["keep.example"],
      ["keep.example"]
    ]);
    expect(JSON.stringify(revoked)).not.toContain("old.example");

    const config = parseYaml(
      applyAuthorizationToAgentConfig(
        [
          "model:",
          "  provider: deterministic",
          "  model_name: quote-core-preserver",
          "authorization:",
          "  approver_email: old-boss@old.example",
          "  allowed_domains: [old.example]",
          "  whatsapp_approver_phone: '+528100000000'",
          "  tools:",
          "    email.intake:",
          "      effect: read",
          "      mode: allowed",
          ""
        ].join("\n"),
        revoked.authorization!
      )
    );
    expect(config.authorization.allowed_domains).toEqual(["keep.example"]);
    expect(config.authorization.approver_email).toBe("new-boss@keep.example");
  });

  it("runs exactly three deterministic sample quotes and renders all rows", () => {
    const routeStrictManifest = { ...manifest, route_policy: { sakbe_required: true } };
    const rows = buildSampleQuoteRows(routeStrictManifest, ["T3S2_53_DRYVAN"]);
    expect(rows).toHaveLength(3);
    expect(
      rows.every(
        (row) =>
          row.pricing_model === "formula" &&
          row.rate_mxn > 0 &&
          row.status === "APPROVED" &&
          row.review_reasons.length === 0
      )
    ).toBe(true);
    const table = renderQuoteTable(rows);
    expect(table).toContain("Monterrey, Nuevo Leon → Saltillo, Coahuila");
    expect(table).toContain("Guadalajara, Jalisco → Tijuana, Baja California");
    expect(table).toContain("Estado");
    expect(table).toContain("Motivos de revisión");
    expect(table).toContain("APPROVED");
  });

  it("validates an appended TMS profile instead of the existing template profile", () => {
    const appended = {
      ...manifest.vehicle_profiles[0]!,
      vehicle_profile_id: "TMS_APPENDED",
      fuel_loaded_km_per_l: 2.6,
      fuel_empty_km_per_l: 2.6,
      operator_cost_per_km_mxn: 18
    };
    const withTemplate = {
      ...manifest,
      vehicle_profiles: [manifest.vehicle_profiles[0]!, appended]
    };

    const appendedOnly = buildSampleQuoteRows(withTemplate, ["TMS_APPENDED"]);
    expect(appendedOnly.map((row) => row.unit)).toEqual([
      "TMS_APPENDED",
      "TMS_APPENDED",
      "TMS_APPENDED"
    ]);

    const distributed = buildSampleQuoteRows(withTemplate, [
      "T3S2_53_DRYVAN",
      "TMS_APPENDED"
    ]);
    expect(distributed.map((row) => row.unit)).toEqual([
      "T3S2_53_DRYVAN",
      "TMS_APPENDED",
      "T3S2_53_DRYVAN"
    ]);
  });

  it("repeats three-quote validation after rejected pricing parameters", async () => {
    const shown: Array<ReturnType<typeof buildSampleQuoteRows>> = [];
    let confirmations = 0;
    let adjustments = 0;

    const accepted = await runSampleValidationLoop(manifest, {
      profileIds: ["T3S2_53_DRYVAN"],
      show: (rows) => shown.push(rows),
      confirm: async () => {
        confirmations += 1;
        return confirmations === 2;
      },
      adjust: async (current) => {
        adjustments += 1;
        return {
          ...current,
          vehicle_profiles: current.vehicle_profiles.map((profile) => ({
            ...profile,
            margin_target_pct: 0.3
          }))
        };
      }
    });

    expect(shown).toHaveLength(2);
    expect(shown.every((rows) => rows.length === 3)).toBe(true);
    expect(adjustments).toBe(1);
    expect(accepted.vehicle_profiles[0]?.margin_target_pct).toBe(0.3);
  });

  it("blocks confirmation and forces adjustment while any sample needs review", async () => {
    const invalid = {
      ...manifest,
      vehicle_profiles: manifest.vehicle_profiles.map((profile) => ({
        ...profile,
        margin_target_pct: 1
      }))
    };
    const shown: Array<ReturnType<typeof buildSampleQuoteRows>> = [];
    let confirmations = 0;
    let adjustments = 0;

    await runSampleValidationLoop(invalid, {
      profileIds: ["T3S2_53_DRYVAN"],
      show: (rows) => shown.push(rows),
      confirm: async () => {
        confirmations += 1;
        return true;
      },
      adjust: async (current, rows) => {
        adjustments += 1;
        expect(rows.some((row) => row.review_reasons.includes("invalid_margin_policy"))).toBe(true);
        return {
          ...current,
          vehicle_profiles: current.vehicle_profiles.map((profile) => ({
            ...profile,
            margin_target_pct: 0.25
          }))
        };
      }
    });

    expect(shown).toHaveLength(2);
    expect(shown[0]?.every((row) => row.status === "REVIEW_REQUIRED")).toBe(true);
    expect(shown[1]?.every((row) => row.status === "APPROVED")).toBe(true);
    expect(adjustments).toBe(1);
    expect(confirmations).toBe(1);
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
