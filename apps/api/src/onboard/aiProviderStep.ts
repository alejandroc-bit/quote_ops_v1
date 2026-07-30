import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  OnboardingError,
  type OnboardingContext,
  type OnboardingPhase,
  type SecretFileRef
} from "./onboardingFlow.js";
import {
  atomicWriteJson,
  atomicWriteText,
  createCopilot,
  readEnvFileValues,
  readSingleLineSecret,
  sha256File,
  updateAllowedEnv,
  validateSingleLineSecret
} from "./onboardConfig.js";

export type OnboardingAiConfig =
  | {
      input_provider: "openrouter";
      provider: "openrouter";
      model_name: "openai/gpt-4o-mini";
      api_key_env: "OPENROUTER_API_KEY";
    }
  | {
      input_provider: "gemini";
      provider: "gemini_sdk";
      model_name: "gemini-2.5-flash";
      api_key_env: "GEMINI_API_KEY";
    };

export type AiProviderValidationReceipt = {
  schema_version: 1;
  input_provider: "openrouter" | "gemini";
  runtime_provider: "openrouter" | "gemini_sdk";
  model_name: string;
  agent_config_sha256: string;
  credential_revision: number;
  validated_at: string;
  live_request: true;
  fallback: false;
};

export type ConfigureAiProviderInput = {
  provider: "openrouter" | "gemini";
  api_key: string | SecretFileRef;
};

const AI_ENV_KEYS = ["OPENROUTER_API_KEY", "GEMINI_API_KEY"] as const;

export async function validateAiProviderCredential(
  input: ConfigureAiProviderInput,
  context: Pick<
    OnboardingContext,
    "fetch" | "aiValidationTimeoutMs"
  >
): Promise<OnboardingAiConfig> {
  const rawApiKey =
    typeof input.api_key === "string"
      ? input.api_key
      : (() => {
          throw new OnboardingError("ai_key_missing");
        })();
  if (!rawApiKey) throw new OnboardingError("ai_key_missing");
  const apiKey = validateSingleLineSecret(rawApiKey);
  const config = aiConfig(input.provider);
  const timeoutMs = context.aiValidationTimeoutMs ?? 10_000;
  const signal = AbortSignal.timeout(timeoutMs);

  let response: Response;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const request =
      config.input_provider === "openrouter"
        ? context.fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`
            },
            body: JSON.stringify({
              model: config.model_name,
              messages: [{ role: "user", content: "Reply with ok." }],
              max_tokens: 2,
              temperature: 0
            }),
            signal
          })
        : context.fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${config.model_name}:generateContent`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-goog-api-key": apiKey
              },
              body: JSON.stringify({
                contents: [
                  { role: "user", parts: [{ text: "Reply with ok." }] }
                ],
                generationConfig: {
                  maxOutputTokens: 2,
                  temperature: 0
                }
              }),
              signal
            }
          );
    const deadlinePromise = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(
        () => reject(new OnboardingError("ai_provider_unreachable")),
        timeoutMs
      );
    });
    response = await Promise.race([request, deadlinePromise]);
  } catch (error) {
    if (error instanceof OnboardingError) throw error;
    throw new OnboardingError("ai_provider_unreachable");
  } finally {
    if (deadline) clearTimeout(deadline);
  }

  if (response.status === 401 || response.status === 403) {
    throw new OnboardingError("ai_key_rejected");
  }
  if (response.status === 404) {
    throw new OnboardingError("model_not_available");
  }
  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    throw new OnboardingError("ai_provider_unreachable");
  }
  if (!response.ok) {
    throw new OnboardingError("ai_provider_invalid_response");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new OnboardingError("ai_provider_invalid_response");
  }
  if (!isValidProviderResponse(config.input_provider, body)) {
    throw new OnboardingError("ai_provider_invalid_response");
  }
  return config;
}

export async function configureAiProvider(
  input: ConfigureAiProviderInput,
  context: OnboardingContext
): Promise<OnboardingAiConfig> {
  const apiKey = await readSingleLineSecret(input.api_key, context);
  const config = await validateAiProviderCredential(
    { provider: input.provider, api_key: apiKey },
    context
  );
  const otherKey =
    config.api_key_env === "OPENROUTER_API_KEY"
      ? "GEMINI_API_KEY"
      : "OPENROUTER_API_KEY";
  await updateAllowedEnv(
    context.paths.clientSecretsFile,
    {
      [config.api_key_env]: apiKey,
      [otherKey]: null
    },
    AI_ENV_KEYS,
    () => context.afterAtomicRename?.("ai_client_env")
  );

  const currentConfig = await readFile(
    context.paths.agentConfigFile,
    "utf8"
  ).catch(() => "");
  const parsed = parseAgentConfig(currentConfig);
  const nextConfig = stringifyYaml({
    ...parsed,
    model: {
      provider: config.provider,
      model_name: config.model_name,
      temperature: 0,
      api_key_env: config.api_key_env
    }
  });
  await atomicWriteText(context.paths.agentConfigFile, nextConfig, {
    mode: 0o600,
    afterRename: () => context.afterAtomicRename?.("ai_agent_config")
  });

  const revisionFile = aiCredentialRevisionFile(context);
  const credentialRevision = (await readCredentialRevision(revisionFile)) + 1;
  await atomicWriteJson(
    revisionFile,
    {
      schema_version: 1,
      credential_revision: credentialRevision
    },
    {
      mode: 0o600,
      afterRename: () => context.afterAtomicRename?.("ai_credential_revision")
    }
  );

  const receipt: AiProviderValidationReceipt = {
    schema_version: 1,
    input_provider: config.input_provider,
    runtime_provider: config.provider,
    model_name: config.model_name,
    agent_config_sha256: await sha256File(context.paths.agentConfigFile),
    credential_revision: credentialRevision,
    validated_at: (context.now?.() ?? new Date()).toISOString(),
    live_request: true,
    fallback: false
  };
  await atomicWriteJson(context.paths.aiValidationReceiptFile, receipt, {
    mode: 0o600,
    afterRename: () => context.afterAtomicRename?.("ai_validation_receipt")
  });

  context.copilot = createCopilot({
    provider: config.input_provider,
    apiKey,
    model: config.model_name,
    fetch: context.fetch
  });
  return config;
}

export async function isAiProviderComplete(
  context: OnboardingContext
): Promise<boolean> {
  const existing = await readExistingAiProvider(context);
  if (!existing) return false;
  const receipt = await readAiReceipt(context.paths.aiValidationReceiptFile);
  const revision = await readCredentialRevision(
    aiCredentialRevisionFile(context)
  );
  if (
    !receipt ||
    revision < 1 ||
    receipt.credential_revision !== revision ||
    receipt.input_provider !== existing.config.input_provider ||
    receipt.runtime_provider !== existing.config.provider ||
    receipt.model_name !== existing.config.model_name ||
    receipt.agent_config_sha256 !==
      (await sha256File(context.paths.agentConfigFile)) ||
    receipt.live_request !== true ||
    receipt.fallback !== false
  ) {
    return false;
  }
  await validateAiProviderCredential(
    {
      provider: existing.config.input_provider,
      api_key: existing.apiKey
    },
    context
  );
  return true;
}

export const aiProviderPhase: OnboardingPhase = {
  id: "ai_provider",
  async isComplete(context) {
    try {
      return await isAiProviderComplete(context);
    } catch (error) {
      if (
        error instanceof OnboardingError &&
        error.code === "ai_key_rejected"
      ) {
        context.io.warn("ai_key_rejected");
        return false;
      }
      throw error;
    }
  },
  async run(context) {
    const existing = await readExistingAiProvider(context);
    if (existing) {
      try {
        await configureAiProvider(
          {
            provider: existing.config.input_provider,
            api_key: existing.apiKey
          },
          context
        );
        return;
      } catch (error) {
        if (
          !(error instanceof OnboardingError) ||
          error.code !== "ai_key_rejected"
        ) {
          throw error;
        }
        context.io.warn("ai_key_rejected");
      }
    }

    if (context.answers?.ai_provider) {
      await configureAiProvider(context.answers.ai_provider, context);
      return;
    }
    if (!context.guided) {
      throw new OnboardingError("onboarding_pending", {
        phase: "ai_provider"
      });
    }
    const provider = await context.io.select(
      "Proveedor de IA",
      [
        { value: "openrouter", label: "OpenRouter (recomendado)" },
        { value: "gemini", label: "Google Gemini" }
      ]
    );
    context.io.info(
      "La clave se guarda localmente en un archivo accesible sólo por root (`0600`)."
    );
    const apiKey = await context.io.askMasked("Clave API");
    await configureAiProvider({ provider, api_key: apiKey }, context);
  }
};

function aiConfig(provider: "openrouter" | "gemini"): OnboardingAiConfig {
  return provider === "openrouter"
    ? {
        input_provider: "openrouter",
        provider: "openrouter",
        model_name: "openai/gpt-4o-mini",
        api_key_env: "OPENROUTER_API_KEY"
      }
    : {
        input_provider: "gemini",
        provider: "gemini_sdk",
        model_name: "gemini-2.5-flash",
        api_key_env: "GEMINI_API_KEY"
      };
}

function isValidProviderResponse(
  provider: "openrouter" | "gemini",
  body: unknown
): boolean {
  if (!body || typeof body !== "object") return false;
  if (provider === "openrouter") {
    const choices = (body as { choices?: unknown }).choices;
    return (
      Array.isArray(choices) &&
      choices.some(
        (choice) =>
          choice &&
          typeof choice === "object" &&
          typeof (choice as { message?: { content?: unknown } }).message
            ?.content === "string"
      )
    );
  }
  const candidates = (body as { candidates?: unknown }).candidates;
  return (
    Array.isArray(candidates) &&
    candidates.some((candidate) => {
      const parts = (
        candidate as { content?: { parts?: unknown } }
      )?.content?.parts;
      return (
        Array.isArray(parts) &&
        parts.some(
          (part) =>
            part &&
            typeof part === "object" &&
            typeof (part as { text?: unknown }).text === "string"
        )
      );
    })
  );
}

async function readExistingAiProvider(
  context: OnboardingContext
): Promise<{ config: OnboardingAiConfig; apiKey: string } | null> {
  const env = await readEnvFileValues(context.paths.clientSecretsFile);
  const presentKeys = AI_ENV_KEYS.filter((key) => Boolean(env.get(key)));
  if (presentKeys.length !== 1) return null;
  let parsed: Record<string, unknown> = {};
  try {
    parsed = parseAgentConfig(
      await readFile(context.paths.agentConfigFile, "utf8")
    );
  } catch {
    parsed = {};
  }
  const model =
    parsed.model && typeof parsed.model === "object"
      ? (parsed.model as Record<string, unknown>)
      : null;
  let configured: OnboardingAiConfig | null = null;
  if (
    model?.provider === "openrouter" &&
    model.model_name === "openai/gpt-4o-mini" &&
    model.api_key_env === "OPENROUTER_API_KEY"
  ) {
    configured = aiConfig("openrouter");
  } else if (
    model?.provider === "gemini_sdk" &&
    model.model_name === "gemini-2.5-flash" &&
    model.api_key_env === "GEMINI_API_KEY"
  ) {
    configured = aiConfig("gemini");
  }
  const inferred =
    presentKeys[0] === "OPENROUTER_API_KEY"
      ? aiConfig("openrouter")
      : aiConfig("gemini");
  const config = configured ?? inferred;
  const otherKey =
    config.api_key_env === "OPENROUTER_API_KEY"
      ? "GEMINI_API_KEY"
      : "OPENROUTER_API_KEY";
  const apiKey = env.get(config.api_key_env);
  if (
    !apiKey ||
    env.has(otherKey) ||
    (configured && configured.api_key_env !== presentKeys[0])
  ) {
    return null;
  }
  return { config, apiKey };
}

function parseAgentConfig(contents: string): Record<string, unknown> {
  if (!contents.trim()) return {};
  const parsed = parseYaml(contents) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OnboardingError("agent_config_invalid");
  }
  return parsed as Record<string, unknown>;
}

function aiCredentialRevisionFile(context: OnboardingContext): string {
  return join(context.paths.settingsDir, "ai-provider-credential.json");
}

async function readCredentialRevision(file: string): Promise<number> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as {
      schema_version?: unknown;
      credential_revision?: unknown;
    };
    return value.schema_version === 1 &&
      Number.isSafeInteger(value.credential_revision) &&
      Number(value.credential_revision) >= 1
      ? Number(value.credential_revision)
      : 0;
  } catch {
    return 0;
  }
}

async function readAiReceipt(
  file: string
): Promise<AiProviderValidationReceipt | null> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as Partial<
      AiProviderValidationReceipt
    >;
    return value.schema_version === 1 &&
      (value.input_provider === "openrouter" ||
        value.input_provider === "gemini") &&
      (value.runtime_provider === "openrouter" ||
        value.runtime_provider === "gemini_sdk") &&
      typeof value.model_name === "string" &&
      typeof value.agent_config_sha256 === "string" &&
      typeof value.credential_revision === "number" &&
      typeof value.validated_at === "string" &&
      value.live_request === true &&
      value.fallback === false
      ? (value as AiProviderValidationReceipt)
      : null;
  } catch {
    return null;
  }
}
