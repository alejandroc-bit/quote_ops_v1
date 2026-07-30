import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rmdir
} from "node:fs/promises";
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
  atomicWriteJson,
  atomicWriteText,
  buildTmsAdapterYaml,
  readEnvFileValues,
  readSingleLineSecret,
  updateAllowedEnv,
  validateTmsBaseUrl
} from "./onboardConfig.js";
import type { SecretFileRef } from "./onboardingFlow.js";
import {
  createPinnedTmsTransport,
  createTmsAbsoluteDeadline,
  type PinnedTmsRequestExecutor,
  type PinnedTmsTransport,
  TmsTransportError,
  type TmsAbsoluteDeadline
} from "./tmsSafeTransport.js";

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
  transport?: PinnedTmsTransport;
  testPinnedRequest?: PinnedTmsRequestExecutor;
  now?: () => Date;
  resolveHostname?: (hostname: string) => Promise<string[]>;
  timeoutMs?: number;
  maxBodyBytes?: number;
  acceptanceMode?: string;
  deadline?: TmsAbsoluteDeadline;
  afterReceiptRename?: () => void | Promise<void>;
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
  testPinnedRequest?: PinnedTmsRequestExecutor;
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
  const configYaml = buildTmsAdapterYaml({
    provider: "http",
    contract: TMS_HTTP_V1_CONTRACT,
    base_url_env: "TMS_HTTP_BASE_URL",
    api_key_env: "TMS_API_KEY"
  });
  return await configureTmsHttpGeneration({
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    sampleQuery: input.sampleQuery,
    configYaml,
    context,
    probe: probeTmsHttpV1
  });
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
  const configYaml = buildTmsAdapterYaml({
    provider: "http",
    base_url_env: "TMS_HTTP_BASE_URL",
    headers: { authorization: "Bearer ${TMS_API_KEY}" },
    endpoints: input.endpoints
  });
  return await configureTmsHttpGeneration({
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    sampleQuery: input.sampleQuery,
    configYaml,
    context,
    probe: probeLegacyCustomHttp
  });
}

async function configureTmsHttpGeneration<
  TReceipt extends TmsProbeReceipt
>(input: {
  baseUrl: string;
  apiKey: string | SecretFileRef;
  sampleQuery: HistoricalSearchQuery;
  configYaml: string;
  context: ConfigureTmsHttpV1Context;
  probe: (input: TmsProbeInput) => Promise<TReceipt>;
}): Promise<{
  adapter: TmsAdapter;
  env: Record<string, string | undefined>;
  credentialRevision: number;
  receipt: TReceipt;
}> {
  const { context } = input;
  const acceptanceMode = context.env.QUOTEOPS_ACCEPTANCE_MODE;
  const baseUrl = validateTmsBaseUrl(input.baseUrl, acceptanceMode);
  const apiKey = await readSingleLineSecret(input.apiKey, context);
  const deadline = createTmsAbsoluteDeadline(
    context.httpProbeTimeoutMs ?? DEFAULT_TIMEOUT_MS
  );
  let releaseLock: (() => Promise<void>) | undefined;
  try {
    releaseLock = await acquireTmsConfigLock(
      context.paths.settingsDir,
      deadline
    );
    const revisionPath = join(
      context.paths.settingsDir,
      "tms-credential-revision"
    );
    const [current, currentConfig, currentRevision] = await Promise.all([
      readEnvFileValues(context.paths.clientSecretsFile),
      readFile(context.paths.tmsAdapterConfigFile, "utf8").catch(() => ""),
      readTmsCredentialRevision(revisionPath)
    ]);
    const generationChanged =
      currentRevision < 1 ||
      current.get("TMS_HTTP_BASE_URL") !== baseUrl ||
      current.get("TMS_API_KEY") !== apiKey ||
      currentConfig !== input.configYaml;
    const credentialRevision = generationChanged
      ? currentRevision + 1
      : currentRevision;

    if (generationChanged) {
      // The revision is the invalidation record. It must become durable before
      // either the adapter config or its credentials can expose a new generation.
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
      await atomicWriteText(
        context.paths.tmsAdapterConfigFile,
        input.configYaml,
        {
          mode: 0o600,
          afterRename: () =>
            context.afterAtomicRename?.("tms_adapter_config")
        }
      );
      await updateAllowedEnv(
        context.paths.clientSecretsFile,
        {
          TMS_HTTP_BASE_URL: baseUrl,
          TMS_API_KEY: apiKey
        },
        ["TMS_HTTP_BASE_URL", "TMS_API_KEY"],
        () => context.afterAtomicRename?.("tms_client_env")
      );
    }

    deadline.signal.throwIfAborted();
    const tmsEnv = {
      ...context.env,
      TMS_HTTP_BASE_URL: baseUrl,
      TMS_API_KEY: apiKey
    };
    const transport = createPinnedTmsTransport({
      baseUrlOrigin: baseUrl,
      resolveHostname: context.resolveHostname,
      request: selectTestPinnedRequest(context.testPinnedRequest),
      maximumBodyBytes: DEFAULT_MAX_BODY_BYTES,
      acceptanceMode,
      deadline
    });
    const adapter = await createTmsAdapterFromConfig(
      context.paths.tmsAdapterConfigFile,
      { env: tmsEnv, fetch: transport.fetch }
    );
    const receipt = await input.probe({
      adapter,
      resolvedBaseUrl: baseUrl,
      resolvedHeaders: { authorization: `Bearer ${apiKey}` },
      adapterConfigPath: context.paths.tmsAdapterConfigFile,
      credentialRevision,
      receiptPath: context.paths.tmsProbeFile,
      sampleQuery: input.sampleQuery,
      transport,
      resolveHostname: context.resolveHostname,
      now: context.now,
      timeoutMs: context.httpProbeTimeoutMs,
      acceptanceMode,
      deadline,
      afterReceiptRename: () =>
        context.afterAtomicRename?.("tms_probe_receipt")
    });
    return { adapter, env: tmsEnv, credentialRevision, receipt };
  } finally {
    await releaseLock?.();
    deadline.dispose();
  }
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
  const ownedDeadline = input.deadline
    ? null
    : createTmsAbsoluteDeadline(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const deadline = input.deadline ?? ownedDeadline!;
  try {
    return await probeTmsHttpV1WithinDeadline(input, deadline);
  } finally {
    ownedDeadline?.dispose();
  }
}

async function probeTmsHttpV1WithinDeadline(
  input: TmsProbeInput,
  deadline: TmsAbsoluteDeadline
): Promise<TmsHttpV1ProbeReceipt> {
  const prepared = await prepareProbe(input);
  assertCanonicalV1Config(prepared.config);
  const transport =
    input.transport ??
    createPinnedTmsTransport({
      baseUrlOrigin: prepared.baseUrlOrigin,
      resolveHostname: input.resolveHostname,
      request: selectTestPinnedRequest(input.testPinnedRequest),
      maximumBodyBytes:
        input.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      acceptanceMode: input.acceptanceMode,
      deadline
    });
  const response = await fetchHealth(
    input,
    transport,
    prepared.baseUrlOrigin,
    deadline
  );
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
      input.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      deadline
    ),
    deadline,
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

  await validateCanonicalOutputs(input, deadline);
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
  await persistReceipt(
    input.receiptPath,
    receipt,
    input.afterReceiptRename
  );
  return receipt;
}

export async function probeLegacyCustomHttp(
  input: TmsProbeInput
): Promise<LegacyCustomHttpProbeReceipt> {
  const ownedDeadline = input.deadline
    ? null
    : createTmsAbsoluteDeadline(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const deadline = input.deadline ?? ownedDeadline!;
  try {
    return await probeLegacyCustomHttpWithinDeadline(input, deadline);
  } finally {
    ownedDeadline?.dispose();
  }
}

async function probeLegacyCustomHttpWithinDeadline(
  input: TmsProbeInput,
  deadline: TmsAbsoluteDeadline
): Promise<LegacyCustomHttpProbeReceipt> {
  const prepared = await prepareProbe(input);
  assertLegacyCustomConfig(prepared.config);
  const health = await boundedOperation(
    "legacy_health",
    input.adapter.healthCheck(),
    deadline
  );
  if (
    health.ok !== true ||
    health.status !== "ok" ||
    health.capabilities?.write_quote !== true
  ) {
    throw new TmsProbeError("legacy_health_failed");
  }

  await validateCanonicalOutputs(input, deadline);
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
  await persistReceipt(
    input.receiptPath,
    receipt,
    input.afterReceiptRename
  );
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
  transport: PinnedTmsTransport,
  baseUrlOrigin: string,
  deadline: TmsAbsoluteDeadline
): Promise<Response> {
  try {
    return await boundedOperation(
      "health",
      transport.fetch(
        new URL(TMS_HTTP_V1_PATHS.health, `${baseUrlOrigin}/`),
        {
          method: "GET",
          headers: input.resolvedHeaders,
          redirect: "manual",
          signal: deadline.signal
        }
      ),
      deadline
    );
  } catch (error) {
    if (error instanceof TmsProbeError) throw error;
    if (error instanceof TmsTransportError) {
      const code =
        error.code === "response_body_too_large"
          ? "health_body_too_large"
          : error.code === "request_redirect_rejected"
            ? "health_redirect_rejected"
            : error.code;
      throw new TmsProbeError(code);
    }
    throw new TmsProbeError("health_unreachable");
  }
}

async function validateCanonicalOutputs(
  input: TmsProbeInput,
  deadline: TmsAbsoluteDeadline
): Promise<void> {
  const [historicalValue, unitsValue, performanceValue, zonesValue] =
    await Promise.all([
      boundedAdapterOperation(
        "historical_quotes",
        input.adapter.searchHistoricalQuotes(input.sampleQuery),
        deadline
      ),
      boundedAdapterOperation("units", input.adapter.getUnits(), deadline),
      boundedAdapterOperation(
        "unit_performance",
        input.adapter.getUnitPerformance(),
        deadline
      ),
      boundedAdapterOperation(
        "availability_zones",
        input.adapter.getAvailabilityZones(),
        deadline
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
  deadline: TmsAbsoluteDeadline
): Promise<T> {
  try {
    return await boundedOperation(endpoint, promise, deadline);
  } catch (error) {
    if (error instanceof TmsProbeError) throw error;
    throw new TmsProbeError(`${endpoint}_invalid`);
  }
}

async function boundedOperation<T>(
  endpoint: string,
  promise: Promise<T>,
  deadline: TmsAbsoluteDeadline,
  onTimeout?: () => void
): Promise<T> {
  if (deadline.signal.aborted) {
    onTimeout?.();
    throw new TmsProbeError(`${endpoint}_timeout`);
  }
  return await new Promise<T>((resolve, reject) => {
    const abort = () => {
      onTimeout?.();
      reject(new TmsProbeError(`${endpoint}_timeout`));
    };
    deadline.signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => {
      deadline.signal.removeEventListener("abort", abort);
    });
  });
}

async function readJsonBodyBounded(
  response: Response,
  maximumBytes: number,
  deadline: TmsAbsoluteDeadline
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
      const { done, value } = await boundedOperation(
        "health_body",
        reader.read(),
        deadline,
        () => void reader.cancel(deadline.signal.reason).catch(() => undefined)
      );
      deadline.signal.throwIfAborted();
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
  receipt: TmsProbeReceipt,
  afterRename?: () => void | Promise<void>
): Promise<void> {
  await atomicWriteJson(receiptPath, receipt, {
    mode: 0o600,
    afterRename
  });
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

function selectTestPinnedRequest(
  request: PinnedTmsRequestExecutor | undefined
): PinnedTmsRequestExecutor | undefined {
  if (!request) return undefined;
  if (process.env.NODE_ENV !== "test") {
    throw new TmsProbeError("test_transport_forbidden");
  }
  return request;
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

async function acquireTmsConfigLock(
  settingsDir: string,
  deadline: TmsAbsoluteDeadline
): Promise<() => Promise<void>> {
  const lockDirectory = join(settingsDir, "tms-config-locks");
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const choosingName = `choosing-${process.pid}-${token}`;
  const choosingPath = join(lockDirectory, choosingName);
  let ticketPath: string | undefined;
  await mkdir(choosingPath, { mode: 0o700 });
  try {
    const snapshot = await readTmsLockEntries(lockDirectory);
    const maximumTicket = snapshot.tickets.reduce(
      (maximum, ticket) => Math.max(maximum, ticket.number),
      0
    );
    if (maximumTicket >= Number.MAX_SAFE_INTEGER) {
      throw new TmsProbeError("tms_config_lock_exhausted");
    }
    const ticketNumber = maximumTicket + 1;
    const ticketName =
      `ticket-${String(ticketNumber).padStart(16, "0")}` +
      `-${process.pid}-${token}`;
    ticketPath = join(lockDirectory, ticketName);
    await mkdir(ticketPath, { mode: 0o700 });
    await rmdir(choosingPath);

    while (true) {
      deadline.signal.throwIfAborted();
      const entries = await readTmsLockEntries(lockDirectory);
      const anotherOwnerChoosing = entries.choosing.some(
        (entry) =>
          entry.token !== token && isLockProcessAlive(entry.pid)
      );
      const earlierLiveTicket = entries.tickets.some(
        (entry) =>
          entry.token !== token &&
          isLockProcessAlive(entry.pid) &&
          compareLockTickets(
            entry,
            { number: ticketNumber, pid: process.pid, token }
          ) < 0
      );
      if (!anotherOwnerChoosing && !earlierLiveTicket) {
        const ownedTicketPath = ticketPath;
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          await rmdir(ownedTicketPath).catch((error) => {
            if (!isFileMissingError(error)) throw error;
          });
        };
      }
      await waitForLock(deadline.signal);
    }
  } catch (error) {
    await rmdir(choosingPath).catch(() => undefined);
    if (ticketPath) {
      await rmdir(ticketPath).catch(() => undefined);
    }
    throw error;
  }
}

type TmsChoosingEntry = {
  pid: number;
  token: string;
};

type TmsTicketEntry = TmsChoosingEntry & {
  number: number;
};

async function readTmsLockEntries(lockDirectory: string): Promise<{
  choosing: TmsChoosingEntry[];
  tickets: TmsTicketEntry[];
}> {
  const choosing: TmsChoosingEntry[] = [];
  const tickets: TmsTicketEntry[] = [];
  const entries = await readdir(lockDirectory, {
    withFileTypes: true
  });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const choosingMatch =
      /^choosing-(\d+)-([A-Za-z0-9-]+)$/.exec(entry.name);
    if (choosingMatch) {
      choosing.push({
        pid: Number(choosingMatch[1]),
        token: choosingMatch[2] ?? ""
      });
      continue;
    }
    const ticketMatch =
      /^ticket-(\d{16})-(\d+)-([A-Za-z0-9-]+)$/.exec(
        entry.name
      );
    if (ticketMatch) {
      tickets.push({
        number: Number(ticketMatch[1]),
        pid: Number(ticketMatch[2]),
        token: ticketMatch[3] ?? ""
      });
    }
  }
  return { choosing, tickets };
}

function compareLockTickets(
  left: TmsTicketEntry,
  right: TmsTicketEntry
): number {
  if (left.number !== right.number) {
    return left.number - right.number;
  }
  return left.token.localeCompare(right.token);
}

function isLockProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcessError(error);
  }
}

async function waitForLock(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, 10);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function isFileMissingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isNoSuchProcessError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ESRCH"
  );
}
