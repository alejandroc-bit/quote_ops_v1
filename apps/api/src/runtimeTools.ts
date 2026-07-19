import { readFile, stat } from "node:fs/promises";
import { searchKnowledge } from "@quoteops/knowledge";
import { createChatModel, type QuoteWorkflowTools } from "@quoteops/agent";
import { getKnowledgeService } from "./knowledge/knowledgeService.js";
import type { HistoricalAnalysis } from "@quoteops/contracts";
import type { HistoricalContext, QuoteCoreInput, QuoteManifest } from "@quoteops/quote-core";
import { parse as parseYaml } from "yaml";
import {
  assertAgentToolAllowed,
  CachedTmsAdapter,
  createRedisCache,
  createSqlCacheFromEnv,
  createTieredCache,
  createTmsAdapterFromConfig,
  FileImportTmsAdapter,
  loadOpenRouterApiKey,
  loadSakbeApiKey,
  loadAgentRuntimeConfig,
  OpenRouterGuideClient,
  overlayTmsPerformance,
  SakbeRouteAdapter,
  type AgentRuntimeConfig,
  type HistoricalSearchQuery,
  type KeyValueCache,
  type TmsAdapter
} from "@quoteops/connectors";
import { z } from "zod";

export type ApplianceWorkflowToolsOptions = {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  fetch?: typeof fetch;
  cache?: KeyValueCache | null;
};

const DEFAULT_AGENT_CONFIG_PATH = "/opt/quoteops-v1/connectors/agent/agent-config.yaml";
const DEFAULT_ROUTE_CACHE_PATH = "/opt/quoteops-v1/connectors/sakbe/route-cache.json";

export function createApplianceWorkflowTools(
  options: ApplianceWorkflowToolsOptions = {}
): QuoteWorkflowTools {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const fetchFn = options.fetch ?? fetch;
  let agentConfigPromise: Promise<AgentRuntimeConfig> | null = null;
  let tmsAdapterPromise: Promise<TmsAdapter> | null = null;
  let cachePromise: Promise<KeyValueCache | null> | null = null;
  const routeAdapter = new SakbeRouteAdapter({
    cachePath: env.QUOTEOPS_ROUTE_CACHE_PATH || DEFAULT_ROUTE_CACHE_PATH,
    cacheMode: parseSakbeCacheMode(env.QUOTEOPS_SAKBE_CACHE_MODE),
    apiKey: env.INEGI_SAKBE_KEY || env.QUOTEOPS_SAKBE_API_KEY,
    apiKeyLoader: () =>
      loadSakbeApiKey({
        env,
        envFilePath: env.QUOTEOPS_SECRETS_ENV_FILE,
        keysPath: env.QUOTEOPS_SAKBE_KEYS_PATH || env.QUOTEOPS_LOCAL_KEYS_PATH
      }),
    fetch: fetchFn,
    liveEnabled: parseBoolean(env.QUOTEOPS_SAKBE_LIVE_ENABLED, true),
    timeoutMs: parsePositiveInt(env.SAKBE_TIMEOUT_MS),
    searchTimeoutMs: parsePositiveInt(env.SAKBE_SEARCH_TIMEOUT_MS),
    retryAttempts: parsePositiveInt(env.SAKBE_RETRY_ATTEMPTS),
    retryDelayMs: parsePositiveInt(env.SAKBE_RETRY_DELAY_MS),
    now
  });

  async function agentConfig(): Promise<AgentRuntimeConfig> {
    agentConfigPromise ??= loadAgentRuntimeConfig(
      env.QUOTEOPS_AGENT_CONFIG_PATH || DEFAULT_AGENT_CONFIG_PATH
    );
    return agentConfigPromise;
  }

  async function tmsAdapter(): Promise<TmsAdapter> {
    tmsAdapterPromise ??= createRuntimeTmsAdapter(env, fetchFn, await runtimeCache());
    return tmsAdapterPromise;
  }

  async function runtimeCache(): Promise<KeyValueCache | null> {
    cachePromise ??= options.cache !== undefined
      ? Promise.resolve(options.cache)
      : createRuntimeCache(env);
    return cachePromise;
  }

  return {
    resolveRoute: async (input) => {
      assertAgentToolAllowed({
        config: await agentConfig(),
        toolName: "route.resolve"
      });

      const cache = await runtimeCache();
      const key = routeCacheKey(input);
      if (cache) {
        const cached = await cache.get(key);
        if (cached) {
          try {
            return routeEvidenceSchema.parse(JSON.parse(cached));
          } catch {
            // Invalid external cache data is ignored; live/provider resolution remains authoritative.
          }
        }
      }
      const resolved = await routeAdapter.resolveRoute(input);
      await cache?.set(key, JSON.stringify(resolved), 7 * 24 * 60 * 60);
      return resolved;
    },
    searchHistorical: async (input) => {
      assertAgentToolAllowed({
        config: await agentConfig(),
        toolName: "tms.searchHistorical"
      });

      const analysis = await (await tmsAdapter()).searchHistoricalQuotes(
        historicalQueryFromQuoteInput(input, env, now())
      );
      return historicalContextFromAnalysis(analysis);
    },
    recommend: async ({ base_rate_mxn, historical_context, criteria_context }) => {
      const config = await agentConfig();

      if (config.model.provider === "deterministic") {
        return {
          recommended_rate_mxn: base_rate_mxn,
          reason: "Deterministic agent config preserves quote-core rate."
        };
      }

      if (config.model.provider === "openrouter") {
        const apiKeyEnv = config.model.api_key_env || "OPENROUTER_API_KEY";
        const apiKey = await loadOpenRouterApiKey({
          env,
          apiKeyEnv,
          envFilePath: env.QUOTEOPS_SECRETS_ENV_FILE,
          keysPath: env.QUOTEOPS_OPENROUTER_KEYS_PATH || env.QUOTEOPS_LOCAL_KEYS_PATH
        });
        if (!apiKey) {
          throw new Error(`OpenRouter API key is missing: ${apiKeyEnv}`);
        }

        try {
          return await new OpenRouterGuideClient({
            apiKey,
            modelName: config.model.model_name,
            temperature: config.model.temperature,
            fetch: fetchFn
          }).recommend({ base_rate_mxn, historical_context, criteria_context });
        } catch (error) {
          throw new Error(
            `OpenRouter guide failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      if (config.model.provider === "openai") {
        const apiKeyEnv = config.model.api_key_env;
        if (!apiKeyEnv || !env[apiKeyEnv]) {
          throw new Error(`Agent model API key env is missing: ${apiKeyEnv ?? "api_key_env"}`);
        }

        try {
          const model = createChatModel(
            {
              provider: "openai",
              model_name: config.model.model_name,
              api_key_env: apiKeyEnv,
              base_url: config.model.base_url
            },
            env
          );
          const response = await model.invoke([
            {
              role: "system",
              content:
                "You are a pricing guide for a logistics quoting appliance. Explain risks and context briefly. Never change the deterministic quote-core rate."
            },
            {
              role: "user",
              content: JSON.stringify({ base_rate_mxn, historical_context, criteria_context })
            }
          ]);
          const text =
            typeof response.content === "string" ? response.content : JSON.stringify(response.content);
          const reason = text.trim().slice(0, 1200);
          return {
            recommended_rate_mxn: base_rate_mxn,
            reason: reason || "Model returned no text; quote-core rate preserved."
          };
        } catch (error) {
          throw new Error(
            `Chat model guide failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      const keyEnv = config.model.api_key_env;
      if (keyEnv && !env[keyEnv]) {
        throw new Error(`Agent model API key env is missing: ${keyEnv}`);
      }

      throw new Error(`Agent model provider is not enabled in this appliance: ${config.model.provider}`);
    },
    writeback: async ({ quote, recommendation }) => {
      const config = await agentConfig();
      assertAgentToolAllowed({
        config,
        toolName: "tms.writeQuoteResult"
      });

      return (await tmsAdapter()).writeQuoteResult({
        quote_id: quote.quote_id,
        rfq_id: quote.quote_id.replace(/^quote-v2-/, "").replace(/-L\d{2,}$/, ""),
        lane_id: quote.quote_id.replace(/^quote-v2-/, ""),
        rate_mxn: recommendation.recommended_rate_mxn,
        currency: "MXN",
        metadata: {
          quote_core_version: quote.quote_core_version,
          pricing_model: quote.pricing_model,
          route_source: quote.route_source
        }
      });
    },
    getUnitPerformance: async () => {
      assertAgentToolAllowed({
        config: await agentConfig(),
        toolName: "tms.searchHistorical"
      });
      return (await tmsAdapter()).getUnitPerformance();
    },
    getUnits: async () => {
      assertAgentToolAllowed({ config: await agentConfig(), toolName: "tms.searchHistorical" });
      return (await tmsAdapter()).getUnits();
    },
    getAvailabilityZones: async () => {
      assertAgentToolAllowed({ config: await agentConfig(), toolName: "tms.searchHistorical" });
      return (await tmsAdapter()).getAvailabilityZones();
    },
    retrieveKnowledge: async (query, clientId) => {
      try {
        assertAgentToolAllowed({ config: await agentConfig(), toolName: "knowledge.search" });
        const service = await getKnowledgeService(env, fetchFn);
        if (!service?.embed) return [];
        const hits = await searchKnowledge({
          repo: service.repo,
          client_id: clientId,
          query,
          embed: service.embed,
          k: 4
        });
        return hits.map((hit) => ({ chunk_id: hit.chunk_id, text: hit.text }));
      } catch {
        // knowledge is best-effort context for the guide; never block a quote
        return [];
      }
    }
  };
}

/**
 * Overlays fresh TMS unit yields onto a manifest when any profile opts in with
 * `performance_source: tms`. A TMS failure keeps the static manifest and
 * returns the affected profile ids so the caller can flag them for review —
 * rendimientos never silently go stale.
 */
export async function resolveOverlaidManifest(
  manifest: QuoteManifest,
  tools: QuoteWorkflowTools
): Promise<{ manifest: QuoteManifest; reviewReasons: string[] }> {
  const needsOverlay = manifest.vehicle_profiles.some(
    (profile) => profile.performance_source === "tms"
  );
  if (!needsOverlay || !tools.getUnitPerformance) {
    return { manifest, reviewReasons: [] };
  }

  try {
    const performance = await tools.getUnitPerformance();
    const result = overlayTmsPerformance(manifest, performance);
    return {
      manifest: result.manifest,
      reviewReasons: result.stale.length > 0 ? ["tms_performance_stale"] : []
    };
  } catch {
    return { manifest, reviewReasons: ["tms_performance_stale"] };
  }
}

async function createRuntimeTmsAdapter(
  env: NodeJS.ProcessEnv,
  fetchFn?: typeof fetch,
  cache?: KeyValueCache | null
): Promise<TmsAdapter> {
  const base = await createBaseTmsAdapter(env, fetchFn);
  return cache ? new CachedTmsAdapter(base, cache) : base;
}

async function createBaseTmsAdapter(
  env: NodeJS.ProcessEnv,
  fetchFn?: typeof fetch
): Promise<TmsAdapter> {
  if (env.QUOTEOPS_TMS_ADAPTER_CONFIG_PATH) {
    return createTmsAdapterFromConfig(env.QUOTEOPS_TMS_ADAPTER_CONFIG_PATH, { env, fetch: fetchFn });
  }

  return new FileImportTmsAdapter({
    rfqsPath: env.QUOTEOPS_TMS_RFQS_PATH,
    historicalQuotesPath: env.QUOTEOPS_TMS_HISTORICAL_QUOTES_PATH,
    historicalShipmentsPath: env.QUOTEOPS_TMS_HISTORICAL_SHIPMENTS_PATH,
    customersPath: env.QUOTEOPS_TMS_CUSTOMERS_PATH,
    agreementsPath: env.QUOTEOPS_TMS_AGREEMENTS_PATH,
    unitPositionsPath: env.QUOTEOPS_TMS_UNIT_POSITIONS_PATH,
    unitsPath: env.QUOTEOPS_TMS_UNITS_PATH,
    performancePath: env.QUOTEOPS_TMS_PERFORMANCE_PATH,
    availabilityZonesPath: env.QUOTEOPS_TMS_AVAILABILITY_ZONES_PATH,
    quoteWritebacksPath: env.QUOTEOPS_TMS_QUOTE_WRITEBACKS_PATH,
    statusWritebacksPath: env.QUOTEOPS_TMS_STATUS_WRITEBACKS_PATH
  });
}

// SQL is the durable client-owned tier; optional Redis is the hot tier.
// Either cache can fail closed to pass-through without blocking quote execution.
async function createRuntimeCache(env: NodeJS.ProcessEnv): Promise<KeyValueCache | null> {
  const [sql, redis] = await Promise.all([
    createSqlCacheFromEnv(env),
    env.REDIS_URL?.trim() ? createRedisCache(env.REDIS_URL.trim()) : Promise.resolve(null)
  ]);
  if (redis && sql) return createTieredCache(redis, sql);
  return redis ?? sql;
}

const routeEvidenceSchema = z
  .object({
    status: z.enum(["resolved", "missing", "failed"]),
    source: z.enum(["sakbe", "manual", "tms", "mock"]),
    km_loaded: z.number().nullable(),
    estimated_minutes: z.number().nullable(),
    tolls_mxn: z.number().nullable(),
    requires_return_route: z.boolean(),
    km_return: z.number().nullable().optional(),
    return_tolls_mxn: z.number().nullable().optional()
  })
  .strict();

function routeCacheKey(input: QuoteCoreInput["rfq"]): string {
  return [
    "sakbe-route-v1",
    input.origin.city,
    input.origin.state,
    input.destination.city,
    input.destination.state,
    input.vehicle_profile_id,
    input.service.route_policy,
    input.service.return_policy
  ]
    .map((part) => String(part).trim().toLowerCase())
    .join(":");
}

const manifestCache = new Map<string, { mtimeMs: number; manifest: QuoteManifest | null }>();

/**
 * Reads the client manifest, re-parsing only when the file's mtime changes.
 * This lets the onboarding CLI add a vehicle profile (write the manifest) and
 * have the running appliance pick it up on the next RFQ, without a restart.
 */
export async function loadApplianceManifest(path?: string): Promise<QuoteManifest | null> {
  if (!path) {
    return null;
  }

  let mtimeMs: number | null = null;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      manifestCache.delete(path);
      return null;
    }
    throw error;
  }

  const cached = manifestCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.manifest;
  }

  const raw = await readFile(path, "utf8");
  const manifest = raw.trim()
    ? ((path.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw)) as QuoteManifest)
    : null;
  manifestCache.set(path, { mtimeMs, manifest });
  return manifest;
}

function historicalQueryFromQuoteInput(
  input: QuoteCoreInput,
  env: NodeJS.ProcessEnv,
  now: Date
): HistoricalSearchQuery {
  return {
    request_id: input.rfq.lane_id,
    origin: input.rfq.origin,
    destination: input.rfq.destination,
    vehicle_profile_id: input.rfq.vehicle_profile_id,
    equipment_request: input.rfq.vehicle_profile_id,
    customer_id: null,
    customer_type: null,
    cargo: {
      commodity: input.rfq.cargo.commodity,
      commodity_category: input.rfq.cargo.commodity_category,
      sector: input.rfq.cargo.sector,
      weight_kg: input.rfq.cargo.weight_kg,
      hazmat: input.rfq.cargo.hazmat ?? false
    },
    service_type: input.rfq.service.route_policy,
    time_window: {
      from: env.QUOTEOPS_HISTORICAL_FROM || dateOnly(addDays(now, -365)),
      to: env.QUOTEOPS_HISTORICAL_TO || dateOnly(now)
    }
  };
}

function historicalContextFromAnalysis(analysis: HistoricalAnalysis): HistoricalContext {
  const selected =
    analysis.comparables.find((comparable) => comparable.layer === "route_unit_cost") ??
    analysis.comparables[0];

  return {
    selected_layer: selected?.layer ?? "unavailable",
    median_rate_mxn: selected?.median_rate_mxn,
    max_rate_mxn: selected?.max_rate_mxn,
    comparables: analysis.comparables,
    insufficient_data: analysis.insufficient_data,
    time_window: analysis.time_window
  };
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseSakbeCacheMode(value: string | undefined): "cache_first" | "live_only" {
  return value === "live_only" ? "live_only" : "cache_first";
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
