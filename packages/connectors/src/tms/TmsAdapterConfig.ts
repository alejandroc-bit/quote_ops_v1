import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  FileImportTmsAdapter,
  type FileImportTmsAdapterConfig
} from "./FileImportTmsAdapter.js";
import {
  HttpTmsAdapter,
  type HttpTmsAdapterConfig,
  type HttpTmsAdapterEndpoints
} from "./HttpTmsAdapter.js";
import { SqlTmsAdapter, type SqlTmsAdapterConfig } from "./SqlTmsAdapter.js";
import { createSqlExecutor } from "./sqlExecutor.js";
import { TmsAdapterError, type TmsAdapter } from "./TmsAdapter.js";

export interface CreateTmsAdapterFromConfigOptions {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}

const envNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an env var name");
const endpointPathSchema = z.string().min(1);
const headersSchema = z.record(z.string().min(1), z.string());

const fileImportConfigSchema = z
  .object({
    provider: z.literal("file_import"),
    rfqs_path_env: envNameSchema.optional(),
    historical_quotes_path_env: envNameSchema.optional(),
    historical_shipments_path_env: envNameSchema.optional(),
    customers_path_env: envNameSchema.optional(),
    agreements_path_env: envNameSchema.optional(),
    unit_positions_path_env: envNameSchema.optional(),
    units_path_env: envNameSchema.optional(),
    performance_path_env: envNameSchema.optional(),
    availability_zones_path_env: envNameSchema.optional(),
    quote_writebacks_path_env: envNameSchema.optional(),
    status_writebacks_path_env: envNameSchema.optional()
  })
  .strict();

const httpConfigSchema = z
  .object({
    provider: z.literal("http"),
    base_url_env: envNameSchema,
    headers: headersSchema.optional(),
    health_endpoint_path: endpointPathSchema.optional(),
    get_rfq_endpoint_path: endpointPathSchema.optional(),
    list_new_rfqs_endpoint_path: endpointPathSchema.optional(),
    search_historical_quotes_endpoint_path: endpointPathSchema.optional(),
    search_historical_shipments_endpoint_path: endpointPathSchema.optional(),
    get_customer_endpoint_path: endpointPathSchema.optional(),
    get_customer_agreements_endpoint_path: endpointPathSchema.optional(),
    get_unit_positions_endpoint_path: endpointPathSchema.optional(),
    get_units_endpoint_path: endpointPathSchema.optional(),
    get_unit_performance_endpoint_path: endpointPathSchema.optional(),
    get_availability_zones_endpoint_path: endpointPathSchema.optional(),
    write_quote_endpoint_path: endpointPathSchema.optional(),
    write_status_endpoint_path: endpointPathSchema.optional()
  })
  .strict();

const sqlStatementSchema = z.string().min(1);

const sqlConfigSchema = z
  .object({
    provider: z.literal("sql"),
    dialect: z.enum(["postgres", "mysql", "mssql"]),
    connection_url_env: envNameSchema,
    queries: z
      .object({
        get_rfq: sqlStatementSchema.optional(),
        new_rfqs: sqlStatementSchema.optional(),
        historical_quotes: sqlStatementSchema.optional(),
        historical_shipments: sqlStatementSchema.optional(),
        customers: sqlStatementSchema.optional(),
        agreements: sqlStatementSchema.optional(),
        unit_positions: sqlStatementSchema.optional(),
        units: sqlStatementSchema.optional(),
        performance: sqlStatementSchema.optional(),
        availability_zones: sqlStatementSchema.optional()
      })
      .strict(),
    write_quote: z.object({ statement: sqlStatementSchema }).strict().optional(),
    write_status: z.object({ statement: sqlStatementSchema }).strict().optional()
  })
  .strict();

export const tmsAdapterConfigSchema = z.discriminatedUnion("provider", [
  fileImportConfigSchema,
  httpConfigSchema,
  sqlConfigSchema
]);

export type TmsAdapterFactoryConfig = z.infer<typeof tmsAdapterConfigSchema>;

export async function loadTmsAdapterConfig(path: string): Promise<TmsAdapterFactoryConfig> {
  const content = await readFile(path, "utf8");
  const parsed = parseConfigContent(path, content);
  const config = tmsAdapterConfigSchema.parse(parsed);

  assertNoEmbeddedHeaderSecrets(config);

  return config;
}

export async function createTmsAdapterFromConfig(
  path: string,
  options: CreateTmsAdapterFromConfigOptions = {}
): Promise<TmsAdapter> {
  const config = await loadTmsAdapterConfig(path);
  const env = options.env ?? process.env;

  if (config.provider === "file_import") {
    return new FileImportTmsAdapter(fileImportConfigFromEnv(config, env));
  }

  if (config.provider === "sql") {
    const connectionUrl = readRequiredEnv(env, config.connection_url_env, "connection_url_env");
    const executor = await createSqlExecutor(config.dialect, connectionUrl);
    const sqlConfig: SqlTmsAdapterConfig = {
      queries: config.queries,
      ...(config.write_quote ? { write_quote: config.write_quote } : {}),
      ...(config.write_status ? { write_status: config.write_status } : {})
    };
    return new SqlTmsAdapter(sqlConfig, executor);
  }

  return new HttpTmsAdapter(httpConfigFromEnv(config, env, options.fetch));
}

function parseConfigContent(path: string, content: string): unknown {
  if (extname(path).toLowerCase() === ".json") {
    return JSON.parse(content);
  }

  return parseYaml(content);
}

function fileImportConfigFromEnv(
  config: z.infer<typeof fileImportConfigSchema>,
  env: Record<string, string | undefined>
): FileImportTmsAdapterConfig {
  return {
    rfqsPath: readOptionalEnv(env, config.rfqs_path_env, "rfqs_path_env"),
    historicalQuotesPath: readOptionalEnv(
      env,
      config.historical_quotes_path_env,
      "historical_quotes_path_env"
    ),
    historicalShipmentsPath: readOptionalEnv(
      env,
      config.historical_shipments_path_env,
      "historical_shipments_path_env"
    ),
    customersPath: readOptionalEnv(env, config.customers_path_env, "customers_path_env"),
    agreementsPath: readOptionalEnv(env, config.agreements_path_env, "agreements_path_env"),
    unitPositionsPath: readOptionalEnv(
      env,
      config.unit_positions_path_env,
      "unit_positions_path_env"
    ),
    unitsPath: readOptionalEnv(env, config.units_path_env, "units_path_env"),
    performancePath: readOptionalEnv(env, config.performance_path_env, "performance_path_env"),
    availabilityZonesPath: readOptionalEnv(
      env,
      config.availability_zones_path_env,
      "availability_zones_path_env"
    ),
    quoteWritebacksPath: readOptionalEnv(
      env,
      config.quote_writebacks_path_env,
      "quote_writebacks_path_env"
    ),
    statusWritebacksPath: readOptionalEnv(
      env,
      config.status_writebacks_path_env,
      "status_writebacks_path_env"
    )
  };
}

function httpConfigFromEnv(
  config: z.infer<typeof httpConfigSchema>,
  env: Record<string, string | undefined>,
  fetchFn?: typeof fetch
): HttpTmsAdapterConfig {
  const headers = interpolateHeaders(config.headers, env);
  const endpoints: HttpTmsAdapterEndpoints = {
    ...(config.health_endpoint_path ? { health: config.health_endpoint_path } : {}),
    ...(config.get_rfq_endpoint_path
      ? { getRfq: (rfqId: string) => resolvePathParam(config.get_rfq_endpoint_path!, "rfq_id", rfqId) }
      : {}),
    ...(config.list_new_rfqs_endpoint_path
      ? { listNewRfqs: config.list_new_rfqs_endpoint_path }
      : {}),
    ...(config.search_historical_quotes_endpoint_path
      ? { searchHistoricalQuotes: config.search_historical_quotes_endpoint_path }
      : {}),
    ...(config.search_historical_shipments_endpoint_path
      ? { searchHistoricalShipments: config.search_historical_shipments_endpoint_path }
      : {}),
    ...(config.get_customer_endpoint_path
      ? {
          getCustomer: (customerId: string) =>
            resolvePathParam(config.get_customer_endpoint_path!, "customer_id", customerId)
        }
      : {}),
    ...(config.get_customer_agreements_endpoint_path
      ? {
          getCustomerAgreements: (customerId: string) =>
            resolvePathParam(
              config.get_customer_agreements_endpoint_path!,
              "customer_id",
              customerId
            )
        }
      : {}),
    ...(config.get_unit_positions_endpoint_path
      ? { getUnitPositions: config.get_unit_positions_endpoint_path }
      : {}),
    ...(config.get_units_endpoint_path ? { getUnits: config.get_units_endpoint_path } : {}),
    ...(config.get_unit_performance_endpoint_path
      ? { getUnitPerformance: config.get_unit_performance_endpoint_path }
      : {}),
    ...(config.get_availability_zones_endpoint_path
      ? { getAvailabilityZones: config.get_availability_zones_endpoint_path }
      : {}),
    ...(config.write_quote_endpoint_path ? { writeQuote: config.write_quote_endpoint_path } : {}),
    ...(config.write_status_endpoint_path ? { writeStatus: config.write_status_endpoint_path } : {})
  };

  return {
    baseUrl: readRequiredEnv(env, config.base_url_env, "base_url_env"),
    ...(headers ? { headers } : {}),
    endpoints,
    ...(fetchFn ? { fetch: fetchFn } : {})
  };
}

function interpolateHeaders(
  headers: Record<string, string> | undefined,
  env: Record<string, string | undefined>
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      interpolateEnvTemplate(value, env, `headers.${name}`)
    ])
  );
}

function interpolateEnvTemplate(
  value: string,
  env: Record<string, string | undefined>,
  field: string
): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, key: string) =>
    readRequiredEnv(env, key, field)
  );
}

function readOptionalEnv(
  env: Record<string, string | undefined>,
  key: string | undefined,
  field: string
): string | undefined {
  return key ? readRequiredEnv(env, key, field) : undefined;
}

function readRequiredEnv(
  env: Record<string, string | undefined>,
  key: string,
  field: string
): string {
  const value = env[key];

  if (value === undefined || value.trim() === "") {
    throw new TmsAdapterError(`TMS adapter config env var is missing: ${key}`, {
      code: "tms_config_env_missing",
      details: { field, env_key: key }
    });
  }

  return value;
}

function assertNoEmbeddedHeaderSecrets(config: TmsAdapterFactoryConfig): void {
  if (config.provider !== "http" || !config.headers) {
    return;
  }

  for (const [name, value] of Object.entries(config.headers)) {
    if (isSecretBearingHeader(name) && !/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value)) {
      throw new TmsAdapterError(
        `TMS adapter config header must use an env placeholder: ${name}`,
        {
          code: "tms_config_embedded_secret",
          details: { header: name }
        }
      );
    }
  }
}

function isSecretBearingHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === "authorization" ||
    normalized.includes("api-key") ||
    normalized.includes("apikey") ||
    normalized.includes("token") ||
    normalized.includes("secret")
  );
}

function resolvePathParam(path: string, paramName: string, value: string): string {
  const encoded = encodeURIComponent(value);

  return path
    .replaceAll(`:${paramName}`, encoded)
    .replaceAll(`{${paramName}}`, encoded)
    .replaceAll(`\${${paramName}}`, encoded)
    .replaceAll(":id", encoded)
    .replaceAll("{id}", encoded)
    .replaceAll("${id}", encoded);
}
