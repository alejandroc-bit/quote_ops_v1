import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OnboardingError,
  createFileOnboardingStateStore,
  parseOnboardingSelection,
  runOnboarding,
  type OnboardingContext,
  type OnboardingPhase,
  type OnboardingPhaseId
} from "../src/onboard/onboardingFlow.js";
import {
  aiProviderPhase,
  configureAiProvider,
  validateAiProviderCredential
} from "../src/onboard/aiProviderStep.js";
import {
  configureCloudflareTunnel,
  validatePublicHostname
} from "../src/onboard/cloudflareStep.js";
import {
  configureApplianceSecrets,
  runKnowledgeIngestion
} from "../src/onboard/applianceSecretsStep.js";
import {
  readSingleLineSecret,
  updateAllowedEnv
} from "../src/onboard/onboardConfig.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      const { rm } = await import("node:fs/promises");
      await rm(dir, { recursive: true, force: true });
    })
  );
});

describe("resumable onboarding flow", () => {
  it("runs selected phases in order and records non-secret observations", async () => {
    const context = await testContext();
    const calls: string[] = [];
    const phases = [
      phase("ai_provider", calls),
      phase("cloudflare", calls),
      phase("appliance_secrets", calls),
      phase("tms", calls)
    ];

    const result = await runOnboarding({
      phases,
      context,
      selection: { mode: "all" }
    });

    expect(calls).toEqual([
      "ai_provider",
      "cloudflare",
      "appliance_secrets",
      "tms"
    ]);
    expect(result.pending_phases).toEqual([]);
    expect(result.completed_phases).toEqual([
      "ai_provider",
      "cloudflare",
      "appliance_secrets",
      "tms"
    ]);
    const audit = await context.stateStore.load();
    expect(Object.keys(audit)).toEqual(["schema_version", "observed_complete"]);
    expect(
      audit.observed_complete.every(
        (entry) =>
          Object.keys(entry).sort().join(",") === "observed_at,phase"
      )
    ).toBe(true);
  });

  it("derives resume from current truth instead of the audit file", async () => {
    const context = await testContext();
    const calls: string[] = [];
    const current = new Set<OnboardingPhaseId>([
      "ai_provider",
      "cloudflare"
    ]);
    await context.stateStore.save({
      schema_version: 1,
      observed_complete: [
        { phase: "tms", observed_at: "2026-01-01T00:00:00.000Z" }
      ]
    });

    const phases = [
      statefulPhase("ai_provider", current, calls),
      statefulPhase("cloudflare", current, calls),
      statefulPhase("appliance_secrets", current, calls),
      statefulPhase("tms", current, calls)
    ];
    const result = await runOnboarding({
      phases,
      context,
      selection: { mode: "all" }
    });

    expect(calls).toEqual(["appliance_secrets", "tms"]);
    expect(result.pending_phases).toEqual([]);
  });

  it("limits results to through-selection and validates only prerequisites", async () => {
    const context = await testContext();
    const calls: string[] = [];
    const current = new Set<OnboardingPhaseId>();
    const phases = [
      statefulPhase("ai_provider", current, calls),
      statefulPhase("cloudflare", current, calls),
      statefulPhase("knowledge", current, calls),
      statefulPhase("test_rfq", current, calls)
    ];

    const through = await runOnboarding({
      phases,
      context,
      selection: { mode: "through", phase: "knowledge" }
    });
    expect(through.selected_phases).toEqual([
      "ai_provider",
      "cloudflare",
      "knowledge"
    ]);
    expect(through.pending_phases).toEqual([]);
    expect(through.selected_phases).not.toContain("test_rfq");

    current.delete("cloudflare");
    await expect(
      runOnboarding({
        phases,
        context,
        selection: { mode: "only", phase: "test_rfq" }
      })
    ).rejects.toMatchObject({
      code: "onboarding_prerequisite_incomplete",
      phase: "cloudflare"
    });
  });

  it("rejects unknown and conflicting selectors with exit 2", () => {
    expect(() => parseOnboardingSelection(["--until", "not-a-phase"])).toThrow(
      expect.objectContaining({ code: "onboarding_phase_invalid", exitCode: 2 })
    );
    expect(() =>
      parseOnboardingSelection([
        "--until",
        "knowledge",
        "--only",
        "test_rfq"
      ])
    ).toThrow(
      expect.objectContaining({
        code: "onboarding_selection_conflict",
        exitCode: 2
      })
    );
  });
});

describe("AI provider configuration", () => {
  it.each([
    ["openrouter", openRouterResponse()],
    ["gemini", geminiResponse()]
  ] as const)("does not persist a rejected %s key", async (provider) => {
    const context = await testContext({
      fetch: vi.fn().mockResolvedValue(
        new Response("unauthorized", { status: 401 })
      ) as unknown as typeof fetch
    });

    await expect(
      configureAiProvider(
        { provider, api_key: `bad-${provider}-key` },
        context
      )
    ).rejects.toMatchObject({ code: "ai_key_rejected" });
    expect(await readFile(context.paths.clientSecretsFile, "utf8").catch(() => ""))
      .not.toContain(`bad-${provider}-key`);
    expect(
      await readFile(context.paths.agentConfigFile, "utf8").catch(() => "")
    ).not.toContain(provider);
  });

  it.each([
    ["openrouter", openRouterResponse(), "OPENROUTER_API_KEY", "openrouter"],
    ["gemini", geminiResponse(), "GEMINI_API_KEY", "gemini_sdk"]
  ] as const)(
    "writes a valid %s key, runtime config, and safe commit receipt",
    async (provider, response, envKey, runtimeProvider) => {
      const secret = `${provider}=value $ # \"quote\" \\\\ path`;
      const context = await testContext({
        fetch: vi.fn().mockResolvedValue(response) as unknown as typeof fetch
      });

      const result = await configureAiProvider(
        { provider, api_key: secret },
        context
      );

      expect(result).toMatchObject({
        input_provider: provider,
        provider: runtimeProvider,
        api_key_env: envKey
      });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect((await stat(context.paths.clientSecretsFile)).mode & 0o777).toBe(
        0o600
      );
      const config = parseYaml(
        await readFile(context.paths.agentConfigFile, "utf8")
      );
      expect(config.model).toMatchObject({
        provider: runtimeProvider,
        api_key_env: envKey
      });
      const receipt = JSON.parse(
        await readFile(context.paths.aiValidationReceiptFile, "utf8")
      );
      expect(receipt).toMatchObject({
        schema_version: 1,
        input_provider: provider,
        runtime_provider: runtimeProvider,
        live_request: true,
        fallback: false
      });
      expect(JSON.stringify(receipt)).not.toContain(secret);
      const stored = await readFile(context.paths.clientSecretsFile, "utf8");
      expect(stored).toContain(`${envKey}=`);
      expect(stored).not.toContain(
        provider === "gemini" ? "OPENROUTER_API_KEY=" : "GEMINI_API_KEY="
      );
    }
  );

  it("times out fail-closed without writing config or secrets", async () => {
    const context = await testContext({
      fetch: vi.fn(
        async (_url: string | URL | Request, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError"))
            );
          })
      ) as unknown as typeof fetch,
      aiValidationTimeoutMs: 10
    });

    await expect(
      configureAiProvider(
        { provider: "openrouter", api_key: "never-written" },
        context
      )
    ).rejects.toMatchObject({ code: "ai_provider_unreachable" });
    expect(
      await readFile(context.paths.clientSecretsFile, "utf8").catch(() => "")
    ).toBe("");
    expect(
      await readFile(context.paths.agentConfigFile, "utf8").catch(() => "")
    ).toBe("");
  });

  it("revalidates live on resume and does not trust a matching audit entry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(openRouterResponse())
      .mockResolvedValueOnce(openRouterResponse());
    const context = await testContext({
      fetch: fetchMock as unknown as typeof fetch
    });
    await configureAiProvider(
      { provider: "openrouter", api_key: "resume-key" },
      context
    );
    context.answers = null;

    expect(await aiProviderPhase.isComplete(context)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    "ai_client_env",
    "ai_agent_config",
    "ai_credential_revision",
    "ai_validation_receipt"
  ])("recovers after a crash following %s rename", async (crashLabel) => {
    let crashed = false;
    const context = await testContext({
      fetch: vi.fn().mockImplementation(async () => openRouterResponse()) as unknown as typeof fetch,
      afterAtomicRename: async (label) => {
        if (!crashed && label === crashLabel) {
          crashed = true;
          throw new Error("simulated_crash");
        }
      }
    });

    await expect(
      configureAiProvider(
        { provider: "openrouter", api_key: "recoverable-key" },
        context
      )
    ).rejects.toThrow("simulated_crash");
    context.afterAtomicRename = undefined;
    context.answers = null;
    if (await aiProviderPhase.isComplete(context)) {
      expect(crashLabel).toBe("ai_validation_receipt");
    } else {
      await aiProviderPhase.run(context);
    }
    expect(await aiProviderPhase.isComplete(context)).toBe(true);
  });

  it("requests a replacement for a revoked key without deleting unrelated settings", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(openRouterResponse())
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(openRouterResponse())
      .mockResolvedValueOnce(openRouterResponse());
    const context = await testContext({
      fetch: fetchMock as unknown as typeof fetch
    });
    await writeFile(context.paths.clientSecretsFile, 'UNRELATED_SETTING="keep"\n', {
      mode: 0o600
    });
    await configureAiProvider(
      { provider: "openrouter", api_key: "revoked-key" },
      context
    );
    context.io.askMasked = vi.fn(async () => "replacement-key");
    context.io.select = vi.fn(async () => "openrouter" as never);

    expect(await aiProviderPhase.isComplete(context)).toBe(false);
    await aiProviderPhase.run(context);
    expect(await aiProviderPhase.isComplete(context)).toBe(true);
    const stored = await readFile(context.paths.clientSecretsFile, "utf8");
    expect(stored).toContain('UNRELATED_SETTING="keep"');
    expect(stored).not.toContain("revoked-key");
    expect(stored).toContain("replacement-key");
  });

  it("maps a missing model separately from a rejected key", async () => {
    const context = await testContext({
      fetch: vi.fn().mockResolvedValue(
        new Response("not found", { status: 404 })
      ) as unknown as typeof fetch
    });
    await expect(
      validateAiProviderCredential(
        { provider: "openrouter", api_key: "valid-format" },
        context
      )
    ).rejects.toMatchObject({ code: "model_not_available" });
  });
});

describe("secret ingestion", () => {
  it("round-trips shell-active values through Docker Compose's env-file parser", async () => {
    const context = await testContext();
    const value =
      'part=one $dollar #hash "double quotes" and \'single quotes\' C:\\path with spaces';
    await updateAllowedEnv(
      context.paths.clientSecretsFile,
      { OPENROUTER_API_KEY: value },
      ["OPENROUTER_API_KEY"]
    );
    const composeFile = join(
      dirname(context.paths.clientSecretsFile),
      "compose.yaml"
    );
    await writeFile(
      composeFile,
      [
        "services:",
        "  parser:",
        "    image: busybox",
        "    env_file:",
        "      - client.env",
        ""
      ].join("\n")
    );

    const parsed = spawnSync(
      "docker",
      ["compose", "-f", composeFile, "config", "--format", "json"],
      { encoding: "utf8" }
    );
    expect(parsed.status, parsed.stderr).toBe(0);
    const config = JSON.parse(parsed.stdout);
    // Compose's config model represents a literal runtime `$` as `$$`; the
    // engine collapses that escape when materializing the container env.
    expect(
      config.services.parser.environment.OPENROUTER_API_KEY.replace(
        /\$\$/g,
        "$"
      )
    ).toBe(value);
  });

  it("accepts one terminal LF but rejects injection without modifying the env file", async () => {
    const context = await testContext();
    const secretFile = join(dirname(context.paths.clientSecretsFile), "input.key");
    await writeFile(secretFile, "valid-value\n", { mode: 0o600 });
    await chmod(secretFile, 0o600);
    expect(await readSingleLineSecret({ file: secretFile }, context)).toBe(
      "valid-value"
    );

    await writeFile(context.paths.clientSecretsFile, 'SAFE="before"\n', {
      mode: 0o600
    });
    await expect(
      updateAllowedEnv(
        context.paths.clientSecretsFile,
        { OPENROUTER_API_KEY: "token\nEVIL_KEY=value" },
        ["OPENROUTER_API_KEY", "GEMINI_API_KEY"]
      )
    ).rejects.toMatchObject({ code: "secret_invalid" });
    expect(await readFile(context.paths.clientSecretsFile, "utf8")).toBe(
      'SAFE="before"\n'
    );
  });

  it("rejects an answer path that escapes through a parent-directory symlink", async () => {
    const context = await testContext();
    const external = await mkdtemp(join(tmpdir(), "quoteops-secret-external-"));
    tempDirs.push(external);
    await writeFile(join(external, "key"), "outside-secret", { mode: 0o600 });
    const linkedDir = join(context.answersRoot!, "linked");
    await symlink(external, linkedDir);

    await expect(
      readSingleLineSecret({ file: join(linkedDir, "key") }, context)
    ).rejects.toMatchObject({ code: "secret_file_unsafe" });
  });
});

describe("appliance provider secrets", () => {
  it("configures and probes Resend without requesting or retaining IMAP values", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ id: "email-validation-id" }, { status: 200 })
    );
    const context = await testContext({
      fetch: fetchMock as unknown as typeof fetch
    });
    const resendKey = await secretRef(context, "resend.key", "re_send=secret");
    const sakbeKey = await secretRef(context, "sakbe.key", "sakbe-secret");
    const embeddingKey = await secretRef(
      context,
      "embedding.key",
      "embedding-secret"
    );

    await configureApplianceSecrets(
      {
        mailbox: {
          provider: "resend",
          api_key: resendKey,
          intake_address: "intake@example.com",
          from_address: "quotes@example.com"
        },
        sakbe: { api_key: sakbeKey },
        embeddings: {
          provider: "gemini",
          model: "text-embedding-004",
          api_key: embeddingKey
        }
      },
      context
    );

    const config = parseYaml(
      await readFile(context.paths.agentConfigFile, "utf8")
    );
    expect(config.mailbox).toEqual({
      provider: "resend",
      auth: "password",
      processed_mailbox: null,
      poll_interval_ms: 60000,
      imap_host: null,
      imap_port: null
    });
    expect(config.embeddings).toMatchObject({
      provider: "gemini",
      model: "text-embedding-004",
      api_key_env: "QUOTEOPS_EMBEDDING_API_KEY",
      base_url: null
    });
    const env = await readFile(context.paths.clientSecretsFile, "utf8");
    expect(env).toContain("RESEND_API_KEY=");
    expect(env).toContain('MAILBOX_USER="intake@example.com"');
    expect(env).toContain('MAILBOX_FROM="quotes@example.com"');
    expect(env).not.toContain("MAILBOX_PASSWORD=");
    const request = fetchMock.mock.calls[0]!;
    expect(String(request[0])).toBe("https://api.resend.com/emails");
    expect((request[1] as RequestInit).headers).toMatchObject({
      "Idempotency-Key": expect.any(String)
    });
    const receipt = JSON.parse(
      await readFile(context.paths.mailboxProbeReceiptFile, "utf8")
    );
    expect(receipt).toMatchObject({
      schema_version: 1,
      provider: "resend",
      status: "ok"
    });
    expect(JSON.stringify(receipt)).not.toMatch(
      /re_send=secret|email-validation-id|QuoteOps onboarding validation/
    );
  });

  it("configures IMAP exclusively and uses the injected TLS probe", async () => {
    const probeImap = vi.fn(async () => undefined);
    const context = await testContext({ probeImap });
    const password = await secretRef(context, "imap.key", "imap-password");

    await configureApplianceSecrets(
      {
        mailbox: {
          provider: "imap",
          user: "quotes@example.com",
          password,
          host: "imap.example.com",
          port: 993
        }
      },
      context
    );

    expect(probeImap).toHaveBeenCalledWith({
      host: "imap.example.com",
      port: 993,
      user: "quotes@example.com",
      password: "imap-password",
      timeoutMs: 10_000
    });
    const env = await readFile(context.paths.clientSecretsFile, "utf8");
    expect(env).toContain("MAILBOX_PASSWORD=");
    expect(env).not.toContain("RESEND_API_KEY=");
    const config = parseYaml(
      await readFile(context.paths.agentConfigFile, "utf8")
    );
    expect(config.mailbox).toMatchObject({
      provider: "imap",
      auth: "password",
      imap_host: "imap.example.com",
      imap_port: 993
    });
  });

  it("stages bounded knowledge sources and commits only safe ingestion evidence", async () => {
    const context = await testContext({
      fetch: vi.fn().mockResolvedValue(
        Response.json(
          {
            document_count: 1,
            ingested: [{ filename: "source.md", chunk_count: 3 }]
          },
          { status: 202 }
        )
      ) as unknown as typeof fetch
    });
    const source = join(context.answersRoot!, "source.md");
    await writeFile(source, "# private document\nconfidential body\n", {
      mode: 0o600
    });
    context.answers = {
      schema_version: 1,
      knowledge: {
        sources: [{ file: source }],
        consent_external_embedding_transfer: true
      }
    };
    await writeFile(
      context.paths.agentConfigFile,
      [
        "embeddings:",
        "  provider: gemini",
        "  model: text-embedding-004",
        "  api_key_env: QUOTEOPS_EMBEDDING_API_KEY",
        "  base_url: null",
        ""
      ].join("\n"),
      { mode: 0o600 }
    );
    await updateAllowedEnv(
      context.paths.clientSecretsFile,
      { QUOTEOPS_EMBEDDING_API_KEY: "embedding-secret" },
      ["QUOTEOPS_EMBEDDING_API_KEY"]
    );

    await runKnowledgeIngestion(context);

    const receipt = JSON.parse(
      await readFile(context.paths.knowledgeReceiptFile, "utf8")
    );
    expect(receipt).toMatchObject({
      schema_version: 1,
      document_count: 1,
      chunk_count: 3,
      consent_external_embedding_transfer: true
    });
    expect(receipt.source_hashes).toHaveLength(1);
    expect(JSON.stringify(receipt)).not.toContain("confidential body");
  });
});

describe("Cloudflare configuration", () => {
  it.each([
    "",
    "127.0.0.1",
    "localhost",
    "quotes.internal",
    "UPPER.example",
    `${"a".repeat(64)}.example`
  ])("rejects unsafe hostname syntax %j", async (hostname) => {
    await expect(
      validatePublicHostname(hostname, async () => ["8.8.8.8"])
    ).rejects.toMatchObject({ code: "cloudflare_hostname_invalid" });
  });

  it("rejects public-looking hostnames that resolve privately", async () => {
    await expect(
      validatePublicHostname("quotes.client.example", async () => [
        "203.0.113.10",
        "10.0.0.2"
      ])
    ).rejects.toMatchObject({ code: "cloudflare_hostname_unsafe" });
  });

  it("stores credentials only in their dedicated root-only files", async () => {
    const context = await testContext({
      resolveHostname: async () => ["93.184.216.34"]
    });
    const credentials = {
      public_hostname: "quotes.client.example",
      tunnel_token: "tunnel-secret",
      access_client_id: "client.access",
      access_client_secret: "access-secret"
    };

    const result = await configureCloudflareTunnel(credentials, context);
    const accessFile = join(
      dirname(context.paths.settingsDir),
      "secrets/cloudflare-access-validation.env"
    );
    const settings = JSON.parse(
      await readFile(join(context.paths.settingsDir, "cloudflare.json"), "utf8")
    );
    const serialized = JSON.stringify({ result, settings });

    expect(result).toEqual({
      provider: "cloudflare",
      public_hostname: "quotes.client.example",
      origin_url: "http://caddy:80"
    });
    expect(
      await readFile(context.paths.cloudflareSecretsFile, "utf8")
    ).toContain("TUNNEL_TOKEN=");
    expect(
      await readFile(context.paths.clientSecretsFile, "utf8").catch(() => "")
    ).not.toContain("TUNNEL_TOKEN=");
    expect((await stat(accessFile)).mode & 0o777).toBe(0o600);
    for (const value of [
      credentials.tunnel_token,
      credentials.access_client_id,
      credentials.access_client_secret
    ]) {
      expect(serialized).not.toContain(value);
    }
  });
});

function phase(id: OnboardingPhaseId, calls: string[]): OnboardingPhase {
  let complete = false;
  return {
    id,
    async isComplete() {
      return complete;
    },
    async run() {
      calls.push(id);
      complete = true;
    }
  };
}

function statefulPhase(
  id: OnboardingPhaseId,
  complete: Set<OnboardingPhaseId>,
  calls: string[]
): OnboardingPhase {
  return {
    id,
    async isComplete() {
      return complete.has(id);
    },
    async run() {
      calls.push(id);
      complete.add(id);
    }
  };
}

async function testContext(
  overrides: Partial<OnboardingContext> = {}
): Promise<OnboardingContext> {
  const home = await mkdtemp(join(tmpdir(), "quoteops-onboarding-flow-"));
  tempDirs.push(home);
  const paths = {
    apiBaseUrl: "http://127.0.0.1:9",
    agentConfigFile: join(home, "connectors/agent/agent-config.yaml"),
    clientSecretsFile: join(home, "secrets/client.env"),
    cloudflareSecretsFile: join(home, "secrets/cloudflare.env"),
    aiValidationReceiptFile: join(
      home,
      "settings/ai-provider-validation.json"
    ),
    mailboxProbeReceiptFile: join(home, "settings/mailbox-probe.json"),
    knowledgeReceiptFile: join(home, "settings/knowledge-ingest.json"),
    settingsDir: join(home, "settings"),
    onboardingStateFile: join(home, "settings/onboarding-state.json"),
    tmsAdapterConfigFile: join(home, "connectors/tms-adapter.yaml"),
    tmsProbeFile: join(home, "settings/tms-probe.json"),
    testRfqReceiptFile: join(home, "settings/test-rfq.json")
  };
  await Promise.all([
    mkdir(dirname(paths.agentConfigFile), { recursive: true }),
    mkdir(dirname(paths.clientSecretsFile), { recursive: true }),
    mkdir(paths.settingsDir, { recursive: true })
  ]);
  const io = {
    ask: vi.fn(async () => ""),
    askMasked: vi.fn(async () => ""),
    confirm: vi.fn(async () => false),
    select: vi.fn(async () => "openrouter" as never),
    info: vi.fn(),
    warn: vi.fn()
  };
  const context: OnboardingContext = {
    io,
    env: {},
    paths,
    guided: true,
    answers: null,
    fetch,
    stateStore: createFileOnboardingStateStore(paths.onboardingStateFile),
    answersRoot: home,
    resolveHostname: async () => ["93.184.216.34"],
    ...overrides
  };
  return context;
}

function openRouterResponse(): Response {
  return Response.json({ choices: [{ message: { content: "ok" } }] });
}

function geminiResponse(): Response {
  return Response.json({
    candidates: [{ content: { parts: [{ text: "ok" }] } }]
  });
}

async function secretRef(
  context: OnboardingContext,
  filename: string,
  value: string
): Promise<{ file: string }> {
  const file = join(context.answersRoot!, filename);
  await writeFile(file, value, { mode: 0o600 });
  await chmod(file, 0o600);
  return { file };
}
