import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertAgentToolAllowed,
  loadAgentRuntimeConfig,
  loadOpenRouterApiKey,
  loadSakbeApiKey,
  OpenRouterGuideClient
} from "../src/index";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("AgentRuntimeConfig", () => {
  it("uses deterministic defaults only when the config path is omitted", async () => {
    const config = await loadAgentRuntimeConfig();

    expect(config.model).toMatchObject({
      provider: "deterministic",
      model_name: "quote-core-preserver",
      api_key_env: null
    });
    expect(() => assertAgentToolAllowed({ config, toolName: "route.resolve" })).not.toThrow();
  });

  it("fails when an explicit agent config path is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quoteops-agent-config-"));
    tempDirs.push(dir);

    await expect(loadAgentRuntimeConfig(join(dir, "missing-agent-config.yaml"))).rejects.toThrow(
      /Agent runtime config not found/
    );
  });

  it("fails when an explicit agent config file is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quoteops-agent-config-"));
    tempDirs.push(dir);
    const configPath = join(dir, "agent-config.yaml");
    await writeFile(configPath, "\n", "utf8");

    await expect(loadAgentRuntimeConfig(configPath)).rejects.toThrow(/Agent runtime config is empty/);
  });

  it("loads model and tool authorization from a mounted YAML file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quoteops-agent-config-"));
    tempDirs.push(dir);
    const configPath = join(dir, "agent-config.yaml");
    await writeFile(
      configPath,
      [
        "model:",
        "  provider: gemini_sdk",
        "  model_name: gemini-2.5-pro",
        "  temperature: 0",
        "  api_key_env: GEMINI_API_KEY",
        "authorization:",
        "  tools:",
        "    tms.writeQuoteResult:",
        "      effect: write",
        "      mode: approval_required",
        ""
      ].join("\n"),
      "utf8"
    );

    const config = await loadAgentRuntimeConfig(configPath);

    expect(config.model).toMatchObject({
      provider: "gemini_sdk",
      model_name: "gemini-2.5-pro",
      api_key_env: "GEMINI_API_KEY"
    });
    expect(() =>
      assertAgentToolAllowed({ config, toolName: "tms.writeQuoteResult" })
    ).toThrow(/requires approval/);
    expect(() =>
      assertAgentToolAllowed({
        config,
        toolName: "tms.writeQuoteResult",
        approvalGranted: true
      })
    ).not.toThrow();
  });

  it("loads onboarding approver identity alongside tool authorization", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quoteops-agent-config-"));
    tempDirs.push(dir);
    const configPath = join(dir, "agent-config.yaml");
    await writeFile(
      configPath,
      [
        "model:",
        "  provider: deterministic",
        "  model_name: quote-core-preserver",
        "authorization:",
        "  approver_email: boss@example.com",
        "  allowed_domains:",
        "    - example.com",
        "  whatsapp_approver_phone: '+528112345678'",
        "  tools:",
        "    route.resolve:",
        "      effect: read",
        "      mode: allowed",
        ""
      ].join("\n"),
      "utf8"
    );

    const config = await loadAgentRuntimeConfig(configPath);

    expect(config.authorization).toMatchObject({
      approver_email: "boss@example.com",
      allowed_domains: ["example.com"],
      whatsapp_approver_phone: "+528112345678"
    });
  });

  it("rejects typoed model providers in explicit config files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quoteops-agent-config-"));
    tempDirs.push(dir);
    const configPath = join(dir, "agent-config.yaml");
    await writeFile(
      configPath,
      [
        "model:",
        "  provider: gemni_sdk",
        "  model_name: gemini-2.5-pro",
        "authorization:",
        "  tools:",
        "    route.resolve:",
        "      effect: read",
        "      mode: allowed",
        ""
      ].join("\n"),
      "utf8"
    );

    await expect(loadAgentRuntimeConfig(configPath)).rejects.toThrow(
      /Invalid agent model provider: "gemni_sdk"/
    );
  });

  it("rejects explicit configs without an authorization.tools section", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quoteops-agent-config-"));
    tempDirs.push(dir);
    const configPath = join(dir, "agent-config.yaml");
    await writeFile(
      configPath,
      [
        "model:",
        "  provider: openrouter",
        "  model_name: nvidia/nemotron-3-ultra-550b-a55b:free",
        ""
      ].join("\n"),
      "utf8"
    );

    await expect(loadAgentRuntimeConfig(configPath)).rejects.toThrow(
      /Agent runtime config authorization is required/
    );
  });

  it("rejects misspelled top-level sections in explicit config files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quoteops-agent-config-"));
    tempDirs.push(dir);
    const configPath = join(dir, "agent-config.yaml");
    await writeFile(
      configPath,
      [
        "model:",
        "  provider: openrouter",
        "  model_name: nvidia/nemotron-3-ultra-550b-a55b:free",
        "authorizaton:",
        "  tools:",
        "    tms.writeQuoteResult:",
        "      effect: write",
        "      mode: approval_required",
        ""
      ].join("\n"),
      "utf8"
    );

    await expect(loadAgentRuntimeConfig(configPath)).rejects.toThrow(
      /Agent runtime config has unknown key: authorizaton/
    );
  });

  it("rejects invalid explicit tool policy effects with the tool name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quoteops-agent-config-"));
    tempDirs.push(dir);
    const configPath = join(dir, "agent-config.yaml");
    await writeFile(
      configPath,
      [
        "model:",
        "  provider: openrouter",
        "  model_name: nvidia/nemotron-3-ultra-550b-a55b:free",
        "authorization:",
        "  tools:",
        "    tms.writeQuoteResult:",
        "      effect: mutate",
        "      mode: approval_required",
        ""
      ].join("\n"),
      "utf8"
    );

    await expect(loadAgentRuntimeConfig(configPath)).rejects.toThrow(
      /Invalid agent tool policy effect for tms\.writeQuoteResult: "mutate"/
    );
  });

  it("rejects invalid explicit tool policy modes with the tool name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quoteops-agent-config-"));
    tempDirs.push(dir);
    const configPath = join(dir, "agent-config.yaml");
    await writeFile(
      configPath,
      [
        "model:",
        "  provider: openrouter",
        "  model_name: nvidia/nemotron-3-ultra-550b-a55b:free",
        "authorization:",
        "  tools:",
        "    email.sendQuote:",
        "      effect: send",
        "      mode: permissive",
        ""
      ].join("\n"),
      "utf8"
    );

    await expect(loadAgentRuntimeConfig(configPath)).rejects.toThrow(
      /Invalid agent tool policy mode for email\.sendQuote: "permissive"/
    );
  });

  it("rejects malformed explicit tool policy objects with the tool name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quoteops-agent-config-"));
    tempDirs.push(dir);
    const configPath = join(dir, "agent-config.yaml");
    await writeFile(
      configPath,
      [
        "model:",
        "  provider: openrouter",
        "  model_name: nvidia/nemotron-3-ultra-550b-a55b:free",
        "authorization:",
        "  tools:",
        "    tms.writeQuoteResult: approval_required",
        ""
      ].join("\n"),
      "utf8"
    );

    await expect(loadAgentRuntimeConfig(configPath)).rejects.toThrow(
      /tool policy for tms\.writeQuoteResult must be an object/
    );
  });

  it("accepts OpenRouter model config for Nemotron guide mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quoteops-agent-config-"));
    tempDirs.push(dir);
    const configPath = join(dir, "agent-config.yaml");
    await writeFile(
      configPath,
      [
        "model:",
        "  provider: openrouter",
        "  model_name: nvidia/nemotron-3-ultra-550b-a55b:free",
        "  temperature: 0",
        "  api_key_env: OPENROUTER_API_KEY",
        "authorization:",
        "  tools:",
        "    route.resolve:",
        "      effect: read",
        "      mode: allowed",
        ""
      ].join("\n"),
      "utf8"
    );

    const config = await loadAgentRuntimeConfig(configPath);

    expect(config.model).toMatchObject({
      provider: "openrouter",
      model_name: "nvidia/nemotron-3-ultra-550b-a55b:free",
      api_key_env: "OPENROUTER_API_KEY"
    });
  });

  it("disables undeclared tools in explicit config files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quoteops-agent-config-"));
    tempDirs.push(dir);
    const configPath = join(dir, "agent-config.yaml");
    await writeFile(
      configPath,
      [
        "model:",
        "  provider: openrouter",
        "  model_name: nvidia/nemotron-3-ultra-550b-a55b:free",
        "authorization:",
        "  tools:",
        "    route.resolve:",
        "      effect: read",
        "      mode: allowed",
        ""
      ].join("\n"),
      "utf8"
    );

    const config = await loadAgentRuntimeConfig(configPath);

    expect(() =>
      assertAgentToolAllowed({ config, toolName: "tms.writeQuoteResult" })
    ).toThrow(/Agent tool is disabled: tms\.writeQuoteResult/);
  });

  it("uses OpenRouter guide text while preserving quote-core rate", async () => {
    const requests: unknown[] = [];
    const client = new OpenRouterGuideClient({
      apiKey: "sk-or-test",
      modelName: "nvidia/nemotron-3-ultra-550b-a55b:free",
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "Mantener tarifa; riesgo operativo controlado." } }]
          })
        );
      }
    });

    const result = await client.recommend({
      base_rate_mxn: 36574.12,
      historical_context: { selected_layer: "route_unit_cost" },
      criteria_context: { matched_nodes: [], summaries: [] }
    });

    expect(result.recommended_rate_mxn).toBe(36574.12);
    expect(result.reason).toContain("Mantener tarifa");
    expect(requests).toHaveLength(1);
  });

  it("can load OpenRouter API key from the local Inducta keys file format", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quoteops-openrouter-key-"));
    tempDirs.push(dir);
    const keysPath = join(dir, "KEYS.md");
    await writeFile(keysPath, "OPENROUTER\nsk-or-test-local-key\n", "utf8");

    const key = await loadOpenRouterApiKey({
      env: {},
      keysPath
    });

    expect(key).toBe("sk-or-test-local-key");
  });

  it("can load OpenRouter API key from the per-client secrets env file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quoteops-openrouter-secrets-"));
    tempDirs.push(dir);
    const envFilePath = join(dir, "client.env");
    await writeFile(envFilePath, 'OPENROUTER_API_KEY="sk-or-secret-env-file"\n', "utf8");

    const key = await loadOpenRouterApiKey({
      env: { QUOTEOPS_SECRETS_ENV_FILE: envFilePath },
      keysPath: null
    });

    expect(key).toBe("sk-or-secret-env-file");
  });

  it("can load SAKBE API key from an INEGI block in the local keys file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quoteops-sakbe-key-"));
    tempDirs.push(dir);
    const keysPath = join(dir, "KEYS.md");
    await writeFile(
      keysPath,
      ["## KEYS", "", "INEGI SAKBE", "sakbe-live-key-1234567890", ""].join("\n"),
      "utf8"
    );

    const key = await loadSakbeApiKey({
      env: {},
      keysPath
    });

    expect(key).toBe("sakbe-live-key-1234567890");
  });

  it("can load SAKBE API key from the per-client secrets env file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quoteops-sakbe-secrets-"));
    tempDirs.push(dir);
    const envFilePath = join(dir, "client.env");
    await writeFile(envFilePath, 'INEGI_SAKBE_KEY="sakbe-secret-env-file-1234567890"\n', "utf8");

    const key = await loadSakbeApiKey({
      env: { QUOTEOPS_SECRETS_ENV_FILE: envFilePath },
      keysPath: null
    });

    expect(key).toBe("sakbe-secret-env-file-1234567890");
  });

  it("does not treat an INEGI DENUE key as a SAKBE key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quoteops-denue-key-"));
    tempDirs.push(dir);
    const keysPath = join(dir, "KEYS.md");
    await writeFile(
      keysPath,
      ["## KEYS", "", "INEGI DENUE", "denue-only-key-1234567890", ""].join("\n"),
      "utf8"
    );

    const key = await loadSakbeApiKey({
      env: {},
      keysPath
    });

    expect(key).toBeNull();
  });

  it("does not treat an unlabelled DENUE token containing sacv as a SAKBE label", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quoteops-denue-token-"));
    tempDirs.push(dir);
    const keysPath = join(dir, "KEYS.md");
    await writeFile(
      keysPath,
      ["## KEYS", "", "INEGI DENUE", "denue-token-sacv-1234567890", ""].join("\n"),
      "utf8"
    );

    const key = await loadSakbeApiKey({
      env: {},
      keysPath
    });

    expect(key).toBeNull();
  });
});
