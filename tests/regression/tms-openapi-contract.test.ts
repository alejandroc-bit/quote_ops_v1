import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  historicalQuoteRecordSchema,
  TMS_HTTP_V1_PATHS,
  tmsCanonicalAvailabilityZoneSchema,
  tmsCanonicalPerformanceSchema,
  tmsCanonicalUnitSchema,
  tmsHttpV1ErrorSchema,
  tmsHttpV1HealthSchema,
  tmsHttpV1HistoricalSearchRequestSchema,
  writeQuoteInputSchema,
  writeQuoteResultSchema
} from "@quoteops/contracts";
import type { z } from "zod";

type JsonObject = Record<string, unknown>;

const contractPath = resolve(
  process.cwd(),
  "docs/integrations/tms-http-v1.openapi.yaml"
);
const contract = parse(await readFile(contractPath, "utf8")) as JsonObject;

const expectedOperations = [
  ["GET", TMS_HTTP_V1_PATHS.health],
  ["POST", TMS_HTTP_V1_PATHS.historical_quotes],
  ["GET", TMS_HTTP_V1_PATHS.units],
  ["GET", TMS_HTTP_V1_PATHS.unit_performance],
  ["GET", TMS_HTTP_V1_PATHS.availability_zones],
  ["POST", TMS_HTTP_V1_PATHS.write_quote]
] as const;

const authoritativeComponents = {
  TmsHttpV1HistoricalSearchRequest: tmsHttpV1HistoricalSearchRequestSchema,
  HistoricalQuoteRecord: historicalQuoteRecordSchema,
  TmsHttpV1Health: tmsHttpV1HealthSchema,
  TmsCanonicalUnit: tmsCanonicalUnitSchema,
  TmsCanonicalPerformance: tmsCanonicalPerformanceSchema,
  TmsCanonicalAvailabilityZone: tmsCanonicalAvailabilityZoneSchema,
  WriteQuoteInput: writeQuoteInputSchema,
  WriteQuoteResult: writeQuoteResultSchema,
  TmsHttpV1Error: tmsHttpV1ErrorSchema
} satisfies Record<string, z.ZodTypeAny>;

describe("TMS HTTP v1 OpenAPI contract", () => {
  it("publishes exactly the canonical six method/path pairs", () => {
    const paths = objectAt(contract, "paths");
    const actual = Object.entries(paths)
      .flatMap(([path, pathItem]) =>
        Object.keys(asObject(pathItem))
          .filter((key) =>
            [
              "get",
              "post",
              "put",
              "patch",
              "delete",
              "options",
              "head",
              "trace"
            ].includes(key)
          )
          .map((method) => [method.toUpperCase(), path] as const)
      )
      .sort(comparePairs);

    expect(actual).toEqual([...expectedOperations].sort(comparePairs));
  });

  it("binds Bearer auth, operations, requests, successes, and strict errors", () => {
    expect(contract.security).toEqual([{ bearerAuth: [] }]);
    expect(
      objectAt(contract, "components", "securitySchemes", "bearerAuth")
    ).toEqual({ type: "http", scheme: "bearer" });

    const bindings = [
      {
        method: "get",
        path: TMS_HTTP_V1_PATHS.health,
        operationId: "health",
        success: "#/components/schemas/TmsHttpV1Health",
        errors: ["401", "500"]
      },
      {
        method: "post",
        path: TMS_HTTP_V1_PATHS.historical_quotes,
        operationId: "searchHistoricalQuotes",
        request: "#/components/schemas/TmsHttpV1HistoricalSearchRequest",
        successItems: "#/components/schemas/HistoricalQuoteRecord",
        errors: ["400", "401", "500"]
      },
      {
        method: "get",
        path: TMS_HTTP_V1_PATHS.units,
        operationId: "getUnits",
        successItems: "#/components/schemas/TmsCanonicalUnit",
        errors: ["401", "500"]
      },
      {
        method: "get",
        path: TMS_HTTP_V1_PATHS.unit_performance,
        operationId: "getUnitPerformance",
        successItems: "#/components/schemas/TmsCanonicalPerformance",
        errors: ["401", "500"]
      },
      {
        method: "get",
        path: TMS_HTTP_V1_PATHS.availability_zones,
        operationId: "getAvailabilityZones",
        successItems: "#/components/schemas/TmsCanonicalAvailabilityZone",
        errors: ["401", "500"]
      },
      {
        method: "post",
        path: TMS_HTTP_V1_PATHS.write_quote,
        operationId: "writeQuote",
        request: "#/components/schemas/WriteQuoteInput",
        success: "#/components/schemas/WriteQuoteResult",
        errors: ["400", "401", "409", "500"]
      }
    ];

    for (const binding of bindings) {
      const operation = objectAt(
        contract,
        "paths",
        binding.path,
        binding.method
      );
      expect(operation.operationId).toBe(binding.operationId);
      if (binding.request) {
        expect(
          objectAt(
            operation,
            "requestBody",
            "content",
            "application/json",
            "schema"
          ).$ref
        ).toBe(binding.request);
      }

      const successSchema = objectAt(
        operation,
        "responses",
        "200",
        "content",
        "application/json",
        "schema"
      );
      if (binding.success) {
        expect(successSchema.$ref).toBe(binding.success);
      } else {
        expect(successSchema).toMatchObject({
          type: "array",
          items: { $ref: binding.successItems }
        });
      }

      const responses = objectAt(operation, "responses");
      expect(Object.keys(responses).sort()).toEqual(
        ["200", ...binding.errors].sort()
      );
      for (const status of binding.errors) {
        const response = resolveLocalRef(
          asObject(responses[status]),
          contract
        );
        expect(
          objectAt(
            response,
            "content",
            "application/json",
            "schema"
          ).$ref
        ).toBe("#/components/schemas/TmsHttpV1Error");
      }
    }
  });

  it("matches every authoritative Zod object field-for-field", () => {
    const openApiSchemas = objectAt(contract, "components", "schemas");
    for (const [name, schema] of Object.entries(authoritativeComponents)) {
      const generatedDocument = zodToJsonSchema(schema, {
        name,
        target: "openApi3"
      }) as JsonObject;
      expect(
        normalizeSchema(asObject(openApiSchemas[name]), contract)
      ).toEqual(
        normalizeSchema(generatedDocument, generatedDocument)
      );
    }
  });

  it("validates every documented non-secret example with Zod", () => {
    const examples = objectAt(contract, "components", "examples");
    const cases = [
      ["historical_search", tmsHttpV1HistoricalSearchRequestSchema],
      ["unit", tmsCanonicalUnitSchema],
      ["performance", tmsCanonicalPerformanceSchema],
      ["zone", tmsCanonicalAvailabilityZoneSchema],
      ["quote_write", writeQuoteInputSchema]
    ] as const;

    for (const [name, schema] of cases) {
      expect(schema.safeParse(objectAt(examples, name, "value")).success).toBe(
        true
      );
    }
  });

  it("rejects the contract's negative corpus at the Zod source of truth", () => {
    const validSearch = objectAt(
      contract,
      "components",
      "examples",
      "historical_search",
      "value"
    );
    const validRow = {
      origin_city: "Monterrey",
      origin_state: "Nuevo Leon",
      origin_country: "MX",
      destination_city: "Saltillo",
      destination_state: "Coahuila",
      destination_country: "MX",
      vehicle_profile_id: "T3S3_53_DRYVAN",
      rate_mxn: 18500,
      quoted_at: "2026-07-29T18:00:00.000Z"
    };
    const invalidCases: Array<[z.ZodTypeAny, unknown]> = [
      [
        tmsHttpV1HistoricalSearchRequestSchema,
        omit(validSearch, "request_id")
      ],
      [
        tmsHttpV1HistoricalSearchRequestSchema,
        { ...validSearch, unexpected: true }
      ],
      [
        tmsHttpV1HistoricalSearchRequestSchema,
        { ...validSearch, request_id: null }
      ],
      [
        tmsHttpV1HistoricalSearchRequestSchema,
        {
          ...validSearch,
          time_window: { from: "2026-02-30", to: "2026-12-31" }
        }
      ],
      [
        historicalQuoteRecordSchema,
        { ...validRow, quoted_at: "2026-07-29" }
      ],
      [
        tmsHttpV1HistoricalSearchRequestSchema,
        {
          ...validSearch,
          time_window: { from: "2026-12-31", to: "2026-01-01" }
        }
      ],
      [
        tmsHttpV1HealthSchema,
        {
          ok: true,
          status: "failed",
          contract_version: "quoteops-tms-http-v1",
          capabilities: {
            historical_quotes: true,
            units: true,
            unit_performance: true,
            availability_zones: true,
            write_quote: true
          }
        }
      ],
      [
        tmsHttpV1HistoricalSearchRequestSchema,
        { ...validSearch, max_results: 501 }
      ]
    ];

    for (const [schema, value] of invalidCases) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });
});

function normalizeSchema(
  schema: JsonObject,
  root: JsonObject = schema
): JsonObject {
  if (typeof schema.$ref === "string") {
    return normalizeSchema(resolveLocalRef(schema, root), root);
  }
  const normalized: JsonObject = {};
  const schemaType = schema.type;
  if (typeof schemaType === "string") {
    normalized.type =
      schema.nullable === true
        ? [schemaType, "null"].sort()
        : schemaType;
  } else if (Array.isArray(schemaType)) {
    normalized.type = [...schemaType].sort();
  }
  const keys = [
    "properties",
    "items",
    "required",
    "additionalProperties",
    "const",
    "enum",
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "format",
    "anyOf",
    "oneOf",
    "allOf"
  ];
  for (const key of keys) {
    const value = schema[key];
    if (value === undefined) continue;
    if (key === "properties") {
      normalized.properties = Object.fromEntries(
        Object.entries(asObject(value)).map(([name, property]) => [
          name,
          normalizeSchema(asObject(property), root)
        ])
      );
    } else if (key === "items") {
      normalized.items = normalizeSchema(asObject(value), root);
    } else if (key === "required" && Array.isArray(value)) {
      normalized.required = [...value].sort();
    } else if (
      (key === "anyOf" || key === "oneOf" || key === "allOf") &&
      Array.isArray(value)
    ) {
      normalized[key] = value.map((item) =>
        normalizeSchema(asObject(item), root)
      );
    } else if (
      key === "additionalProperties" &&
      typeof value === "object" &&
      value !== null
    ) {
      normalized.additionalProperties = normalizeSchema(asObject(value), root);
    } else {
      normalized[key] = value;
    }
  }
  return normalized;
}

function objectAt(value: unknown, ...path: string[]): JsonObject {
  let current = asObject(value);
  for (const segment of path) {
    current = asObject(current[segment]);
  }
  return current;
}

function asObject(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected object in OpenAPI contract");
  }
  return value as JsonObject;
}

function omit(value: JsonObject, key: string): JsonObject {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function comparePairs(
  left: readonly [string, string],
  right: readonly [string, string]
): number {
  return `${left[1]}:${left[0]}`.localeCompare(`${right[1]}:${right[0]}`);
}

function resolveLocalRef(value: JsonObject, root: JsonObject): JsonObject {
  const ref = value.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/")) {
    return value;
  }
  let current: unknown = root;
  for (const encodedSegment of ref.slice(2).split("/")) {
    const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      current = current[Number(segment)];
    } else {
      current = asObject(current)[segment];
    }
  }
  return asObject(current);
}
