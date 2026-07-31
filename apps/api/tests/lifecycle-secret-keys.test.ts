import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  deriveLifecycleRequiredSecretKeys,
  parseLifecycleBoolean
} from "../src/lifecycleSecretKeys.js";
import {
  runLifecycleSecretKeysCli,
  runLifecycleSecretKeysCliSafely
} from "../src/lifecycleSecretKeysCli.js";

const tempDirs: string[] = [];

async function fixtureDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "quoteops-lifecycle-secret-keys-"));
  tempDirs.push(directory);
  return directory;
}

async function writeConfig(directory: string, name: string, content: string): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
  return path;
}

function baseAvailable(...keys: string[]): string[] {
  return ["POSTGRES_PASSWORD", "QUOTEOPS_REGISTRATION_TOKEN", ...keys];
}

const deterministicAgent = `
model:
  provider: deterministic
  model_name: quote-core-preserver
  temperature: 0
authorization:
  tools: {}
`;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("lifecycle active secret key derivation", () => {
  it("accepts only the supported SAKBE boolean spellings", () => {
    for (const value of ["1", "true", "yes", "on"]) {
      expect(parseLifecycleBoolean(value)).toBe(true);
    }
    for (const value of ["0", "false", "no", "off"]) {
      expect(parseLifecycleBoolean(value)).toBe(false);
    }
    expect(() => parseLifecycleBoolean("sometimes")).toThrow("SAKBE live setting is invalid");
  });

  it("emits only sorted required key names from the CLI", async () => {
    const directory = await fixtureDir();
    const agentConfigPath = await writeConfig(directory, "agent.yaml", deterministicAgent);
    const tmsConfigPath = await writeConfig(
      directory,
      "tms.yaml",
      `
provider: file_import
historical_quotes_path_env: QUOTEOPS_TMS_HISTORICAL_QUOTES_PATH
`
    );
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runLifecycleSecretKeysCli([
      "--agent-config",
      agentConfigPath,
      "--tms-config",
      tmsConfigPath,
      "--sakbe-live",
      "false",
      "--available-key",
      "QUOTEOPS_REGISTRATION_TOKEN",
      "--available-key",
      "POSTGRES_PASSWORD",
      "--available-key",
      "STALE_SECRET_VALUE_NAME"
    ]);

    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(
      "POSTGRES_PASSWORD\nQUOTEOPS_REGISTRATION_TOKEN\n"
    );
    write.mockRestore();
  });

  it("fails closed without printing invalid config values", async () => {
    const directory = await fixtureDir();
    const secretLikeInvalidValue = "do-not-echo-this-config-value";
    const agentConfigPath = await writeConfig(
      directory,
      "agent.yaml",
      `
model:
  provider: ${secretLikeInvalidValue}
  model_name: quote-core-preserver
  temperature: 0
authorization:
  tools: {}
`
    );
    const tmsConfigPath = await writeConfig(
      directory,
      "tms.yaml",
      `
provider: file_import
historical_quotes_path_env: QUOTEOPS_TMS_HISTORICAL_QUOTES_PATH
`
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const exitCode = await runLifecycleSecretKeysCliSafely([
      "--agent-config",
      agentConfigPath,
      "--tms-config",
      tmsConfigPath,
      "--sakbe-live",
      "false",
      "--available-key",
      "QUOTEOPS_REGISTRATION_TOKEN",
      "--available-key",
      "POSTGRES_PASSWORD"
    ]);

    expect(exitCode).toBe(1);
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith("lifecycle secret key derivation failed");
    expect(JSON.stringify(error.mock.calls)).not.toContain(secretLikeInvalidValue);
    expect(write).not.toHaveBeenCalled();
  });

  it("accepts the production file/CSV adapter shape without requiring stale provider keys", async () => {
    const directory = await fixtureDir();
    const agentConfigPath = await writeConfig(directory, "agent.yaml", deterministicAgent);
    const tmsConfigPath = await writeConfig(
      directory,
      "tms.yaml",
      `
provider: file_import
rfqs_path_env: QUOTEOPS_TMS_RFQS_PATH
historical_quotes_path_env: QUOTEOPS_TMS_HISTORICAL_QUOTES_PATH
historical_shipments_path_env: QUOTEOPS_TMS_HISTORICAL_SHIPMENTS_PATH
customers_path_env: QUOTEOPS_TMS_CUSTOMERS_PATH
`
    );

    await expect(
      deriveLifecycleRequiredSecretKeys({
        agentConfigPath,
        tmsConfigPath,
        sakbeLive: false,
        availableKeys: baseAvailable(
          "OPENROUTER_API_KEY",
          "TMS_API_KEY",
          "TMS_SQL_URL",
          "STALE_INACTIVE_KEY"
        )
      })
    ).resolves.toEqual(["POSTGRES_PASSWORD", "QUOTEOPS_REGISTRATION_TOKEN"]);
  });

  it.each([
    [
      "canonical",
      `
provider: http
contract: quoteops-tms-http-v1
base_url_env: TMS_BASE_URL
headers:
  Authorization: Bearer \${TMS_CANONICAL_API_KEY}
health_endpoint_path: /health
`
    ],
    [
      "legacy explicit paths",
      `
provider: http
base_url_env: TMS_BASE_URL
headers:
  X-API-Key: \${TMS_LEGACY_API_KEY}
health_endpoint_path: /legacy/health
search_historical_quotes_endpoint_path: /legacy/history
write_quote_endpoint_path: /legacy/quotes
`
    ]
  ])("accepts the production %s HTTP adapter and extracts header env references", async (_name, tms) => {
    const directory = await fixtureDir();
    const agentConfigPath = await writeConfig(directory, "agent.yaml", deterministicAgent);
    const tmsConfigPath = await writeConfig(directory, "tms.yaml", tms);
    const expectedKey = tms.includes("CANONICAL") ? "TMS_CANONICAL_API_KEY" : "TMS_LEGACY_API_KEY";

    await expect(
      deriveLifecycleRequiredSecretKeys({
        agentConfigPath,
        tmsConfigPath,
        sakbeLive: false,
        availableKeys: baseAvailable(expectedKey, "STALE_INACTIVE_KEY")
      })
    ).resolves.toEqual(["POSTGRES_PASSWORD", "QUOTEOPS_REGISTRATION_TOKEN", expectedKey]);
  });

  it("accepts literal and folded multiline SQL blocks through the production YAML schema", async () => {
    const directory = await fixtureDir();
    const agentConfigPath = await writeConfig(directory, "agent.yaml", deterministicAgent);
    const tmsConfigPath = await writeConfig(
      directory,
      "tms.yaml",
      `
provider: sql
dialect: postgres
connection_url_env: TMS_SQL_URL
queries:
  historical_quotes: |
    SELECT quote_id, amount
    FROM historical_quotes
    WHERE customer_id = $1
  historical_shipments: >
    SELECT shipment_id, delivered_at
    FROM historical_shipments
    WHERE customer_id = $1
write_quote:
  statement: |
    INSERT INTO quote_writebacks (quote_id, amount)
    VALUES ($1, $2)
write_status:
  statement: >
    UPDATE quote_writebacks
    SET status = $2
    WHERE quote_id = $1
`
    );

    await expect(
      deriveLifecycleRequiredSecretKeys({
        agentConfigPath,
        tmsConfigPath,
        sakbeLive: false,
        availableKeys: baseAvailable("TMS_SQL_URL", "TMS_API_KEY")
      })
    ).resolves.toEqual(["POSTGRES_PASSWORD", "QUOTEOPS_REGISTRATION_TOKEN", "TMS_SQL_URL"]);
  });

  it("derives active agent, mailbox, embeddings, SAKBE, tunnel, and HTTP keys only", async () => {
    const directory = await fixtureDir();
    const agentConfigPath = await writeConfig(
      directory,
      "agent.yaml",
      `
model:
  provider: openrouter
  model_name: lifecycle-model
  api_key_env: OPENROUTER_API_KEY
authorization:
  tools: {}
mailbox:
  provider: gmail
  auth: oauth2
embeddings:
  provider: gemini
  api_key_env: EMBEDDING_API_KEY
`
    );
    const tmsConfigPath = await writeConfig(
      directory,
      "tms.yaml",
      `
provider: http
contract: quoteops-tms-http-v1
base_url_env: TMS_BASE_URL
headers:
  Authorization: Bearer \${TMS_API_KEY}
`
    );
    const cloudflareSettingsPath = await writeConfig(
      directory,
      "cloudflare.json",
      JSON.stringify({
        provider: "cloudflare",
        public_hostname: "quotes.lifecycle.example",
        origin_url: "http://caddy:80"
      })
    );
    const active = [
      "OPENROUTER_API_KEY",
      "MAILBOX_USER",
      "MAILBOX_OAUTH_CLIENT_ID",
      "MAILBOX_OAUTH_CLIENT_SECRET",
      "MAILBOX_OAUTH_REFRESH_TOKEN",
      "EMBEDDING_API_KEY",
      "TMS_API_KEY",
      "INEGI_SAKBE_KEY",
      "TUNNEL_TOKEN"
    ];

    await expect(
      deriveLifecycleRequiredSecretKeys({
        agentConfigPath,
        tmsConfigPath,
        cloudflareSettingsPath,
        sakbeLive: true,
        availableKeys: baseAvailable(
          ...active,
          "GEMINI_API_KEY",
          "MAILBOX_PASSWORD",
          "QUOTEOPS_SAKBE_API_KEY",
          "STALE_INACTIVE_KEY"
        )
      })
    ).resolves.toEqual(
      [
        "EMBEDDING_API_KEY",
        "INEGI_SAKBE_KEY",
        "MAILBOX_OAUTH_CLIENT_ID",
        "MAILBOX_OAUTH_CLIENT_SECRET",
        "MAILBOX_OAUTH_REFRESH_TOKEN",
        "MAILBOX_USER",
        "OPENROUTER_API_KEY",
        "POSTGRES_PASSWORD",
        "QUOTEOPS_REGISTRATION_TOKEN",
        "TMS_API_KEY",
        "TUNNEL_TOKEN"
      ]
    );
  });

  it("rejects unknown production config keys and missing active secrets", async () => {
    const directory = await fixtureDir();
    const agentConfigPath = await writeConfig(directory, "agent.yaml", deterministicAgent);
    const invalidTmsConfigPath = await writeConfig(
      directory,
      "invalid-tms.yaml",
      `
provider: sql
dialect: postgres
connection_url_env: TMS_SQL_URL
queries:
  historical_quotes: SELECT 1
unknown_tms_field: forbidden
`
    );
    await expect(
      deriveLifecycleRequiredSecretKeys({
        agentConfigPath,
        tmsConfigPath: invalidTmsConfigPath,
        sakbeLive: false,
        availableKeys: baseAvailable("TMS_SQL_URL")
      })
    ).rejects.toThrow();

    const validTmsConfigPath = await writeConfig(
      directory,
      "valid-tms.yaml",
      `
provider: sql
dialect: postgres
connection_url_env: TMS_SQL_URL
queries:
  historical_quotes: SELECT 1
`
    );
    await expect(
      deriveLifecycleRequiredSecretKeys({
        agentConfigPath,
        tmsConfigPath: validTmsConfigPath,
        sakbeLive: false,
        availableKeys: baseAvailable()
      })
    ).rejects.toThrow("required active secret key is missing: TMS_SQL_URL");

    const invalidCloudflareSettingsPath = await writeConfig(
      directory,
      "invalid-cloudflare.json",
      JSON.stringify({
        provider: "cloudflare",
        public_hostname: "quotes.lifecycle.example",
        origin_url: "http://caddy:80",
        unexpected: true
      })
    );
    await expect(
      deriveLifecycleRequiredSecretKeys({
        agentConfigPath,
        tmsConfigPath: validTmsConfigPath,
        cloudflareSettingsPath: invalidCloudflareSettingsPath,
        sakbeLive: false,
        availableKeys: baseAvailable("TMS_SQL_URL", "TUNNEL_TOKEN")
      })
    ).rejects.toThrow("Cloudflare settings failed exact-schema validation");
  });
});
