import { ChatOpenAI } from "@langchain/openai";
import type { AgentRuntimeConfig } from "@quoteops/connectors";
import { z } from "zod";

export type ChatModelConfig = Omit<
  Pick<AgentRuntimeConfig["model"], "provider" | "model_name" | "api_key_env">,
  "provider"
> & {
  provider: "openrouter" | "openai" | "anthropic" | "gemini";
};

const configSchema = z
  .object({
    provider: z.enum(["openrouter", "openai", "anthropic", "gemini"]),
    model_name: z.string().min(1),
    api_key_env: z.string().min(1)
  })
  .strict();

const providerBaseUrls: Partial<Record<ChatModelConfig["provider"], string>> = {
  openrouter: "https://openrouter.ai/api/v1",
  anthropic: "https://api.anthropic.com/v1/",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/"
};

export function createChatModel(
  modelConfig: {
    provider: string;
    model_name: string;
    api_key_env?: string | null;
  },
  env: NodeJS.ProcessEnv
): ChatOpenAI {
  const parsed = configSchema.parse(modelConfig);
  const apiKey = env[parsed.api_key_env]?.trim();
  if (!apiKey) throw new Error(`Chat model API key is missing: ${parsed.api_key_env}`);

  return new ChatOpenAI({
    model: parsed.model_name,
    apiKey,
    temperature: 0,
    ...(providerBaseUrls[parsed.provider]
      ? { configuration: { baseURL: providerBaseUrls[parsed.provider] } }
      : {})
  });
}
