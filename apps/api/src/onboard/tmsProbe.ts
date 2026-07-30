import { createHash } from "node:crypto";
import { resolve4, resolve6 } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import {
  historicalAnalysisSchema,
  TMS_HTTP_V1_CONTRACT,
  TMS_HTTP_V1_PATHS,
  tmsCanonicalAvailabilityZoneSchema,
  tmsCanonicalPerformanceSchema,
  tmsCanonicalUnitSchema,
  tmsHttpV1HealthSchema
} from "@quoteops/contracts";
import {
  createTmsAdapterFromConfig,
  loadTmsAdapterConfig,
  type HistoricalSearchQuery,
  type TmsAdapter,
  type TmsAdapterFactoryConfig
} from "@quoteops/connectors";
import { z } from "zod";
import { join } from "node:path";
import {
  isPublicInternetAddress,
  validatePublicHostname
} from "./cloudflareStep.js";
import {
  atomicWriteJson,
  atomicWriteText,
  buildTmsAdapterYaml,
  readEnvFileValues,
  readSingleLineSecret,
  updateAllowedEnv,
  validateTmsBaseUrl
} from "./onboardConfig.js";
import type { SecretFileRef } from "./onboardingFlow.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const LEGACY_CONTRACT = "legacy-custom-http-canonical-output-v1" as const;

type TmsProbeReceiptBase = {
  adapter_config_sha256: string;
  credential_revision: number;
  base_url_origin: string;
  validated_at: string;
};

export type TmsHttpV1ProbeReceipt = TmsProbeReceiptBase & {
  contract: typeof TMS_HTTP_V1_CONTRACT;
  checks: {
    health: "ok";
    historical_quotes: "ok";
    units: "ok";
    unit_performance: "ok";
    availability_zones: "ok";
    write_quote_declared: "ok";
  };
};

export type LegacyCustomHttpProbeReceipt = TmsProbeReceiptBase & {
  contract: typeof LEGACY_CONTRACT;
  checks: {
    health: "ok";
    historical_quotes: "ok";
    units: "ok";
    unit_performance: "ok";
    availability_zones: "ok";
    write_quote_configured: "ok";
  };
};

export type TmsProbeReceipt =
  | TmsHttpV1ProbeReceipt
  | LegacyCustomHttpProbeReceipt;

export type TmsProbeInput = {
  adapter: TmsAdapter;
  resolvedBaseUrl: string;
  resolvedHeaders: Record<string, string>;
  adapterConfigPath: string;
  credentialRevision: number;
  receiptPath: string;
  sampleQuery: HistoricalSearchQuery;
  fetch?: typeof fetch;
  now?: () => Date;
  resolveHostname?: (hostname: string) => Promise<string[]>;
  timeoutMs?: number;
  maxBodyBytes?: number;
  acceptanceMode?: string;
};

export type ConfigureTmsHttpV1Input = {
  baseUrl: string;
  apiKey: string | SecretFileRef;
  sampleQuery: HistoricalSearchQuery;
};

export type ConfigureLegacyCustomHttpInput = {
  baseUrl: string;
  apiKey: string | SecretFileRef;
  endpoints: Record<string, string>;
  sampleQuery: HistoricalSearchQuery;
};

export type ConfigureTmsHttpV1Context = {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  paths: {
    clientSecretsFile: string;
    tmsAdapterConfigFile: string;
    tmsProbeFile: string;
    settingsDir: string;
  };
  resolveHostname?: (hostname: string) => Promise<string[]>;
  now?: () => Date;
  httpProbeTimeoutMs?: number;
  answersRoot?: string;
  afterSecretOpen?: () => void | Promise<void>;
  afterAtomicRename?: (label: string) => void | Promise<void>;
};

export class TmsProbeError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "TmsProbeError";
    this.code = code;
  }
}

export async function configureTmsHttpV1(
  input: ConfigureTmsHttpV1Input,
  context: ConfigureTmsHttpV1Context
): Promise<{
  adapter: TmsAdapter;
  env: Record<string, string | undefined>;
  credentialRevision: number;
  receipt: TmsHttpV1ProbeReceipt;
}> {
  const acceptanceMode = context.env.QUOTEOPS_ACCEPTANCE_MODE;
  const baseUrl = validateTmsBaseUrl(input.baseUrl, acceptanceMode);
  const apiKey = await readSingleLineSecret(input.apiKey, context);
  const current = await readEnvFileValues(context.paths.clientSecretsFile);
  const credentialChanged =
    current.get("TMS_HTTP_BASE_URL") !== baseUrl ||
    current.get("TMS_API_KEY") !== apiKey;
  const revisionPath = join(
    context.paths.settingsDir,
    "tms-credential-revision"
  );
  const currentRevision = await readTmsCredentialRevision(revisionPath);
  const credentialRevision =
    credentialChanged || currentRevision < 1
      ? currentRevision + 1
      : currentRevision;

  await updateAllowedEnv(
    context.paths.clientSecretsFile,
    {
      TMS_HTTP_BASE_URL: baseUrl,
      TMS_API_KEY: apiKey
    },
    ["TMS_HTTP_BASE_URL", "TMS_API_KEY"],
    () => context.afterAtomicRename?.("tms_client_env")
  );
  await atomicWriteText(
    context.paths.tmsAdapterConfigFile,
    buildTmsAdapterYaml({
      provider: "http",
      contract: TMS_HTTP_V1_CONTRACT,
      base_url_env: "TMS_HTTP_BASE_URL",
      api_key_env: "TMS_API_KEY"
    }),
    {
      mode: 0o600,
      afterRename: () => context.afterAtomicRename?.("tms_adapter_config")
    }
  );
  if (credentialChanged || currentRevision < 1) {
    await atomicWriteJson(
      revisionPath,
      {
        schema_version: 1,
        credential_revision: credentialRevision
      },
      {
        mode: 0o600,
        afterRename: () =>
          context.afterAtomicRename?.("tms_credential_revision")
      }
    );
  }

  const tmsEnv = {
    ...context.env,
    TMS_HTTP_BASE_URL: baseUrl,
    TMS_API_KEY: apiKey
  };
  const safeFetch = buildSafeTmsFetch({
    baseUrlOrigin: baseUrl,
    fetch: context.fetch,
    resolveHostname: context.resolveHostname,
    acceptanceMode,
    timeoutMs: context.httpProbeTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    maximumBodyBytes: DEFAULT_MAX_BODY_BYTES
  });
  const adapter = await createTmsAdapterFromConfig(
    context.paths.tmsAdapterConfigFile,
    { env: tmsEnv, fetch: safeFetch }
  );
  const receipt = await probeTmsHttpV1({
    adapter,
    resolvedBaseUrl: baseUrl,
    resolvedHeaders: { authorization: `Bearer ${apiKey}` },
    adapterConfigPath: context.paths.tmsAdapterConfigFile,
    credentialRevision,
    receiptPath: context.paths.tmsProbeFile,
    sampleQuery: input.sampleQuery,
    fetch: safeFetch,
    resolveHostname: context.resolveHostname,
    now: context.now,
    timeoutMs: context.httpProbeTimeoutMs,
    acceptanceMode
  });
  return { adapter, env: tmsEnv, credentialRevision, receipt };
}

export async function configureLegacyCustomHttp(
  input: ConfigureLegacyCustomHttpInput,
  context: ConfigureTmsHttpV1Context
): Promise<{
  adapter: TmsAdapter;
  env: Record<string, string | undefined>;
  credentialRevision: number;
  receipt: LegacyCustomHttpProbeReceipt;
}> {
  const acceptanceMode = context.env.QUOTEOPS_ACCEPTANCE_MODE;
  const baseUrl = validateTmsBaseUrl(input.baseUrl, acceptanceMode);
  const apiKey = await readSingleLineSecret(input.apiKey, context);
  const current = await readEnvFileValues(context.paths.clientSecretsFile);
  const credentialChanged =
    current.get("TMS_HTTP_BASE_URL") !== baseUrl ||
    current.get("TMS_API_KEY") !== apiKey;
  const revisionPath = join(
    context.paths.settingsDir,
    "tms-credential-revision"
  );
  const currentRevision = await readTmsCredentialRevision(revisionPath);
  const credentialRevision =
    credentialChanged || currentRevision < 1
      ? currentRevision + 1
      : currentRevision;
  await updateAllowedEnv(
    context.paths.clientSecretsFile,
    { TMS_HTTP_BASE_URL: baseUrl, TMS_API_KEY: apiKey },
    ["TMS_HTTP_BASE_URL", "TMS_API_KEY"],
    () => context.afterAtomicRename?.("tms_client_env")
  );
  await atomicWriteText(
    context.paths.tmsAdapterConfigFile,
    buildTmsAdapterYaml({
      provider: "http",
      base_url_env: "TMS_HTTP_BASE_URL",
      headers: { authorization: "Bearer ${TMS_API_KEY}" },
      endpoints: input.endpoints
    }),
    {
      mode: 0o600,
      afterRename: () => context.afterAtomicRename?.("tms_adapter_config")
    }
  );
  if (credentialChanged || currentRevision < 1) {
    await atomicWriteJson(
      revisionPath,
      { schema_version: 1, credential_revision: credentialRevision },
      { mode: 0o600 }
    );
  }
  const tmsEnv = {
    ...context.env,
    TMS_HTTP_BASE_URL: baseUrl,
    TMS_API_KEY: apiKey
  };
  const safeFetch = buildSafeTmsFetch({
    baseUrlOrigin: baseUrl,
    fetch: context.fetch,
    resolveHostname: context.resolveHostname,
    acceptanceMode,
    timeoutMs: context.httpProbeTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    maximumBodyBytes: DEFAULT_MAX_BODY_BYTES
  });
  const adapter = await createTmsAdapterFromConfig(
    context.paths.tmsAdapterConfigFile,
    { env: tmsEnv, fetch: safeFetch }
  );
  const receipt = await probeLegacyCustomHttp({
    adapter,
    resolvedBaseUrl: baseUrl,
    resolvedHeaders: { authorization: `Bearer ${apiKey}` },
    adapterConfigPath: context.paths.tmsAdapterConfigFile,
    credentialRevision,
    receiptPath: context.paths.tmsProbeFile,
    sampleQuery: input.sampleQuery,
    resolveHostname: context.resolveHostname,
    now: context.now,
    timeoutMs: context.httpProbeTimeoutMs,
    acceptanceMode
  });
  return { adapter, env: tmsEnv, credentialRevision, receipt };
}

const receiptOriginSchema = z.string().url().refine((value) => {
  try {
    const url = new URL(value);
    return (
      url.origin === value &&
      (url.protocol === "https:" ||
        value === "http://host.docker.internal:19091")
    );
  } catch {
    return false;
  }
}, "safe origin required");

const receiptBaseSchema = z.object({
  adapter_config_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  credential_revision: z.number().int().min(1),
  base_url_origin: receiptOriginSchema,
  validated_at: z.string().datetime({ offset: true })
});

const v1ReceiptSchema = receiptBaseSchema
  .extend({
    contract: z.literal(TMS_HTTP_V1_CONTRACT),
    checks: z
      .object({
        health: z.literal("ok"),
        historical_quotes: z.literal("ok"),
        units: z.literal("ok"),
        unit_performance: z.literal("ok"),
        availability_zones: z.literal("ok"),
        write_quote_declared: z.literal("ok")
      })
      .strict()
  })
  .strict();

const legacyReceiptSchema = receiptBaseSchema
  .extend({
    contract: z.literal(LEGACY_CONTRACT),
    checks: z
      .object({
        health: z.literal("ok"),
        historical_quotes: z.literal("ok"),
        units: z.literal("ok"),
        unit_performance: z.literal("ok"),
        availability_zones: z.literal("ok"),
        write_quote_configured: z.literal("ok")
      })
      .strict()
  })
  .strict();

const receiptSchema = z.discriminatedUnion("contract", [
  v1ReceiptSchema,
  legacyReceiptSchema
]);

export async function probeTmsHttpV1(
  input: TmsProbeInput
): Promise<TmsHttpV1ProbeReceipt> {
  const prepared = await prepareProbe(input);
  assertCanonicalV1Config(prepared.config);
  const response = await fetchHealth(input, prepared.baseUrlOrigin);
  if (response.status >= 300 && response.status < 400) {
    throw new TmsProbeError("health_redirect_rejected");
  }
  if (!response.ok) {
    throw new TmsProbeError(`health_http_${response.status}`);
  }
  const healthBody = await boundedOperation(
    "health_body",
    readJsonBodyBounded(
      response,
      input.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
    ),
    input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    () => void response.body?.cancel().catch(() => undefined)
  );
  if (
    !isRecord(healthBody) ||
    !isRecord(healthBody.capabilities) ||
    healthBody.capabilities.write_quote !== true
  ) {
    throw new TmsProbeError("write_quote_not_declared");
  }
  const health = parseSafe(
    tmsHttpV1HealthSchema,
    healthBody,
    "health_invalid"
  );
  if (!health.capabilities.write_quote) {
    throw new TmsProbeError("write_quote_not_declared");
  }

  await validateCanonicalOutputs(input);
  const receipt: TmsHttpV1ProbeReceipt = {
    contract: TMS_HTTP_V1_CONTRACT,
    adapter_config_sha256: prepared.adapterConfigSha256,
    credential_revision: input.credentialRevision,
    base_url_origin: prepared.baseUrlOrigin,
    validated_at: (input.now?.() ?? new Date()).toISOString(),
    checks: {
      health: "ok",
      historical_quotes: "ok",
      units: "ok",
      unit_performance: "ok",
      availability_zones: "ok",
      write_quote_declared: "ok"
    }
  };
  await persistReceipt(input.receiptPath, receipt);
  return receipt;
}

export async function probeLegacyCustomHttp(
  input: TmsProbeInput
): Promise<LegacyCustomHttpProbeReceipt> {
  const prepared = await prepareProbe(input);
  assertLegacyCustomConfig(prepared.config);
  const health = await boundedOperation(
    "legacy_health",
    input.adapter.healthCheck(),
    input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );
  if (
    health.ok !== true ||
    health.status !== "ok" ||
    health.capabilities?.write_quote !== true
  ) {
    throw new TmsProbeError("legacy_health_failed");
  }

  await validateCanonicalOutputs(input);
  const receipt: LegacyCustomHttpProbeReceipt = {
    contract: LEGACY_CONTRACT,
    adapter_config_sha256: prepared.adapterConfigSha256,
    credential_revision: input.credentialRevision,
    base_url_origin: prepared.baseUrlOrigin,
    validated_at: (input.now?.() ?? new Date()).toISOString(),
    checks: {
      health: "ok",
      historical_quotes: "ok",
      units: "ok",
      unit_performance: "ok",
      availability_zones: "ok",
      write_quote_configured: "ok"
    }
  };
  await persistReceipt(input.receiptPath, receipt);
  return receipt;
}

export async function hasMatchingTmsProbeReceipt(input: {
  adapterConfigPath: string;
  receiptPath: string;
  credentialRevision: number;
  expectedContract:
    | typeof TMS_HTTP_V1_CONTRACT
    | typeof LEGACY_CONTRACT;
}): Promise<boolean> {
  try {
    const [rawReceipt, adapterConfigBytes] = await Promise.all([
      readFile(input.receiptPath, "utf8"),
      readFile(input.adapterConfigPath)
    ]);
    const receipt = receiptSchema.parse(JSON.parse(rawReceipt));
    return (
      receipt.contract === input.expectedContract &&
      receipt.credential_revision === input.credentialRevision &&
      receipt.adapter_config_sha256 === sha256(adapterConfigBytes)
    );
  } catch {
    return false;
  }
}

async function prepareProbe(input: TmsProbeInput): Promise<{
  baseUrlOrigin: string;
  adapterConfigSha256: string;
  config: TmsAdapterFactoryConfig;
}> {
  if (
    !Number.isSafeInteger(input.credentialRevision) ||
    input.credentialRevision < 1
  ) {
    throw new TmsProbeError("credential_revision_invalid");
  }
  let baseUrlOrigin: string;
  try {
    baseUrlOrigin = validateTmsBaseUrl(
      input.resolvedBaseUrl,
      input.acceptanceMode
    );
  } catch {
    throw new TmsProbeError("base_url_invalid");
  }
  await assertSafeOrigin(
    new URL(baseUrlOrigin),
    input.resolveHostname,
    input.acceptanceMode
  );
  let config: TmsAdapterFactoryConfig;
  let configBytes: Buffer;
  try {
    [config, configBytes] = await Promise.all([
      loadTmsAdapterConfig(input.adapterConfigPath),
      readFile(input.adapterConfigPath)
    ]);
  } catch {
    throw new TmsProbeError("adapter_config_invalid");
  }
  return {
    baseUrlOrigin,
    adapterConfigSha256: sha256(configBytes),
    config
  };
}

function assertCanonicalV1Config(config: TmsAdapterFactoryConfig): void {
  if (
    config.provider !== "http" ||
    config.contract !== TMS_HTTP_V1_CONTRACT ||
    config.health_endpoint_path !== TMS_HTTP_V1_PATHS.health ||
    config.search_historical_quotes_endpoint_path !==
      TMS_HTTP_V1_PATHS.historical_quotes ||
    config.get_units_endpoint_path !== TMS_HTTP_V1_PATHS.units ||
    config.get_unit_performance_endpoint_path !==
      TMS_HTTP_V1_PATHS.unit_performance ||
    config.get_availability_zones_endpoint_path !==
      TMS_HTTP_V1_PATHS.availability_zones ||
    config.write_quote_endpoint_path !== TMS_HTTP_V1_PATHS.write_quote
  ) {
    throw new TmsProbeError("adapter_config_contract_mismatch");
  }
}

function assertLegacyCustomConfig(config: TmsAdapterFactoryConfig): void {
  if (
    config.provider !== "http" ||
    config.contract !== undefined ||
    !config.health_endpoint_path ||
    !config.search_historical_quotes_endpoint_path ||
    !config.get_units_endpoint_path ||
    !config.get_unit_performance_endpoint_path ||
    !config.get_availability_zones_endpoint_path
  ) {
    throw new TmsProbeError("legacy_adapter_config_invalid");
  }
  if (!config.write_quote_endpoint_path) {
    throw new TmsProbeError("legacy_write_quote_not_configured");
  }
}

async function fetchHealth(
  input: TmsProbeInput,
  baseUrlOrigin: string
): Promise<Response> {
  const controller = new AbortController();
  try {
    return await boundedOperation(
      "health",
      (input.fetch ?? fetch)(
        new URL(TMS_HTTP_V1_PATHS.health, `${baseUrlOrigin}/`),
        {
          method: "GET",
          headers: input.resolvedHeaders,
          redirect: "manual",
          signal: controller.signal
        }
      ),
      input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      () => controller.abort()
    );
  } catch (error) {
    if (error instanceof TmsProbeError) throw error;
    throw new TmsProbeError("health_unreachable");
  }
}

async function validateCanonicalOutputs(input: TmsProbeInput): Promise<void> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const [historicalValue, unitsValue, performanceValue, zonesValue] =
    await Promise.all([
      boundedAdapterOperation(
        "historical_quotes",
        input.adapter.searchHistoricalQuotes(input.sampleQuery),
        timeoutMs
      ),
      boundedAdapterOperation("units", input.adapter.getUnits(), timeoutMs),
      boundedAdapterOperation(
        "unit_performance",
        input.adapter.getUnitPerformance(),
        timeoutMs
      ),
      boundedAdapterOperation(
        "availability_zones",
        input.adapter.getAvailabilityZones(),
        timeoutMs
      )
    ]);

  const historical = parseSafe(
    historicalAnalysisSchema,
    historicalValue,
    "historical_quotes_invalid"
  );
  const units = parseSafe(
    z.array(tmsCanonicalUnitSchema),
    unitsValue,
    "units_invalid"
  );
  const performance = parseSafe(
    z.array(tmsCanonicalPerformanceSchema),
    performanceValue,
    "unit_performance_invalid"
  );
  const zones = parseSafe(
    z.array(tmsCanonicalAvailabilityZoneSchema),
    zonesValue,
    "availability_zones_invalid"
  );

  if (
    historical.comparables.length === 0 &&
    historical.insufficient_data.length === 0
  ) {
    throw new TmsProbeError(
      "historical_quotes_insufficient_unexplained"
    );
  }
  if (units.length === 0) throw new TmsProbeError("units_empty");
  const unitIds = new Set(units.map((unit) => unit.unit_id));
  if (!performance.some((row) => unitIds.has(row.unit_type))) {
    throw new TmsProbeError("unit_performance_unmatched");
  }
  if (zones.length === 0) {
    throw new TmsProbeError("availability_zones_empty");
  }
}

async function boundedAdapterOperation<T>(
  endpoint: string,
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  try {
    return await boundedOperation(endpoint, promise, timeoutMs);
  } catch (error) {
    if (error instanceof TmsProbeError) throw error;
    throw new TmsProbeError(`${endpoint}_invalid`);
  }
}

async function boundedOperation<T>(
  endpoint: string,
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new TmsProbeError(`${endpoint}_timeout`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readJsonBodyBounded(
  response: Response,
  maximumBytes: number
): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new TmsProbeError("health_body_too_large");
  }
  if (!response.body) throw new TmsProbeError("health_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new TmsProbeError("health_body_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total
  );
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TmsProbeError("health_invalid");
  }
}

function buildSafeTmsFetch(input: {
  baseUrlOrigin: string;
  fetch: typeof fetch;
  resolveHostname?: (hostname: string) => Promise<string[]>;
  acceptanceMode?: string;
  timeoutMs: number;
  maximumBodyBytes: number;
}): typeof fetch {
  return (async (
    request: URL | RequestInfo,
    init: RequestInit = {}
  ): Promise<Response> => {
    let url: URL;
    try {
      url = new URL(
        request instanceof URL
          ? request.href
          : request instanceof Request
            ? request.url
            : String(request)
      );
    } catch {
      throw new TmsProbeError("request_url_invalid");
    }
    if (url.origin !== input.baseUrlOrigin) {
      throw new TmsProbeError("request_origin_changed");
    }
    await assertSafeOrigin(
      url,
      input.resolveHostname,
      input.acceptanceMode
    );
    const response = await input.fetch(url, {
      ...init,
      redirect: "manual"
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new TmsProbeError("request_redirect_rejected");
    }
    if (!response.body) return response;
    const bytes = await boundedOperation(
      "response_body",
      readResponseBytesBounded(response, input.maximumBodyBytes),
      input.timeoutMs,
      () => void response.body?.cancel().catch(() => undefined)
    );
    return new Response(Buffer.from(bytes), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }) as typeof fetch;
}

async function readResponseBytesBounded(
  response: Response,
  maximumBytes: number
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new TmsProbeError("response_body_too_large");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new TmsProbeError("response_body_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total
  );
}

async function assertSafeOrigin(
  url: URL,
  resolver: ((hostname: string) => Promise<string[]>) | undefined,
  acceptanceMode: string | undefined
): Promise<void> {
  if (
    acceptanceMode === "macbook" &&
    url.origin === "http://host.docker.internal:19091"
  ) {
    return;
  }
  try {
    if (isIP(url.hostname)) {
      if (!isPublicInternetAddress(url.hostname)) {
        throw new Error("unsafe");
      }
      return;
    }
    await validatePublicHostname(
      url.hostname,
      resolver ?? resolveInternetAddresses
    );
  } catch {
    throw new TmsProbeError("base_url_unsafe");
  }
}

async function resolveInternetAddresses(hostname: string): Promise<string[]> {
  const [ipv4, ipv6] = await Promise.all([
    resolve4(hostname).catch(() => []),
    resolve6(hostname).catch(() => [])
  ]);
  return [...ipv4, ...ipv6];
}

function parseSafe<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  value: unknown,
  code: string
): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new TmsProbeError(code);
  return result.data;
}

async function persistReceipt(
  receiptPath: string,
  receipt: TmsProbeReceipt
): Promise<void> {
  await atomicWriteJson(receiptPath, receipt, { mode: 0o600 });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

export async function readTmsCredentialRevision(
  path: string
): Promise<number> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    return value.schema_version === 1 &&
      Number.isSafeInteger(value.credential_revision) &&
      Number(value.credential_revision) >= 1
      ? Number(value.credential_revision)
      : 0;
  } catch {
    return 0;
  }
}
