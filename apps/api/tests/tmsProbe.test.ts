import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoricalAnalysis } from "@quoteops/contracts";
import {
  defaultTmsAdapterCapabilities,
  type HistoricalSearchQuery,
  type TmsAdapter
} from "@quoteops/connectors";
import {
  configureTmsHttpV1,
  hasMatchingTmsProbeReceipt,
  probeLegacyCustomHttp,
  probeTmsHttpV1,
  readTmsCredentialRevision,
  TmsProbeError
} from "../src/onboard/tmsProbe.js";
import { readEnvFileValues } from "../src/onboard/onboardConfig.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

const sampleQuery: HistoricalSearchQuery = {
  request_id: "probe-1",
  origin: { city: "Monterrey", state: "NL", country: "MX" },
  destination: { city: "Saltillo", state: "COA", country: "MX" },
  vehicle_profile_id: "unit-1",
  time_window: { from: "2026-01-01", to: "2026-07-29" },
  max_results: 20
};

const historical: HistoricalAnalysis = {
  request_id: "probe-1",
  search_layers: ["route_unit_cost"],
  time_window: sampleQuery.time_window,
  comparables: [
    {
      layer: "route_unit_cost",
      match_quality: "exact_route_exact_unit",
      count: 1,
      min_rate_mxn: 1000,
      median_rate_mxn: 1000,
      max_rate_mxn: 1000
    }
  ],
  insufficient_data: []
};

function pinnedRequestFromFetch(fetchFn: typeof fetch) {
  return async ({ url, init }: { url: URL; init: RequestInit }) =>
    await fetchFn(url, init);
}

function fixtureAdapter(
  overrides: Partial<TmsAdapter> = {}
): TmsAdapter & {
  writeQuoteResult: ReturnType<typeof vi.fn>;
} {
  const writeQuoteResult = vi.fn();
  return {
    healthCheck: vi.fn().mockResolvedValue({
      ok: true,
      status: "ok",
      capabilities: defaultTmsAdapterCapabilities({
        search_historical_quotes: true,
        read_units: true,
        read_unit_performance: true,
        read_availability_zones: true,
        write_quote: true
      })
    }),
    searchHistoricalQuotes: vi.fn().mockResolvedValue(historical),
    getUnits: vi.fn().mockResolvedValue([
      {
        unit_id: "unit-1",
        current_lat: 25.6866,
        current_lng: -100.3161,
        status: "Available"
      }
    ]),
    getUnitPerformance: vi.fn().mockResolvedValue([
      {
        unit_type: "unit-1",
        kpl_yield: 2.7,
        real_cost_per_km: 22
      }
    ]),
    getAvailabilityZones: vi.fn().mockResolvedValue([
      {
        zone_id: "north",
        city: "Monterrey",
        state: "NL",
        country: "MX",
        available_units: 1
      }
    ]),
    writeQuoteResult,
    getRfq: vi.fn(),
    listNewRfqs: vi.fn(),
    searchHistoricalShipments: vi.fn(),
    getCustomer: vi.fn(),
    getCustomerAgreements: vi.fn(),
    getUnitPositions: vi.fn(),
    writeQuoteStatus: vi.fn(),
    ...overrides
  } as unknown as TmsAdapter & {
    writeQuoteResult: ReturnType<typeof vi.fn>;
  };
}

async function fixtureFiles(contract = true): Promise<{
  adapterConfigPath: string;
  receiptPath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "quoteops-tms-probe-"));
  temporaryDirectories.push(directory);
  const adapterConfigPath = join(directory, "tms-adapter.yaml");
  const receiptPath = join(directory, "tms-probe.json");
  await writeFile(
    adapterConfigPath,
    contract
      ? [
          "provider: http",
          "contract: quoteops-tms-http-v1",
          "base_url_env: TMS_HTTP_BASE_URL",
          "headers:",
          "  authorization: Bearer ${TMS_API_KEY}",
          "health_endpoint_path: /quoteops/v1/health",
          "search_historical_quotes_endpoint_path: /quoteops/v1/historical-quotes/search",
          "get_units_endpoint_path: /quoteops/v1/units",
          "get_unit_performance_endpoint_path: /quoteops/v1/unit-performance",
          "get_availability_zones_endpoint_path: /quoteops/v1/availability-zones",
          "write_quote_endpoint_path: /quoteops/v1/quotes",
          ""
        ].join("\n")
      : [
          "provider: http",
          "base_url_env: TMS_HTTP_BASE_URL",
          "health_endpoint_path: /health",
          "search_historical_quotes_endpoint_path: /historical",
          "get_units_endpoint_path: /units",
          "get_unit_performance_endpoint_path: /performance",
          "get_availability_zones_endpoint_path: /zones",
          "write_quote_endpoint_path: /quotes",
          ""
        ].join("\n"),
    "utf8"
  );
  return { adapterConfigPath, receiptPath };
}

function v1Health(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    status: "ok",
    contract_version: "quoteops-tms-http-v1",
    capabilities: {
      historical_quotes: true,
      units: true,
      unit_performance: true,
      availability_zones: true,
      write_quote: true
    },
    ...overrides
  };
}

function healthFetch(body: unknown = v1Health(), status = 200): typeof fetch {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    })
  );
}

function publicResolver(): Promise<string[]> {
  return Promise.resolve(["8.8.8.8"]);
}

function canonicalFixtureFetch(): typeof fetch {
  return vi.fn(async (request: URL | RequestInfo) => {
    const url = new URL(
      request instanceof URL
        ? request.href
        : request instanceof Request
          ? request.url
          : String(request)
    );
    const bodies: Record<string, unknown> = {
      "/quoteops/v1/health": v1Health(),
      "/quoteops/v1/historical-quotes/search": [
        {
          origin_city: "Monterrey",
          origin_state: "NL",
          origin_country: "MX",
          destination_city: "Saltillo",
          destination_state: "COA",
          destination_country: "MX",
          vehicle_profile_id: "unit-1",
          rate_mxn: 1000,
          quoted_at: "2026-06-01T00:00:00.000Z"
        }
      ],
      "/quoteops/v1/units": [
        {
          unit_id: "unit-1",
          current_lat: 25.6866,
          current_lng: -100.3161,
          status: "Available"
        }
      ],
      "/quoteops/v1/unit-performance": [
        {
          unit_type: "unit-1",
          kpl_yield: 2.7,
          real_cost_per_km: 22
        }
      ],
      "/quoteops/v1/availability-zones": [
        {
          zone_id: "north",
          city: "Monterrey",
          state: "NL",
          country: "MX",
          available_units: 1
        }
      ]
    };
    if (!(url.pathname in bodies)) throw new Error("unexpected endpoint");
    return new Response(JSON.stringify(bodies[url.pathname]), {
      status: 200
    });
  }) as unknown as typeof fetch;
}

describe("probeTmsHttpV1", () => {
  it("validates all read capabilities, never writes a quote, and persists a redacted receipt", async () => {
    const files = await fixtureFiles();
    const adapter = fixtureAdapter();
    const fetchFn = healthFetch();

    const receipt = await probeTmsHttpV1({
      adapter,
      resolvedBaseUrl: "https://tms.client.example",
      resolvedHeaders: { authorization: "Bearer test-token" },
      adapterConfigPath: files.adapterConfigPath,
      credentialRevision: 1,
      receiptPath: files.receiptPath,
      sampleQuery,
      fetch: fetchFn,
      resolveHostname: publicResolver,
      now: () => new Date("2026-07-29T18:00:00.000Z")
    });

    expect(receipt).toEqual({
      contract: "quoteops-tms-http-v1",
      adapter_config_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      credential_revision: 1,
      base_url_origin: "https://tms.client.example",
      validated_at: "2026-07-29T18:00:00.000Z",
      checks: {
        health: "ok",
        historical_quotes: "ok",
        units: "ok",
        unit_performance: "ok",
        availability_zones: "ok",
        write_quote_declared: "ok"
      }
    });
    expect(fetchFn).toHaveBeenCalledWith(
      new URL("https://tms.client.example/quoteops/v1/health"),
      expect.objectContaining({
        headers: { authorization: "Bearer test-token" },
        redirect: "manual"
      })
    );
    expect(adapter.writeQuoteResult).not.toHaveBeenCalled();
    expect(JSON.stringify(receipt)).not.toContain("test-token");
    expect(await readFile(files.receiptPath, "utf8")).not.toContain("test-token");
    expect((await stat(files.receiptPath)).mode & 0o777).toBe(0o600);
  });

  it.each([
    ["authentication failure", v1Health(), 401, "health_http_401"],
    [
      "invalid contract",
      v1Health({ contract_version: "quoteops-tms-http-v2" }),
      200,
      "health_invalid"
    ],
    [
      "contradictory status",
      v1Health({ ok: false }),
      200,
      "health_invalid"
    ],
    [
      "missing write declaration",
      v1Health({
        capabilities: {
          historical_quotes: true,
          units: true,
          unit_performance: true,
          availability_zones: true,
          write_quote: false
        }
      }),
      200,
      "write_quote_not_declared"
    ]
  ])("rejects %s without exposing remote body details", async (_name, body, status, code) => {
    const files = await fixtureFiles();
    await expect(
      probeTmsHttpV1({
        adapter: fixtureAdapter(),
        resolvedBaseUrl: "https://tms.client.example",
        resolvedHeaders: { authorization: "Bearer never-leak" },
        adapterConfigPath: files.adapterConfigPath,
        credentialRevision: 1,
        receiptPath: files.receiptPath,
        sampleQuery,
        fetch: healthFetch(body, status),
        resolveHostname: publicResolver
      })
    ).rejects.toMatchObject({ code });
  });

  it.each([
    [
      "malformed historical output",
      { searchHistoricalQuotes: vi.fn().mockResolvedValue({ request_id: "bad" }) },
      "historical_quotes_invalid"
    ],
    ["empty units", { getUnits: vi.fn().mockResolvedValue([]) }, "units_empty"],
    [
      "unmatched performance profile",
      {
        getUnitPerformance: vi.fn().mockResolvedValue([
          { unit_type: "other", kpl_yield: 2, real_cost_per_km: 20 }
        ])
      },
      "unit_performance_unmatched"
    ],
    [
      "unavailable zones",
      { getAvailabilityZones: vi.fn().mockResolvedValue([]) },
      "availability_zones_empty"
    ]
  ])("rejects %s", async (_name, overrides, code) => {
    const files = await fixtureFiles();
    await expect(
      probeTmsHttpV1({
        adapter: fixtureAdapter(overrides as Partial<TmsAdapter>),
        resolvedBaseUrl: "https://tms.client.example",
        resolvedHeaders: {},
        adapterConfigPath: files.adapterConfigPath,
        credentialRevision: 1,
        receiptPath: files.receiptPath,
        sampleQuery,
        fetch: healthFetch(),
        resolveHostname: publicResolver
      })
    ).rejects.toMatchObject({ code });
  });

  it("allows no comparables only with an explicit insufficient-data reason", async () => {
    const files = await fixtureFiles();
    const emptyHistorical = {
      ...historical,
      comparables: [],
      insufficient_data: []
    };
    await expect(
      probeTmsHttpV1({
        adapter: fixtureAdapter({
          searchHistoricalQuotes: vi.fn().mockResolvedValue(emptyHistorical)
        }),
        resolvedBaseUrl: "https://tms.client.example",
        resolvedHeaders: {},
        adapterConfigPath: files.adapterConfigPath,
        credentialRevision: 1,
        receiptPath: files.receiptPath,
        sampleQuery,
        fetch: healthFetch(),
        resolveHostname: publicResolver
      })
    ).rejects.toMatchObject({ code: "historical_quotes_insufficient_unexplained" });
  });

  it("bounds a fetch that ignores abort and never settles", async () => {
    const files = await fixtureFiles();
    const never = vi.fn(
      () => new Promise<Response>(() => undefined)
    ) as unknown as typeof fetch;
    await expect(
      probeTmsHttpV1({
        adapter: fixtureAdapter(),
        resolvedBaseUrl: "https://tms.client.example",
        resolvedHeaders: {},
        adapterConfigPath: files.adapterConfigPath,
        credentialRevision: 1,
        receiptPath: files.receiptPath,
        sampleQuery,
        fetch: never,
        resolveHostname: publicResolver,
        timeoutMs: 20
      })
    ).rejects.toMatchObject({ code: "health_timeout" });
  });

  it("rejects unsafe DNS, redirects, and an oversized health body", async () => {
    const files = await fixtureFiles();
    const common = {
      adapter: fixtureAdapter(),
      resolvedBaseUrl: "https://tms.client.example",
      resolvedHeaders: {},
      adapterConfigPath: files.adapterConfigPath,
      credentialRevision: 1,
      receiptPath: files.receiptPath,
      sampleQuery
    };
    await expect(
      probeTmsHttpV1({
        ...common,
        fetch: healthFetch(),
        resolveHostname: async () => ["127.0.0.1"]
      })
    ).rejects.toMatchObject({ code: "base_url_unsafe" });
    await expect(
      probeTmsHttpV1({
        ...common,
        fetch: vi.fn().mockResolvedValue(
          new Response(null, {
            status: 302,
            headers: { location: "http://127.0.0.1/private" }
          })
        ),
        resolveHostname: publicResolver
      })
    ).rejects.toMatchObject({ code: "health_redirect_rejected" });
    await expect(
      probeTmsHttpV1({
        ...common,
        fetch: healthFetch({ padding: "secret-body".repeat(1_000) }),
        resolveHostname: publicResolver,
        maxBodyBytes: 100
      })
    ).rejects.toMatchObject({ code: "health_body_too_large" });
  });
});

describe("configureTmsHttpV1", () => {
  it("separates credentials from config/receipt, carries the run env, and revises only on credential changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quoteops-tms-configure-"));
    temporaryDirectories.push(directory);
    const paths = {
      clientSecretsFile: join(directory, "secrets", "client.env"),
      tmsAdapterConfigFile: join(directory, "connectors", "tms-adapter.yaml"),
      tmsProbeFile: join(directory, "settings", "tms-probe.json"),
      settingsDir: join(directory, "settings")
    };
    const runtimeEnv = { EXISTING_SAFE_VALUE: "kept" };
    const fetchFn = vi.fn(async (request: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(
        request instanceof URL
          ? request.href
          : request instanceof Request
            ? request.url
            : String(request)
      );
      expect(init?.redirect).toBe("manual");
      expect((init?.headers as Record<string, string>).authorization).toMatch(
        /^Bearer token-/
      );
      if (url.pathname === "/quoteops/v1/health") {
        return new Response(JSON.stringify(v1Health()), { status: 200 });
      }
      if (url.pathname === "/quoteops/v1/historical-quotes/search") {
        return new Response(
          JSON.stringify([
            {
              origin_city: "Monterrey",
              origin_state: "NL",
              origin_country: "MX",
              destination_city: "Saltillo",
              destination_state: "COA",
              destination_country: "MX",
              vehicle_profile_id: "unit-1",
              rate_mxn: 1000,
              quoted_at: "2026-06-01T00:00:00.000Z"
            }
          ]),
          { status: 200 }
        );
      }
      if (url.pathname === "/quoteops/v1/units") {
        return new Response(
          JSON.stringify([
            {
              unit_id: "unit-1",
              current_lat: 25.6866,
              current_lng: -100.3161,
              status: "Available"
            }
          ]),
          { status: 200 }
        );
      }
      if (url.pathname === "/quoteops/v1/unit-performance") {
        return new Response(
          JSON.stringify([
            {
              unit_type: "unit-1",
              kpl_yield: 2.7,
              real_cost_per_km: 22
            }
          ]),
          { status: 200 }
        );
      }
      if (url.pathname === "/quoteops/v1/availability-zones") {
        return new Response(
          JSON.stringify([
            {
              zone_id: "north",
              city: "Monterrey",
              state: "NL",
              country: "MX",
              available_units: 1
            }
          ]),
          { status: 200 }
        );
      }
      throw new Error("unexpected endpoint");
    }) as unknown as typeof fetch;
    const context = {
      env: runtimeEnv,
      fetch: fetchFn,
      pinnedRequest: pinnedRequestFromFetch(fetchFn),
      paths,
      resolveHostname: publicResolver,
      now: () => new Date("2026-07-29T18:00:00.000Z")
    };

    const first = await configureTmsHttpV1(
      {
        baseUrl: "https://tms.client.example/",
        apiKey: "token-one",
        sampleQuery
      },
      context
    );
    expect(first.credentialRevision).toBe(1);
    expect(first.env).toEqual({
      EXISTING_SAFE_VALUE: "kept",
      TMS_HTTP_BASE_URL: "https://tms.client.example",
      TMS_API_KEY: "token-one"
    });
    expect(runtimeEnv).toEqual({ EXISTING_SAFE_VALUE: "kept" });
    expect(await readFile(paths.clientSecretsFile, "utf8")).toContain(
      'TMS_API_KEY="token-one"'
    );
    expect(await readFile(paths.tmsAdapterConfigFile, "utf8")).not.toContain(
      "token-one"
    );
    expect(await readFile(paths.tmsProbeFile, "utf8")).not.toContain(
      "token-one"
    );

    const unchanged = await configureTmsHttpV1(
      {
        baseUrl: "https://tms.client.example",
        apiKey: "token-one",
        sampleQuery
      },
      context
    );
    expect(unchanged.credentialRevision).toBe(1);
    const rotated = await configureTmsHttpV1(
      {
        baseUrl: "https://tms.client.example",
        apiKey: "token-two",
        sampleQuery
      },
      context
    );
    expect(rotated.credentialRevision).toBe(2);
    expect(rotated.env.TMS_API_KEY).toBe("token-two");
  });

  it.each([
    "tms_credential_revision",
    "tms_adapter_config",
    "tms_client_env"
  ])("leaves readiness false after a crash following %s rename", async (crashLabel) => {
    const directory = await mkdtemp(join(tmpdir(), "quoteops-tms-crash-"));
    temporaryDirectories.push(directory);
    const paths = {
      clientSecretsFile: join(directory, "secrets", "client.env"),
      tmsAdapterConfigFile: join(directory, "connectors", "tms-adapter.yaml"),
      tmsProbeFile: join(directory, "settings", "tms-probe.json"),
      settingsDir: join(directory, "settings")
    };
    const fetchFn = canonicalFixtureFetch();
    const baseContext = {
      env: {},
      fetch: fetchFn,
      pinnedRequest: pinnedRequestFromFetch(fetchFn),
      paths,
      resolveHostname: publicResolver
    };
    await configureTmsHttpV1(
      {
        baseUrl: "https://old-tms.client.example",
        apiKey: "old-token",
        sampleQuery
      },
      baseContext
    );

    await expect(
      configureTmsHttpV1(
        {
          baseUrl: "https://new-tms.client.example",
          apiKey: "new-token",
          sampleQuery
        },
        {
          ...baseContext,
          afterAtomicRename(label) {
            if (label === crashLabel) throw new Error("simulated_crash");
          }
        }
      )
    ).rejects.toThrow("simulated_crash");

    const credentialRevision = await readTmsCredentialRevision(
      join(paths.settingsDir, "tms-credential-revision")
    );
    expect(
      await hasMatchingTmsProbeReceipt({
        adapterConfigPath: paths.tmsAdapterConfigFile,
        receiptPath: paths.tmsProbeFile,
        credentialRevision,
        expectedContract: "quoteops-tms-http-v1"
      })
    ).toBe(false);
  });

  it("serializes two writers so generations cannot reuse a revision or mix env and receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quoteops-tms-writers-"));
    temporaryDirectories.push(directory);
    const paths = {
      clientSecretsFile: join(directory, "secrets", "client.env"),
      tmsAdapterConfigFile: join(directory, "connectors", "tms-adapter.yaml"),
      tmsProbeFile: join(directory, "settings", "tms-probe.json"),
      settingsDir: join(directory, "settings")
    };
    const fetchFn = canonicalFixtureFetch();
    const context = {
      env: {},
      fetch: fetchFn,
      pinnedRequest: pinnedRequestFromFetch(fetchFn),
      paths,
      resolveHostname: publicResolver
    };

    await Promise.all([
      configureTmsHttpV1(
        {
          baseUrl: "https://writer-a.client.example",
          apiKey: "token-a",
          sampleQuery
        },
        context
      ),
      configureTmsHttpV1(
        {
          baseUrl: "https://writer-b.client.example",
          apiKey: "token-b",
          sampleQuery
        },
        context
      )
    ]);

    const credentialRevision = await readTmsCredentialRevision(
      join(paths.settingsDir, "tms-credential-revision")
    );
    const configured = await readEnvFileValues(paths.clientSecretsFile);
    const receipt = JSON.parse(
      await readFile(paths.tmsProbeFile, "utf8")
    ) as {
      credential_revision: number;
      base_url_origin: string;
    };
    expect(credentialRevision).toBe(2);
    expect(receipt.credential_revision).toBe(2);
    expect(receipt.base_url_origin).toBe(
      configured.get("TMS_HTTP_BASE_URL")
    );
    expect([
      {
        baseUrl: "https://writer-a.client.example",
        apiKey: "token-a"
      },
      {
        baseUrl: "https://writer-b.client.example",
        apiKey: "token-b"
      }
    ]).toContainEqual({
      baseUrl: configured.get("TMS_HTTP_BASE_URL"),
      apiKey: configured.get("TMS_API_KEY")
    });
    expect(
      await hasMatchingTmsProbeReceipt({
        adapterConfigPath: paths.tmsAdapterConfigFile,
        receiptPath: paths.tmsProbeFile,
        credentialRevision,
        expectedContract: "quoteops-tms-http-v1"
      })
    ).toBe(true);
  });
});

describe("legacy custom HTTP probe and receipt matching", () => {
  it("requires health, canonical outputs, and an explicit write endpoint", async () => {
    const files = await fixtureFiles(false);
    const adapter = fixtureAdapter();
    const receipt = await probeLegacyCustomHttp({
      adapter,
      resolvedBaseUrl: "https://legacy.client.example",
      resolvedHeaders: {},
      adapterConfigPath: files.adapterConfigPath,
      credentialRevision: 4,
      receiptPath: files.receiptPath,
      sampleQuery,
      resolveHostname: publicResolver,
      now: () => new Date("2026-07-29T18:00:00.000Z")
    });

    expect(receipt.contract).toBe("legacy-custom-http-canonical-output-v1");
    expect(receipt.checks).toEqual({
      health: "ok",
      historical_quotes: "ok",
      units: "ok",
      unit_performance: "ok",
      availability_zones: "ok",
      write_quote_configured: "ok"
    });
    expect(adapter.healthCheck).toHaveBeenCalledOnce();
    expect(adapter.writeQuoteResult).not.toHaveBeenCalled();
  });

  it("fails closed for failed health, missing write endpoint, and malformed canonical output", async () => {
    const failedHealthFiles = await fixtureFiles(false);
    await expect(
      probeLegacyCustomHttp({
        adapter: fixtureAdapter({
          healthCheck: vi.fn().mockResolvedValue({
            ok: false,
            status: "failed",
            capabilities: defaultTmsAdapterCapabilities({ write_quote: true })
          })
        }),
        resolvedBaseUrl: "https://legacy.client.example",
        resolvedHeaders: {},
        adapterConfigPath: failedHealthFiles.adapterConfigPath,
        credentialRevision: 1,
        receiptPath: failedHealthFiles.receiptPath,
        sampleQuery,
        resolveHostname: publicResolver
      })
    ).rejects.toMatchObject({ code: "legacy_health_failed" });

    const missingWriteFiles = await fixtureFiles(false);
    const raw = await readFile(missingWriteFiles.adapterConfigPath, "utf8");
    await writeFile(
      missingWriteFiles.adapterConfigPath,
      raw.replace("write_quote_endpoint_path: /quotes\n", "")
    );
    await expect(
      probeLegacyCustomHttp({
        adapter: fixtureAdapter(),
        resolvedBaseUrl: "https://legacy.client.example",
        resolvedHeaders: {},
        adapterConfigPath: missingWriteFiles.adapterConfigPath,
        credentialRevision: 1,
        receiptPath: missingWriteFiles.receiptPath,
        sampleQuery,
        resolveHostname: publicResolver
      })
    ).rejects.toMatchObject({ code: "legacy_write_quote_not_configured" });

    const malformedFiles = await fixtureFiles(false);
    await expect(
      probeLegacyCustomHttp({
        adapter: fixtureAdapter({
          getUnits: vi.fn().mockResolvedValue([{ unit_id: "body-secret" }])
        }),
        resolvedBaseUrl: "https://legacy.client.example",
        resolvedHeaders: {},
        adapterConfigPath: malformedFiles.adapterConfigPath,
        credentialRevision: 1,
        receiptPath: malformedFiles.receiptPath,
        sampleQuery,
        resolveHostname: publicResolver
      })
    ).rejects.toMatchObject({ code: "units_invalid" });
  });

  it("matches only the exact config hash, revision, and receipt discriminator", async () => {
    const files = await fixtureFiles(false);
    const receipt = await probeLegacyCustomHttp({
      adapter: fixtureAdapter(),
      resolvedBaseUrl: "https://legacy.client.example",
      resolvedHeaders: {},
      adapterConfigPath: files.adapterConfigPath,
      credentialRevision: 7,
      receiptPath: files.receiptPath,
      sampleQuery,
      resolveHostname: publicResolver
    });
    expect(
      await hasMatchingTmsProbeReceipt({
        adapterConfigPath: files.adapterConfigPath,
        receiptPath: files.receiptPath,
        credentialRevision: 7,
        expectedContract: "legacy-custom-http-canonical-output-v1"
      })
    ).toBe(true);

    await writeFile(files.adapterConfigPath, "provider: http\nbase_url_env: CHANGED\n");
    expect(
      await hasMatchingTmsProbeReceipt({
        adapterConfigPath: files.adapterConfigPath,
        receiptPath: files.receiptPath,
        credentialRevision: 7,
        expectedContract: receipt.contract
      })
    ).toBe(false);

    const v1Files = await fixtureFiles();
    await writeFile(
      v1Files.receiptPath,
      JSON.stringify({
        ...receipt,
        contract: "quoteops-tms-http-v1",
        adapter_config_sha256: createHash("sha256")
          .update(await readFile(v1Files.adapterConfigPath))
          .digest("hex"),
        checks: {
          health: "ok",
          historical_quotes: "ok",
          units: "ok",
          unit_performance: "ok",
          availability_zones: "ok",
          write_quote_declared: "ok"
        }
      })
    );
    expect(
      await hasMatchingTmsProbeReceipt({
        adapterConfigPath: v1Files.adapterConfigPath,
        receiptPath: v1Files.receiptPath,
        credentialRevision: 7,
        expectedContract: "legacy-custom-http-canonical-output-v1"
      })
    ).toBe(false);
  });

  it("uses stable safe errors that never include credentials, URLs, or remote bodies", () => {
    const error = new TmsProbeError("health_invalid");
    expect(error.message).toBe("health_invalid");
    expect(JSON.stringify(error)).not.toContain("authorization");
  });
});
