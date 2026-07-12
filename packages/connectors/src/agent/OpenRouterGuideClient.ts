import { readFile } from "node:fs/promises";
import type { HistoricalContext } from "@quoteops/quote-core";
import { loadEnvFileValue } from "../secrets/LocalKeysFile.js";

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export type OpenRouterGuideInput = {
  base_rate_mxn: number;
  historical_context: HistoricalContext;
  criteria_context: unknown;
};

export type OpenRouterGuideClientOptions = {
  apiKey: string;
  modelName: string;
  temperature?: number;
  baseUrl?: string;
  fetch?: typeof fetch;
};

export type OpenRouterApiKeyOptions = {
  env?: NodeJS.ProcessEnv;
  apiKeyEnv?: string | null;
  envFilePath?: string | null;
  keysPath?: string | null;
};

export class OpenRouterGuideClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: OpenRouterGuideClientOptions) {
    this.baseUrl = options.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL;
    this.fetchFn = options.fetch ?? fetch;
  }

  async recommend(input: OpenRouterGuideInput): Promise<{ recommended_rate_mxn: number; reason: string }> {
    const response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
        "http-referer": "https://quoteops.local",
        "x-title": "QuoteOps Appliance"
      },
      body: JSON.stringify({
        model: this.options.modelName,
        temperature: this.options.temperature ?? 0,
        messages: [
          {
            role: "system",
            content:
              "You are a pricing guide for a logistics quoting appliance. Explain risks and context briefly. Never change the deterministic quote-core rate."
          },
          {
            role: "user",
            content: JSON.stringify({
              base_rate_mxn: input.base_rate_mxn,
              historical_context: input.historical_context,
              criteria_context: input.criteria_context
            })
          }
        ]
      })
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`OpenRouter responded with HTTP ${response.status}: ${raw.slice(0, 160)}`);
    }

    const body = JSON.parse(raw) as unknown;
    const reason = extractOpenRouterReason(body);
    return {
      recommended_rate_mxn: input.base_rate_mxn,
      reason: reason || "OpenRouter guide returned no text; quote-core rate preserved."
    };
  }
}

export async function loadOpenRouterApiKey(
  options: OpenRouterApiKeyOptions = {}
): Promise<string | null> {
  const env = options.env ?? process.env;
  const apiKeyEnv = options.apiKeyEnv || "OPENROUTER_API_KEY";
  const fromEnv = env[apiKeyEnv];
  if (fromEnv?.trim()) {
    return fromEnv.trim();
  }

  const fromSecretsEnvFile = await loadEnvFileValue({
    env,
    key: apiKeyEnv,
    envFilePath: options.envFilePath
  });
  if (fromSecretsEnvFile) {
    return fromSecretsEnvFile;
  }

  const keysPath = options.keysPath ?? null;
  if (!keysPath) {
    return null;
  }

  try {
    const raw = await readFile(keysPath, "utf8");
    return raw.match(/sk-or-[A-Za-z0-9_-]+/)?.[0] ?? null;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function extractOpenRouterReason(body: unknown): string | null {
  if (!isRecord(body) || !Array.isArray(body.choices)) {
    return null;
  }
  const first = body.choices[0];
  if (!isRecord(first)) {
    return null;
  }
  const message = isRecord(first.message) ? first.message : {};
  const content = message.content;
  if (typeof content !== "string") {
    return null;
  }
  return content.trim().slice(0, 1200) || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
