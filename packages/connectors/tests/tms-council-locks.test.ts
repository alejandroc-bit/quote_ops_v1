import { describe, expect, it } from "vitest";
import * as runtimeExports from "../src/index";
import {
  applyDeterministicTmsMapping,
  classifyTmsSchemaDrift,
  tmsCanonicalPerformanceSchema,
  tmsCanonicalRouteSchema,
  tmsCanonicalUnitSchema,
  type TmsMappingEntity,
  tmsMappingConfigSchema
} from "../src/index";
import { proposeTmsMappingFromSample } from "../src/tms/onboarding";

const config = {
  client_id: "NMX",
  endpoint_url: "https://tms.example.com/api",
  auth_method: "api_key",
  api_key_env: "TMS_API_KEY",
  transport: "http",
  mapping_engine: "jsonpath",
  schema_hash: "sha256:tms-v1",
  mappings: {
    units: "$.units[*]",
    routes: "$.routes[*]",
    performance: "$.performance[*]"
  },
  mapping_json: {
    units: {
      unit_id: "id",
      current_lat: "lat",
      current_lng: "lng",
      status: "status",
      next_destination_city: "nextCity"
    }
  },
  capabilities: {
    units: true,
    routes: true,
    performance: true
  },
  validation_timestamp: "2026-06-24T18:00:00.000Z",
  drift_status: "valid",
  runtime_ai_calls_allowed: false
} as const;

describe("TMS deterministic council locks", () => {
  it("maps raw TMS units into canonical units without runtime AI calls", () => {
    const raw = {
      units: [
        {
          id: "TR-101",
          lat: "25.6866",
          lng: "-100.3161",
          status: "Available",
          nextCity: "Saltillo"
        }
      ]
    };

    const parsedConfig = tmsMappingConfigSchema.parse(config);
    const units = applyDeterministicTmsMapping({
      entity_type: "units",
      raw,
      config: parsedConfig,
      jsonPathSearch: (payload, expression) => {
        expect(payload).toBe(raw);
        expect(expression).toBe("$.units[*]");
        return raw.units;
      }
    });

    expect(units).toEqual([
      {
        unit_id: "TR-101",
        current_lat: 25.6866,
        current_lng: -100.3161,
        status: "Available",
        next_destination_city: "Saltillo"
      }
    ]);
    expect(tmsCanonicalUnitSchema.parse(units[0])).toEqual(units[0]);
  });

  it("maps raw TMS routes into PRD canonical route fields", () => {
    const raw = {
      routes: [
        {
          route_id: "R-MTY-SLT",
          origin_city: "Monterrey",
          destination_city: "Saltillo",
          cargo_type: "autopartes",
          client_type: "industrial",
          historical_cost: "18500"
        }
      ]
    };

    const routes = applyDeterministicTmsMapping({
      entity_type: "routes",
      raw,
      config: tmsMappingConfigSchema.parse(config),
      jsonPathSearch: (_payload, expression) => {
        expect(expression).toBe("$.routes[*]");
        return raw.routes;
      }
    });

    expect(routes).toEqual([
      {
        route_id: "R-MTY-SLT",
        origin_city: "Monterrey",
        destination_city: "Saltillo",
        cargo_type: "autopartes",
        client_type: "industrial",
        historical_cost: 18500
      }
    ]);
    expect(tmsCanonicalRouteSchema.parse(routes[0])).toEqual(routes[0]);
  });

  it("maps raw TMS performance into PRD canonical performance fields", () => {
    const raw = {
      performance: [
        {
          unit_type: "T3S2_53_DRYVAN",
          kpl_yield: "2.8",
          real_cost_per_km: "19.45"
        }
      ]
    };

    const performance = applyDeterministicTmsMapping({
      entity_type: "performance",
      raw,
      config: tmsMappingConfigSchema.parse(config),
      jsonPathSearch: (_payload, expression) => {
        expect(expression).toBe("$.performance[*]");
        return raw.performance;
      }
    });

    expect(performance).toEqual([
      {
        unit_type: "T3S2_53_DRYVAN",
        kpl_yield: 2.8,
        real_cost_per_km: 19.45
      }
    ]);
    expect(tmsCanonicalPerformanceSchema.parse(performance[0])).toEqual(performance[0]);
  });

  it("typechecks union entity callers through the generic type map", () => {
    function mapEntity(entityType: TmsMappingEntity) {
      return applyDeterministicTmsMapping({
        entity_type: entityType,
        raw: { rows: [] },
        config: {
          ...config,
          mappings: { ...config.mappings, pricing_history: "$.rows[*]" }
        },
        jsonPathSearch: () => []
      });
    }

    expect(mapEntity("units")).toEqual([]);
  });

  it("rejects routes missing commercial canonical fields", () => {
    expect(() =>
      applyDeterministicTmsMapping({
        entity_type: "routes",
        raw: { routes: [{ route_id: "R-MTY-SLT", origin_city: "Monterrey" }] },
        config: tmsMappingConfigSchema.parse(config),
        jsonPathSearch: () => [{ route_id: "R-MTY-SLT", origin_city: "Monterrey" }]
      })
    ).toThrow();
  });

  it("rejects performance rows missing PRD canonical fields", () => {
    expect(() =>
      applyDeterministicTmsMapping({
        entity_type: "performance",
        raw: { performance: [{ unit_type: "T3S2_53_DRYVAN", kpl_yield: "2.8" }] },
        config: tmsMappingConfigSchema.parse(config),
        jsonPathSearch: () => [{ unit_type: "T3S2_53_DRYVAN", kpl_yield: "2.8" }]
      })
    ).toThrow();
  });

  it("rejects runtime mapping when AI calls are allowed before searching JSONPath", () => {
    let jsonPathCalls = 0;

    expect(() =>
      applyDeterministicTmsMapping({
        entity_type: "units",
        raw: { units: [] },
        config: {
          ...config,
          runtime_ai_calls_allowed: true
        },
        jsonPathSearch: () => {
          jsonPathCalls += 1;
          return [];
        }
      })
    ).toThrow(/TMS runtime AI calls are forbidden/);
    expect(jsonPathCalls).toBe(0);
  });

  it("calls the onboarding model exactly once and validates a mapping proposal", async () => {
    let modelCalls = 0;
    const prompts: string[] = [];

    const proposal = await proposeTmsMappingFromSample({
      client_id: "NMX",
      entity_type: "units",
      mapping_engine: "jsonpath",
      raw_json_sample: {
        rows: [
          {
            id: "TR-101",
            lat: "25.6866",
            lng: "-100.3161",
            status_code: "Available",
            nextCity: "Saltillo"
          }
        ]
      },
      model: (prompt) => {
        modelCalls += 1;
        prompts.push(prompt);
        return {
          mapping_engine: "jsonpath",
          mapping_expression: "$.rows[*]",
          source_fields_used: ["id", "lat", "lng", "status_code", "nextCity"],
          canonical_fields_covered: [
            "unit_id",
            "current_lat",
            "current_lng",
            "status",
            "next_destination_city"
          ],
          warnings: [],
          confidence: 0.91,
          mapping_json: {
            units: {
              unit_id: "id",
              current_lat: "lat",
              current_lng: "lng",
              status: "status_code",
              next_destination_city: "nextCity"
            }
          }
        };
      }
    });

    expect(modelCalls).toBe(1);
    expect(prompts[0]).toContain("Client: NMX");
    expect(prompts[0]).toContain("Entity: units");
    expect(prompts[0]).toContain("raw_json_sample:");
    expect(proposal.mapping_expression).toBe("$.rows[*]");
    expect(proposal.mapping_json?.units?.unit_id).toBe("id");
  });

  it("rejects onboarding mapping proposals that do not cover critical canonical fields", async () => {
    await expect(
      proposeTmsMappingFromSample({
        client_id: "NMX",
        entity_type: "routes",
        raw_json_sample: { rows: [{ route: "R-MTY-SLT" }] },
        model: () => ({
          mapping_engine: "jsonpath",
          mapping_expression: "$.rows[*]",
          source_fields_used: ["route"],
          canonical_fields_covered: ["route_id"],
          warnings: ["sample was sparse"],
          confidence: 0.9,
          mapping_json: {
            routes: {
              route_id: "route"
            }
          }
        })
      })
    ).rejects.toThrow(/missing canonical fields/);
  });

  it("rejects onboarding proposals for unsupported mapping engines", async () => {
    await expect(
      proposeTmsMappingFromSample({
        client_id: "NMX",
        entity_type: "units",
        raw_json_sample: { rows: [{ unit_id: "TR-101" }] },
        model: () => ({
          mapping_engine: "jmespath",
          mapping_expression: "rows[]",
          source_fields_used: ["unit_id"],
          canonical_fields_covered: ["unit_id", "current_lat", "current_lng", "status"],
          warnings: [],
          confidence: 0.9
        })
      })
    ).rejects.toThrow(/jsonpath/);
  });

  it("rejects onboarding proposals with invalid JSONPath expressions or zero selected rows", async () => {
    const baseProposal = {
      mapping_engine: "jsonpath",
      source_fields_used: ["id", "lat", "lng", "status"],
      canonical_fields_covered: ["unit_id", "current_lat", "current_lng", "status"],
      warnings: [],
      confidence: 0.9,
      mapping_json: {
        units: {
          unit_id: "id",
          current_lat: "lat",
          current_lng: "lng",
          status: "status"
        }
      }
    };
    const rawJsonSample = {
      rows: [{ id: "TR-101", lat: "25.6866", lng: "-100.3161", status: "Available" }]
    };

    await expect(
      proposeTmsMappingFromSample({
        client_id: "NMX",
        entity_type: "units",
        raw_json_sample: rawJsonSample,
        model: () => ({
          ...baseProposal,
          mapping_expression: "$.rows[?(@.]"
        })
      })
    ).rejects.toThrow(/Invalid jsonpath mapping expression/);

    await expect(
      proposeTmsMappingFromSample({
        client_id: "NMX",
        entity_type: "units",
        raw_json_sample: rawJsonSample,
        model: () => ({
          ...baseProposal,
          mapping_expression: "$.missing[*]"
        })
      })
    ).rejects.toThrow(/zero rows/);
  });

  it("rejects onboarding proposals when mapped source fields are absent from selected sample rows", async () => {
    await expect(
      proposeTmsMappingFromSample({
        client_id: "NMX",
        entity_type: "routes",
        raw_json_sample: {
          rows: [
            {
              route_id: "R-MTY-SLT",
              origin_city: "Monterrey",
              destination_city: "Saltillo",
              cargo_type: "autopartes",
              client_type: "industrial"
            }
          ]
        },
        model: () => ({
          mapping_engine: "jsonpath",
          mapping_expression: "$.rows[*]",
          source_fields_used: [
            "route_id",
            "origin_city",
            "destination_city",
            "cargo_type",
            "client_type",
            "missing_cost"
          ],
          canonical_fields_covered: [
            "route_id",
            "origin_city",
            "destination_city",
            "cargo_type",
            "client_type",
            "historical_cost"
          ],
          warnings: [],
          confidence: 0.9,
          mapping_json: {
            routes: {
              route_id: "route_id",
              origin_city: "origin_city",
              destination_city: "destination_city",
              cargo_type: "cargo_type",
              client_type: "client_type",
              historical_cost: "missing_cost"
            }
          }
        })
      })
    ).rejects.toThrow(/source field missing/);
  });

  it("rejects onboarding proposals when mapped rows fail canonical parsing", async () => {
    await expect(
      proposeTmsMappingFromSample({
        client_id: "NMX",
        entity_type: "units",
        raw_json_sample: {
          rows: [{ id: "TR-101", lat: "not-a-latitude", lng: "-100.3161", status: "Available" }]
        },
        model: () => ({
          mapping_engine: "jsonpath",
          mapping_expression: "$.rows[*]",
          source_fields_used: ["id", "lat", "lng", "status"],
          canonical_fields_covered: ["unit_id", "current_lat", "current_lng", "status"],
          warnings: [],
          confidence: 0.9,
          mapping_json: {
            units: {
              unit_id: "id",
              current_lat: "lat",
              current_lng: "lng",
              status: "status"
            }
          }
        })
      })
    ).rejects.toThrow(/Expected a finite number/);
  });

  it("fails closed for critical TMS schema drift across canonical entities", () => {
    const criticalCases: Array<[TmsMappingEntity, string]> = [
      ["units", "unit_id"],
      ["routes", "historical_cost"],
      ["performance", "real_cost_per_km"],
      ["pricing_history", "quoted_price"],
      ["liquidations", "settled_cost"],
      ["availability_zones", "available_units"]
    ];

    const pathShapes = (field: string) => [["0", field], [0, field], ["units", 0, field]];

    for (const [entityType, field] of criticalCases) {
      for (const path of pathShapes(field)) {
        const result = classifyTmsSchemaDrift({
          entity_type: entityType,
          validation_errors: [
            {
              path,
              code: "invalid_type",
              received: "undefined",
              message: "Required"
            }
          ]
        });

        expect(result.status).toBe("needs_remap");
        expect(result.rfq_effect).toBe("REVIEW_REQUIRED");
        expect(result.reason_codes).toContain(`critical_field_missing:${entityType}.${field}`);
      }
    }
  });

  it("does not force RFQ review for noncritical TMS schema drift", () => {
    const result = classifyTmsSchemaDrift({
      entity_type: "units",
      validation_errors: [
        {
          path: ["next_destination_city"],
          code: "too_small",
          message: "String must contain at least 1 character(s)"
        }
      ]
    });

    expect(result).toEqual({
      status: "ok",
      rfq_effect: "none",
      reason_codes: ["noncritical_field_issue:units.next_destination_city"]
    });
  });

  it("keeps runtime deterministic mapping disconnected from onboarding model callbacks", () => {
    let modelCalls = 0;
    const raw = {
      units: [
        {
          id: "TR-101",
          lat: "25.6866",
          lng: "-100.3161",
          status: "Available",
          nextCity: "Saltillo"
        }
      ]
    };
    const runtimeInput = {
      entity_type: "units" as const,
      raw,
      config: tmsMappingConfigSchema.parse(config),
      jsonPathSearch: () => raw.units,
      model: () => {
        modelCalls += 1;
        return {};
      }
    };
    const { model: _model, ...mapperInput } = runtimeInput;

    const units = applyDeterministicTmsMapping(mapperInput);

    expect(units).toHaveLength(1);
    expect(modelCalls).toBe(0);
  });

  it("does not export onboarding helpers from the runtime barrel", () => {
    expect("proposeTmsMappingFromSample" in runtimeExports).toBe(false);
    expect("tmsMappingProposalSchema" in runtimeExports).toBe(false);
  });

  it("rejects empty numeric strings for latitude, route cost, and kpl", () => {
    expect(() =>
      tmsCanonicalUnitSchema.parse({
        unit_id: "TR-101",
        current_lat: "",
        current_lng: "-100.3161",
        status: "Available"
      })
    ).toThrow();

    expect(() =>
      tmsCanonicalRouteSchema.parse({
        route_id: "R-MTY-SLT",
        origin_city: "Monterrey",
        destination_city: "Saltillo",
        cargo_type: "autopartes",
        client_type: "industrial",
        historical_cost: ""
      })
    ).toThrow();

    expect(() =>
      tmsCanonicalPerformanceSchema.parse({
        unit_type: "T3S2_53_DRYVAN",
        kpl_yield: "",
        real_cost_per_km: "19.45"
      })
    ).toThrow();
  });

  it("rejects out-of-range latitude and longitude values", () => {
    expect(() =>
      tmsCanonicalUnitSchema.parse({
        unit_id: "TR-101",
        current_lat: "90.1",
        current_lng: "-100.3161",
        status: "Available"
      })
    ).toThrow();

    expect(() =>
      tmsCanonicalUnitSchema.parse({
        unit_id: "TR-101",
        current_lat: "25.6866",
        current_lng: "-180.1",
        status: "Available"
      })
    ).toThrow();
  });

  it("does not apply aliases unless mapping_json provides them", () => {
    expect(() =>
      applyDeterministicTmsMapping({
        entity_type: "units",
        raw: { units: [{ id: "TR-101", lat: "25.6866", lng: "-100.3161", status: "Available" }] },
        config: tmsMappingConfigSchema.parse({
          ...config,
          mapping_json: undefined
        }),
        jsonPathSearch: () => [
          { id: "TR-101", lat: "25.6866", lng: "-100.3161", status: "Available" }
        ]
      })
    ).toThrow();
  });

  it("rejects embedded TMS secret values in config secret references", () => {
    expect(() =>
      tmsMappingConfigSchema.parse({
        ...config,
        api_key_env: "sk-live-secret"
      })
    ).toThrow(/secret reference must be an env var ref/);
  });

  it("requires api_key_env for api key auth and rejects non-http endpoints", () => {
    const { api_key_env: _apiKeyEnv, ...missingApiKeyEnvConfig } = config;

    expect(() => tmsMappingConfigSchema.parse(missingApiKeyEnvConfig)).toThrow();
    expect(() =>
      tmsMappingConfigSchema.parse({
        ...config,
        endpoint_url: "ftp://tms.example.com/api"
      })
    ).toThrow(/endpoint_url must use http or https/);
  });
});
