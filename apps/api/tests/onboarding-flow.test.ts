import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
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
  activateLicenseFromOnboarding,
  licenseActivationPhase
} from "../src/onboard/licenseActivationStep.js";
import {
  deterministicReadinessRunId,
  readinessRfqRequest,
  requestSha256ForReadinessRfq,
  runTestRfqPhase,
  testRfqPhase
} from "../src/onboard/testRfqStep.js";
import {
  configureCloudflareTunnel,
  validatePublicHostname
} from "../src/onboard/cloudflareStep.js";
import {
  applianceSecretsPhase,
  configureApplianceSecrets,
  isApplianceSecretsComplete,
  runKnowledgeIngestion
} from "../src/onboard/applianceSecretsStep.js";
import {
  readSingleLineSecret,
  sha256File,
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
      phase("license_activation", calls),
      phase("cloudflare", calls),
      phase("appliance_secrets", calls),
      phase("tms", calls),
      phase("units", calls),
      phase("authorization", calls),
      phase("pricing", calls),
      phase("knowledge", calls),
      phase("test_rfq", calls)
    ];

    const result = await runOnboarding({
      phases,
      context,
      selection: { mode: "all" }
    });

    expect(calls).toEqual([
      "ai_provider",
      "license_activation",
      "cloudflare",
      "appliance_secrets",
      "tms",
      "units",
      "authorization",
      "pricing",
      "knowledge",
      "test_rfq"
    ]);
    expect(result.pending_phases).toEqual([]);
    expect(result.completed_phases).toEqual([
      "ai_provider",
      "license_activation",
      "cloudflare",
      "appliance_secrets",
      "tms",
      "units",
      "authorization",
      "pricing",
      "knowledge",
      "test_rfq"
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

  it("activates the authorized email through the fixed internal API and confirms the persisted license", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let activated = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/api/setup-state")) {
        return Response.json({
          activation: {
            required: true,
            status: activated ? "unlocked" : "locked",
            client_id: "CLIENT-001",
            installation_id: "INSTALL-001"
          },
          required_steps: activated ? [] : ["activate_license"]
        });
      }
      activated = true;
      return Response.json({
        activated: true,
        client_id: "CLIENT-001",
        installation_id: "INSTALL-001"
      });
    });
    const context = await testContext({
      guided: false,
      answers: {
        schema_version: 1,
        activation: { authorized_email: "owner@example.com" }
      },
      env: {
        QUOTEOPS_CLIENT_ID: "CLIENT-001",
        QUOTEOPS_INSTALLATION_ID: "INSTALL-001"
      },
      fetch: fetchMock as unknown as typeof fetch
    });

    expect(await licenseActivationPhase.isComplete(context)).toBe(false);
    await licenseActivationPhase.run(context);
    expect(await licenseActivationPhase.isComplete(context)).toBe(true);
    expect(requests.map((request) => request.url)).toEqual([
      "http://quoteops-api:8080/api/setup-state",
      "http://quoteops-api:8080/api/onboarding/activate",
      "http://quoteops-api:8080/api/setup-state",
      "http://quoteops-api:8080/api/setup-state"
    ]);
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      email: "owner@example.com"
    });
  });

  it("does not mutate activation when the current valid license matches this appliance", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        activation: {
          required: true,
          status: "unlocked",
          client_id: "CLIENT-001",
          installation_id: "INSTALL-001"
        },
        required_steps: []
      })
    );
    const context = await testContext({
      env: {
        QUOTEOPS_CLIENT_ID: "CLIENT-001",
        QUOTEOPS_INSTALLATION_ID: "INSTALL-001"
      },
      fetch: fetchMock as unknown as typeof fetch
    });

    expect(await licenseActivationPhase.isComplete(context)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps an activation timeout to a safe code and never accepts an alternate origin", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true
          });
        })
    );

    await expect(
      activateLicenseFromOnboarding({
        email: "owner@example.com",
        fetch: fetchMock as unknown as typeof fetch
      })
    ).rejects.toMatchObject({ code: "activation_unreachable" });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://quoteops-api:8080/api/onboarding/activate"
    );

    const context = await testContext({
      env: {
        QUOTEOPS_ONBOARD_API_URL: "https://attacker.example",
        QUOTEOPS_CLIENT_ID: "CLIENT-001",
        QUOTEOPS_INSTALLATION_ID: "INSTALL-001"
      },
      fetch: fetchMock as unknown as typeof fetch
    });
    await expect(licenseActivationPhase.isComplete(context)).rejects.toMatchObject({
      code: "onboarding_api_origin_invalid"
    });
  }, 15_000);

  it("reuses an approved test RFQ receipt on resume without posting again", async () => {
    const context = await testContext({
      env: { QUOTEOPS_INSTALLATION_ID: "INSTALL-001" }
    });
    const runId = deterministicReadinessRunId("INSTALL-001");
    await writeFile(
      context.paths.testRfqReceiptFile,
      JSON.stringify({
        schema_version: 1,
        run_id: runId,
        request_sha256: requestSha256ForReadinessRfq(),
        state: "complete",
        submitted_at: "2026-07-30T00:00:00.000Z",
        completed_at: "2026-07-30T00:00:02.000Z",
        base_quote_status: "APPROVED",
        approval_required: false
      }),
      { mode: 0o600 }
    );
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe(`http://quoteops-api:8080/api/rfqs/${runId}`);
      return Response.json(passingTestRfq(runId));
    });
    context.fetch = fetchMock as unknown as typeof fetch;

    expect(await testRfqPhase.isComplete(context)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "POST")
    ).toBe(false);
  });

  it("keeps a completed receipt pending when the referenced RFQ requires review", async () => {
    const context = await testContext({
      env: { QUOTEOPS_INSTALLATION_ID: "INSTALL-001" }
    });
    const runId = deterministicReadinessRunId("INSTALL-001");
    await writeFile(
      context.paths.testRfqReceiptFile,
      JSON.stringify({
        schema_version: 1,
        run_id: runId,
        request_sha256: requestSha256ForReadinessRfq(),
        state: "complete",
        submitted_at: "2026-07-30T00:00:00.000Z",
        completed_at: "2026-07-30T00:00:02.000Z",
        base_quote_status: "APPROVED",
        approval_required: false
      }),
      { mode: 0o600 }
    );
    context.fetch = vi.fn(async () =>
      Response.json({
        ...passingTestRfq(runId),
        status: "REVIEW_REQUIRED",
        approval_required: true,
        base_quote: { status: "REVIEW_REQUIRED", base_rate_mxn: 42_000 }
      })
    ) as unknown as typeof fetch;

    expect(await testRfqPhase.isComplete(context)).toBe(false);
  });

  it.each([
    {
      label: "corrupt",
      contents: "{not-json",
      code: "test_rfq_receipt_invalid"
    },
    {
      label: "mismatched",
      contents: JSON.stringify({
        schema_version: 1,
        run_id: deterministicReadinessRunId("INSTALL-001"),
        request_sha256: "f".repeat(64),
        state: "submitted",
        submitted_at: "2026-07-30T00:00:00.000Z"
      }),
      code: "test_rfq_receipt_mismatch"
    }
  ])("fails closed for a $label test RFQ receipt", async ({ contents, code }) => {
    const context = await testContext({
      env: { QUOTEOPS_INSTALLATION_ID: "INSTALL-001" }
    });
    const fetchMock = vi.fn();
    context.fetch = fetchMock as unknown as typeof fetch;
    await writeFile(context.paths.testRfqReceiptFile, contents, { mode: 0o600 });

    await expect(testRfqPhase.isComplete(context)).rejects.toMatchObject({ code });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("writes test RFQ intent before POST and resumes with GET first after interruption", async () => {
    const context = await testContext({
      env: { QUOTEOPS_INSTALLATION_ID: "INSTALL-001" },
      afterAtomicRename(label) {
        if (label === "test_rfq_submitted") {
          throw new Error("crash-after-intent");
        }
      }
    });
    const firstFetch = vi.fn();
    context.fetch = firstFetch as unknown as typeof fetch;

    await expect(runTestRfqPhase(context)).rejects.toThrow("crash-after-intent");
    expect(firstFetch).not.toHaveBeenCalled();
    const receipt = JSON.parse(
      await readFile(context.paths.testRfqReceiptFile, "utf8")
    );
    expect(receipt).toMatchObject({
      schema_version: 1,
      request_sha256: requestSha256ForReadinessRfq(),
      state: "submitted"
    });

    context.afterAtomicRename = undefined;
    let getCount = 0;
    let postCount = 0;
    context.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        postCount += 1;
        expect(JSON.parse(String(init.body))).toMatchObject({
          ...readinessRfqRequest,
          run_id: receipt.run_id,
          request_sha256: receipt.request_sha256
        });
        return Response.json({ run_id: receipt.run_id }, { status: 202 });
      }
      getCount += 1;
      return getCount === 1
        ? Response.json({ error: "workflow_run_not_found" }, { status: 404 })
        : Response.json(passingTestRfq(receipt.run_id));
    }) as unknown as typeof fetch;

    await runTestRfqPhase(context, { pollIntervalMs: 0, timeoutMs: 1_000 });
    expect(getCount).toBe(2);
    expect(postCount).toBe(1);
  });

  it("resumes with GET after an accepted POST response is lost", async () => {
    const context = await testContext({
      env: { QUOTEOPS_INSTALLATION_ID: "INSTALL-001" }
    });
    let workflowAccepted = false;
    const firstFetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          workflowAccepted = true;
          throw new Error("response-lost-after-accept");
        }
        return Response.json({ error: "workflow_run_not_found" }, { status: 404 });
      }
    );
    context.fetch = firstFetch as unknown as typeof fetch;

    await expect(
      runTestRfqPhase(context, { pollIntervalMs: 0, timeoutMs: 1_000 })
    ).rejects.toMatchObject({ code: "test_rfq_unreachable" });
    expect(workflowAccepted).toBe(true);

    const resumeFetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        expect(init?.method).not.toBe("POST");
        return Response.json(
          passingTestRfq(deterministicReadinessRunId("INSTALL-001"))
        );
      }
    );
    context.fetch = resumeFetch as unknown as typeof fetch;

    await runTestRfqPhase(context, { pollIntervalMs: 0, timeoutMs: 1_000 });
    expect(resumeFetch).toHaveBeenCalledTimes(1);
  });

  it("resumes polling an accepted RFQ without posting a second workflow", async () => {
    const context = await testContext({
      env: { QUOTEOPS_INSTALLATION_ID: "INSTALL-001" }
    });
    let call = 0;
    context.fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        call += 1;
        if (call === 1) {
          return Response.json(
            { error: "workflow_run_not_found" },
            { status: 404 }
          );
        }
        if (call === 2) {
          expect(init?.method).toBe("POST");
          return Response.json(
            { run_id: deterministicReadinessRunId("INSTALL-001") },
            { status: 202 }
          );
        }
        if (call === 3) {
          return Response.json({
            run_id: deterministicReadinessRunId("INSTALL-001"),
            status: "RECEIVED",
            approval_required: false,
            base_quote: null
          });
        }
        throw new Error("poll-interrupted");
      }
    ) as unknown as typeof fetch;

    await expect(
      runTestRfqPhase(context, { pollIntervalMs: 0, timeoutMs: 1_000 })
    ).rejects.toMatchObject({ code: "test_rfq_unreachable" });
    expect(call).toBe(4);

    const resumeFetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        expect(init?.method).not.toBe("POST");
        return Response.json(
          passingTestRfq(deterministicReadinessRunId("INSTALL-001"))
        );
      }
    );
    context.fetch = resumeFetch as unknown as typeof fetch;

    await runTestRfqPhase(context, { pollIntervalMs: 0, timeoutMs: 1_000 });
    expect(resumeFetch).toHaveBeenCalledTimes(1);
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
    expect(() =>
      parseOnboardingSelection([
        "--allow-static-guidance",
        "--answers-file",
        "answers.json"
      ])
    ).toThrow(
      expect.objectContaining({
        code: "onboarding_selection_conflict",
        exitCode: 2
      })
    );
    expect(() =>
      parseOnboardingSelection([
        "--answers-file",
        "answers.json",
        "--sync-units"
      ])
    ).toThrow(
      expect.objectContaining({
        code: "onboarding_selection_conflict",
        exitCode: 2
      })
    );
  });

  it.each([
    "ai_provider",
    "cloudflare",
    "appliance_secrets",
    "tms",
    "units",
    "authorization",
    "pricing",
    "knowledge"
  ] as const)(
    "returns onboarding_pending for missing noninteractive %s answers before running the phase",
    async (target) => {
      const context = await testContext({
        guided: false,
        answers: { schema_version: 1 }
      });
      const calls: string[] = [];
      const ordered: OnboardingPhaseId[] = [
        "ai_provider",
        "cloudflare",
        "appliance_secrets",
        "tms",
        "units",
        "authorization",
        "pricing",
        "knowledge"
      ];
      const phases = ordered.slice(0, ordered.indexOf(target) + 1).map((id) => ({
        id,
        async isComplete() {
          return id !== target;
        },
        async run() {
          calls.push(id);
        }
      }));

      await expect(
        runOnboarding({
          phases,
          context,
          selection: { mode: "only", phase: target }
        })
      ).rejects.toMatchObject({
        code: "onboarding_pending",
        phase: target
      });
      expect(calls).toEqual([]);
      expect(context.io.ask).not.toHaveBeenCalled();
      expect(context.io.askMasked).not.toHaveBeenCalled();
      expect(context.io.confirm).not.toHaveBeenCalled();
      expect(context.io.select).not.toHaveBeenCalled();
    }
  );

  it("keeps an enabled mailbox pending when unattended answers omit it", async () => {
    const context = await testContext({ guided: false });
    const embeddingKey = await secretRef(
      context,
      "enabled-omission-embedding.key",
      "embedding-secret"
    );
    context.answers = {
      schema_version: 1,
      embeddings: {
        provider: "gemini",
        model: "text-embedding-004",
        api_key: embeddingKey
      }
    };
    const enabledConfig = [
      "unrelated:",
      "  keep: true",
      "mailbox:",
      "  provider: resend",
      "  auth: password",
      "  processed_mailbox: null",
      "  poll_interval_ms: 60000",
      "  imap_host: null",
      "  imap_port: null",
      ""
    ].join("\n");
    await writeFile(
      context.paths.clientSecretsFile,
      'UNRELATED_SETTING="keep"\nRESEND_API_KEY="old-key"\nMAILBOX_USER="intake@example.com"\nMAILBOX_FROM="quotes@example.com"\n',
      { mode: 0o600 }
    );
    await writeFile(context.paths.agentConfigFile, enabledConfig, {
      mode: 0o600
    });

    await expect(applianceSecretsPhase.run(context)).rejects.toMatchObject({
      code: "onboarding_pending",
      phase: "appliance_secrets"
    });
    expect(await readFile(context.paths.clientSecretsFile, "utf8")).toContain(
      'RESEND_API_KEY="old-key"'
    );
    expect(await readFile(context.paths.agentConfigFile, "utf8")).toBe(
      enabledConfig
    );
    expect(context.io.ask).not.toHaveBeenCalled();
    expect(context.io.askMasked).not.toHaveBeenCalled();
  });

  it("keeps appliance setup pending when unattended answers omit embeddings", async () => {
    const context = await testContext({
      guided: false,
      answers: {
        schema_version: 1,
        mailbox: {
          provider: "resend",
          api_key: { file: "/unused" },
          intake_address: "intake@example.com",
          from_address: "quotes@example.com"
        }
      }
    });
    await writeFile(
      context.paths.clientSecretsFile,
      'UNRELATED_SETTING="keep"\n',
      { mode: 0o600 }
    );
    await writeFile(
      context.paths.agentConfigFile,
      "unrelated:\n  keep: true\n",
      { mode: 0o600 }
    );

    await expect(applianceSecretsPhase.run(context)).rejects.toMatchObject({
      code: "onboarding_pending",
      phase: "appliance_secrets"
    });
    expect(await readFile(context.paths.clientSecretsFile, "utf8")).toBe(
      'UNRELATED_SETTING="keep"\n'
    );
    expect(await readFile(context.paths.agentConfigFile, "utf8")).toBe(
      "unrelated:\n  keep: true\n"
    );
  });

  it("completes the generated default with embeddings and mailbox disabled", async () => {
    const context = await testContext({ guided: false });
    const embeddingKey = await secretRef(
      context,
      "disabled-mailbox-embedding.key",
      "embedding-secret"
    );
    context.answers = {
      schema_version: 1,
      embeddings: {
        provider: "gemini",
        model: "text-embedding-004",
        api_key: embeddingKey
      }
    };
    await writeFile(
      context.paths.agentConfigFile,
      "unrelated:\n  keep: true\n",
      { mode: 0o600 }
    );
    const phases: OnboardingPhase[] = [
      {
        id: "ai_provider",
        async isComplete() {
          return true;
        },
        async run() {
          throw new Error("unexpected");
        }
      },
      {
        id: "cloudflare",
        async isComplete() {
          return true;
        },
        async run() {
          throw new Error("unexpected");
        }
      },
      applianceSecretsPhase
    ];

    await runOnboarding({
      phases,
      context,
      selection: { mode: "only", phase: "appliance_secrets" }
    });

    const config = parseYaml(
      await readFile(context.paths.agentConfigFile, "utf8")
    );
    const env = await readFile(context.paths.clientSecretsFile, "utf8");
    expect(config.mailbox).toBeUndefined();
    expect(config.embeddings).toMatchObject({
      provider: "gemini",
      api_key_env: "QUOTEOPS_EMBEDDING_API_KEY"
    });
    expect(env).toContain("QUOTEOPS_EMBEDDING_API_KEY=");
    expect(env).not.toMatch(
      /RESEND_API_KEY|MAILBOX_USER|MAILBOX_FROM|MAILBOX_PASSWORD/
    );
    expect(
      await readFile(context.paths.mailboxProbeReceiptFile, "utf8").catch(
        () => ""
      )
    ).toBe("");
    expect(await isApplianceSecretsComplete(context)).toBe(true);
  });

  it("rejects mailbox answers when current configuration keeps mailbox disabled", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("mailbox probe must not run");
    });
    const context = await testContext({
      guided: false,
      fetch: fetchMock as unknown as typeof fetch
    });
    const mailboxKey = await secretRef(
      context,
      "unexpected-disabled-mailbox.key",
      "mailbox-secret"
    );
    const embeddingKey = await secretRef(
      context,
      "disabled-authority-embedding.key",
      "embedding-secret"
    );
    context.answers = {
      schema_version: 1,
      mailbox: {
        provider: "resend",
        api_key: mailboxKey,
        intake_address: "intake@example.com",
        from_address: "quotes@example.com"
      },
      embeddings: {
        provider: "gemini",
        model: "text-embedding-004",
        api_key: embeddingKey
      }
    };
    const originalConfig = "unrelated:\n  keep: true\n";
    const originalEnv = 'UNRELATED_SETTING="keep"\n';
    await writeFile(context.paths.agentConfigFile, originalConfig, {
      mode: 0o600
    });
    await writeFile(context.paths.clientSecretsFile, originalEnv, {
      mode: 0o600
    });
    const phases: OnboardingPhase[] = [
      {
        id: "ai_provider",
        async isComplete() {
          return true;
        },
        async run() {
          throw new Error("unexpected");
        }
      },
      {
        id: "cloudflare",
        async isComplete() {
          return true;
        },
        async run() {
          throw new Error("unexpected");
        }
      },
      applianceSecretsPhase
    ];

    await expect(
      runOnboarding({
        phases,
        context,
        selection: { mode: "only", phase: "appliance_secrets" }
      })
    ).rejects.toMatchObject({
      code: "onboarding_pending",
      phase: "appliance_secrets"
    });
    await expect(applianceSecretsPhase.run(context)).rejects.toMatchObject({
      code: "onboarding_pending",
      phase: "appliance_secrets"
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readFile(context.paths.agentConfigFile, "utf8")).toBe(
      originalConfig
    );
    expect(await readFile(context.paths.clientSecretsFile, "utf8")).toBe(
      originalEnv
    );
    expect(
      await readFile(context.paths.mailboxProbeReceiptFile, "utf8").catch(
        () => ""
      )
    ).toBe("");
  });

  it("keeps a disabled mailbox incomplete while stale managed keys remain", async () => {
    const context = await testContext();
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
      {
        QUOTEOPS_EMBEDDING_API_KEY: "embedding-secret",
        RESEND_API_KEY: "stale-mailbox-key"
      },
      ["QUOTEOPS_EMBEDDING_API_KEY", "RESEND_API_KEY"]
    );

    expect(await isApplianceSecretsComplete(context)).toBe(false);
  });

  it("does not interpret a malformed declared mailbox as disabled", async () => {
    const context = await testContext();
    await writeFile(
      context.paths.agentConfigFile,
      [
        "mailbox: malformed",
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

    expect(await isApplianceSecretsComplete(context)).toBe(false);
  });

  it("rejects an oversized answers file before parsing it", async () => {
    const module = (await import(
      "../src/onboard/onboardingFlow.js"
    )) as typeof import("../src/onboard/onboardingFlow.js") & {
      readOnboardingAnswersFile?: (file: string) => Promise<unknown>;
    };
    expect(module.readOnboardingAnswersFile).toBeTypeOf("function");
    if (!module.readOnboardingAnswersFile) return;
    const context = await testContext();
    const file = join(context.answersRoot!, "oversized-answers.json");
    await writeFile(file, " ".repeat(65 * 1024), { mode: 0o600 });

    await expect(module.readOnboardingAnswersFile(file)).rejects.toMatchObject({
      code: "onboarding_answers_invalid",
      exitCode: 2
    });
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

  it("applies one AI deadline across fetch and body parsing", async () => {
    const bodySentinel = "provider-body-must-not-leak";
    const secret = "ai-secret-must-not-leak";
    const context = await testContext({
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () =>
          await new Promise<unknown>(() => {
            void bodySentinel;
          })
      }) as unknown as typeof fetch,
      aiValidationTimeoutMs: 10
    });

    let caught: unknown;
    try {
      await configureAiProvider(
        { provider: "openrouter", api_key: secret },
        context
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "ai_provider_unreachable" });
    expect(String(caught)).not.toContain(secret);
    expect(String(caught)).not.toContain(bodySentinel);
    expect(
      await readFile(context.paths.clientSecretsFile, "utf8").catch(() => "")
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

  it.each([
    ["openrouter", "gemini"],
    ["gemini", "openrouter"]
  ] as const)(
    "recovers a %s to %s switch after every atomic rename",
    async (fromProvider, toProvider) => {
      const responseFor = (url: string | URL | Request) =>
        String(url).includes("generativelanguage")
          ? geminiResponse()
          : openRouterResponse();
      for (const crashLabel of [
        "ai_client_env",
        "ai_agent_config",
        "ai_credential_revision",
        "ai_validation_receipt"
      ]) {
        const context = await testContext({
          fetch: vi.fn(async (url) => responseFor(url)) as unknown as typeof fetch
        });
        await configureAiProvider(
          { provider: fromProvider, api_key: `${fromProvider}-old-key` },
          context
        );
        let crashed = false;
        context.afterAtomicRename = async (label) => {
          if (!crashed && label === crashLabel) {
            crashed = true;
            throw new Error(`switch-crash-${crashLabel}`);
          }
        };
        await expect(
          configureAiProvider(
            { provider: toProvider, api_key: `${toProvider}-new-key` },
            context
          )
        ).rejects.toThrow(`switch-crash-${crashLabel}`);

        context.afterAtomicRename = undefined;
        context.answers = null;
        if (!(await aiProviderPhase.isComplete(context))) {
          await aiProviderPhase.run(context);
        }
        expect(await aiProviderPhase.isComplete(context)).toBe(true);
        const stored = await readFile(context.paths.clientSecretsFile, "utf8");
        expect(stored).toContain(`${toProvider}-new-key`);
        expect(stored).not.toContain(`${fromProvider}-old-key`);
      }
    }
  );

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

  it("honors an explicit noninteractive provider switch over a complete old provider", async () => {
    const context = await testContext({
      guided: false,
      fetch: vi.fn(async (url) =>
        String(url).includes("generativelanguage")
          ? geminiResponse()
          : openRouterResponse()
      ) as unknown as typeof fetch
    });
    await configureAiProvider(
      { provider: "openrouter", api_key: "old-openrouter-key" },
      context
    );
    const newKey = await secretRef(
      context,
      "explicit-gemini.key",
      "new-gemini-key"
    );
    context.answers = {
      schema_version: 1,
      ai_provider: { provider: "gemini", api_key: newKey }
    };

    await runOnboarding({
      phases: [aiProviderPhase],
      context,
      selection: { mode: "all" }
    });

    const env = await readFile(context.paths.clientSecretsFile, "utf8");
    expect(env).toContain("GEMINI_API_KEY=");
    expect(env).toContain("new-gemini-key");
    expect(env).not.toContain("OPENROUTER_API_KEY=");
    expect(env).not.toContain("old-openrouter-key");
    expect(context.io.ask).not.toHaveBeenCalled();
    expect(context.io.askMasked).not.toHaveBeenCalled();
    expect(context.io.select).not.toHaveBeenCalled();
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

  it("rejects a pathname swapped after the secret handle is opened", async () => {
    const context = await testContext();
    const external = await mkdtemp(join(tmpdir(), "quoteops-secret-swap-"));
    tempDirs.push(external);
    const requested = join(context.answersRoot!, "swap.key");
    const original = join(context.answersRoot!, "swap-original.key");
    const outside = join(external, "outside.key");
    await writeFile(requested, "inside-secret", { mode: 0o600 });
    await writeFile(outside, "outside-secret", { mode: 0o600 });
    (
      context as OnboardingContext & {
        afterSecretOpen?: () => void | Promise<void>;
      }
    ).afterSecretOpen = async () => {
      await rename(requested, original);
      await symlink(outside, requested);
    };

    await expect(
      readSingleLineSecret({ file: requested }, context)
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

  it("rejects a bad Resend key without leaking the key or provider body", async () => {
    const secret = "resend-secret-must-not-leak";
    const body = "provider-body-must-not-leak";
    const context = await testContext({
      fetch: vi.fn().mockResolvedValue(
        new Response(body, { status: 401 })
      ) as unknown as typeof fetch
    });
    const resendKey = await secretRef(context, "bad-resend.key", secret);

    let caught: unknown;
    try {
      await configureApplianceSecrets(
        {
          mailbox: {
            provider: "resend",
            api_key: resendKey,
            intake_address: "intake@example.com",
            from_address: "quotes@example.com"
          }
        },
        context
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "mailbox_auth_rejected" });
    expect(String(caught)).not.toContain(secret);
    expect(String(caught)).not.toContain(body);
    expect(
      await readFile(context.paths.clientSecretsFile, "utf8").catch(() => "")
    ).toBe("");
    expect(
      await readFile(context.paths.mailboxProbeReceiptFile, "utf8").catch(
        () => ""
      )
    ).toBe("");
  });

  it("applies one Resend deadline across fetch and response parsing", async () => {
    const context = await testContext({
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => await new Promise<unknown>(() => undefined)
      }) as unknown as typeof fetch
    });
    (
      context as OnboardingContext & { mailboxProbeTimeoutMs?: number }
    ).mailboxProbeTimeoutMs = 10;
    const resendKey = await secretRef(
      context,
      "timeout-resend.key",
      "timeout-resend-secret"
    );

    await expect(
      configureApplianceSecrets(
        {
          mailbox: {
            provider: "resend",
            api_key: resendKey,
            intake_address: "intake@example.com",
            from_address: "quotes@example.com"
          }
        },
        context
      )
    ).rejects.toMatchObject({ code: "mailbox_probe_unreachable" });
    expect(
      await readFile(context.paths.clientSecretsFile, "utf8").catch(() => "")
    ).toBe("");
  });

  it("reuses the Resend idempotency key after response loss", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(
        Response.json({ id: "accepted-retry" }, { status: 200 })
      );
    const context = await testContext({
      fetch: fetchMock as unknown as typeof fetch
    });
    const resendKey = await secretRef(
      context,
      "retry-resend.key",
      "retry-resend-secret"
    );
    const input = {
      mailbox: {
        provider: "resend" as const,
        api_key: resendKey,
        intake_address: "intake@example.com",
        from_address: "quotes@example.com"
      }
    };

    await expect(
      configureApplianceSecrets(input, context)
    ).rejects.toMatchObject({ code: "mailbox_probe_unreachable" });
    await configureApplianceSecrets(input, context);

    const firstHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    const secondHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(firstHeaders["Idempotency-Key"]).toBe(
      secondHeaders["Idempotency-Key"]
    );
    const receipt = await readFile(
      context.paths.mailboxProbeReceiptFile,
      "utf8"
    );
    expect(receipt).not.toMatch(
      /retry-resend-secret|accepted-retry|QuoteOps onboarding validation/
    );
  });

  it("fails closed on IMAP authentication without persisting credentials", async () => {
    const passwordValue = "imap-password-must-not-leak";
    const context = await testContext({
      probeImap: vi.fn(async () => {
        throw new Error(`auth failed for ${passwordValue}`);
      })
    });
    const password = await secretRef(
      context,
      "bad-imap.key",
      passwordValue
    );

    let caught: unknown;
    try {
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
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "mailbox_auth_rejected" });
    expect(String(caught)).not.toContain(passwordValue);
    expect(
      await readFile(context.paths.clientSecretsFile, "utf8").catch(() => "")
    ).toBe("");
    expect(
      await readFile(context.paths.mailboxProbeReceiptFile, "utf8").catch(
        () => ""
      )
    ).toBe("");
  });

  it("requires non-empty active secrets and complete provider-specific config", async () => {
    const context = await testContext({
      fetch: vi.fn().mockResolvedValue(
        Response.json({ id: "readiness-id" }, { status: 200 })
      ) as unknown as typeof fetch
    });
    const resendKey = await secretRef(
      context,
      "ready-resend.key",
      "ready-resend-secret"
    );
    const embeddingKey = await secretRef(
      context,
      "ready-embedding.key",
      "ready-embedding-secret"
    );
    await configureApplianceSecrets(
      {
        mailbox: {
          provider: "resend",
          api_key: resendKey,
          intake_address: "intake@example.com",
          from_address: "quotes@example.com"
        },
        embeddings: {
          provider: "gemini",
          model: "text-embedding-004",
          api_key: embeddingKey
        }
      },
      context
    );
    expect(await isApplianceSecretsComplete(context)).toBe(true);

    await writeFile(
      context.paths.clientSecretsFile,
      (
        await readFile(context.paths.clientSecretsFile, "utf8")
      ).replace(/^RESEND_API_KEY=.*$/m, 'RESEND_API_KEY=""'),
      { mode: 0o600 }
    );
    expect(await isApplianceSecretsComplete(context)).toBe(false);
  });

  it("rejects incomplete mailbox and embeddings shapes even with matching receipts", async () => {
    const context = await testContext({
      fetch: vi.fn().mockResolvedValue(
        Response.json({ id: "shape-id" }, { status: 200 })
      ) as unknown as typeof fetch
    });
    const resendKey = await secretRef(
      context,
      "shape-resend.key",
      "shape-resend-secret"
    );
    const embeddingKey = await secretRef(
      context,
      "shape-embedding.key",
      "shape-embedding-secret"
    );
    await configureApplianceSecrets(
      {
        mailbox: {
          provider: "resend",
          api_key: resendKey,
          intake_address: "intake@example.com",
          from_address: "quotes@example.com"
        },
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
    config.mailbox.poll_interval_ms = 0;
    config.embeddings.provider = "unsupported";
    await writeFile(
      context.paths.agentConfigFile,
      `${JSON.stringify(config)}\n`,
      { mode: 0o600 }
    );
    const receipt = JSON.parse(
      await readFile(context.paths.mailboxProbeReceiptFile, "utf8")
    );
    receipt.agent_config_sha256 = await sha256File(
      context.paths.agentConfigFile
    );
    await writeFile(
      context.paths.mailboxProbeReceiptFile,
      `${JSON.stringify(receipt)}\n`,
      { mode: 0o600 }
    );

    expect(await isApplianceSecretsComplete(context)).toBe(false);
  });

  it("invalidates mailbox readiness when provider config rotates", async () => {
    const context = await testContext({
      fetch: vi.fn().mockResolvedValue(
        Response.json({ id: "rotation-id" }, { status: 200 })
      ) as unknown as typeof fetch
    });
    const resendKey = await secretRef(
      context,
      "rotation-resend.key",
      "rotation-resend-secret"
    );
    const embeddingKey = await secretRef(
      context,
      "rotation-embedding.key",
      "rotation-embedding-secret"
    );
    await configureApplianceSecrets(
      {
        mailbox: {
          provider: "resend",
          api_key: resendKey,
          intake_address: "intake@example.com",
          from_address: "quotes@example.com"
        },
        embeddings: {
          provider: "gemini",
          model: "text-embedding-004",
          api_key: embeddingKey
        }
      },
      context
    );
    const config = await readFile(context.paths.agentConfigFile, "utf8");
    await writeFile(
      context.paths.agentConfigFile,
      config.replace("poll_interval_ms: 60000", "poll_interval_ms: 120000"),
      { mode: 0o600 }
    );

    expect(await isApplianceSecretsComplete(context)).toBe(false);
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

  it("applies one knowledge-ingest deadline across fetch and response parsing", async () => {
    const context = await testContext({
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        status: 202,
        json: async () => await new Promise<unknown>(() => undefined)
      }) as unknown as typeof fetch
    });
    (
      context as OnboardingContext & { httpProbeTimeoutMs?: number }
    ).httpProbeTimeoutMs = 10;
    const source = join(context.answersRoot!, "timeout-source.md");
    await writeFile(source, "private source", { mode: 0o600 });
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

    const outcome = await Promise.race([
      runKnowledgeIngestion(context).then(
        () => "resolved",
        (error: unknown) =>
          error instanceof OnboardingError ? error.code : "unknown"
      ),
      new Promise<string>((resolvePromise) =>
        setTimeout(() => resolvePromise("hung"), 50)
      )
    ]);
    expect(outcome).toBe("knowledge_ingest_unreachable");
    expect(
      await readFile(context.paths.knowledgeReceiptFile, "utf8").catch(() => "")
    ).toBe("");
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

function passingTestRfq(runId: string) {
  return {
    run_id: runId,
    status: "APPROVED",
    approval_required: false,
    route_source: "sakbe",
    base_quote: { status: "APPROVED", total_mxn: 42_000 },
    route_evidence: { status: "resolved" },
    writeback_result: { status: "written" },
    node_status: { writeback: "completed" }
  };
}
