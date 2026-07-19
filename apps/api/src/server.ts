import {
  ConsoleWhatsAppChannel,
  createMailboxReplyChannel,
  createChatModel,
  createQuoteAgentRuntime,
  startMailboxIntake,
  type QuoteAgentRuntime
} from "@quoteops/agent";
import { loadAgentRuntimeConfig } from "@quoteops/connectors";
import {
  createApplianceWorkflowTools,
  createQuoteOpsApi,
  createQuoteOpsStore,
  assertApplianceLicenseForClient,
  loadApplianceManifest,
  startControlPlaneSyncScheduler
} from "./index.js";

const port = Number(process.env.PORT || 8080);
// shared store: the sync scheduler must see the same workflow runs as the API
const store = createQuoteOpsStore();

void bootstrap();

async function bootstrap(): Promise<void> {
  const graphRuntime = await createRuntime().catch((error) => {
    console.error(`[quoteops-api] LangGraph runtime disabled: ${error instanceof Error ? error.message : error}`);
    return null;
  });
  const app = createQuoteOpsApi({ store, ...(graphRuntime ? { graphRuntime } : {}) });
  app.listen(port, () => {
    console.log(`QuoteOps API listening on :${port}`);
  });
  startControlPlaneSyncScheduler({ store });
  if (graphRuntime) {
    const manifest = await loadApplianceManifest(process.env.QUOTEOPS_MANIFEST_PATH);
    await startMailboxIntake(
      process.env,
      graphRuntime,
      () => assertApplianceLicenseForClient({ env: process.env, clientId: manifest?.client_id ?? null })
    ).catch((error) => {
      console.error(`[quoteops-api] mailbox LangGraph runner disabled: ${error instanceof Error ? error.message : error}`);
      return null;
    });
  }
}

async function createRuntime(): Promise<QuoteAgentRuntime | null> {
  const manifest = await loadApplianceManifest(process.env.QUOTEOPS_MANIFEST_PATH);
  if (!manifest) return null;
  const config = await loadAgentRuntimeConfig(process.env.QUOTEOPS_AGENT_CONFIG_PATH);
  const provider = providerForChatModel(process.env.QUOTEOPS_LLM_PROVIDER ?? config.model.provider);
  if (!provider) return null;
  const apiKeyEnv =
    process.env.QUOTEOPS_LLM_API_KEY_ENV ?? config.model.api_key_env ?? defaultKeyEnv(provider);
  if (!config.mailbox) throw new Error("agent mailbox config is required for same-channel replies");
  return createQuoteAgentRuntime({
    manifest,
    tools: createApplianceWorkflowTools(),
    model: createChatModel(
      {
        provider,
        model_name: process.env.QUOTEOPS_LLM_MODEL ?? config.model.model_name,
        api_key_env: apiKeyEnv,
        base_url: process.env.QUOTEOPS_LLM_BASE_URL ?? config.model.base_url
      },
      process.env
    ),
    store,
    channels: {
      email: createMailboxReplyChannel({ config: config.mailbox, env: process.env }),
      whatsapp: new ConsoleWhatsAppChannel()
    },
    env: process.env
  });
}

function providerForChatModel(value: string): "openrouter" | "openai" | "anthropic" | "gemini" | null {
  if (value === "gemini_sdk") return "gemini";
  if (value === "openrouter" || value === "openai" || value === "anthropic" || value === "gemini") return value;
  return null;
}

function defaultKeyEnv(provider: "openrouter" | "openai" | "anthropic" | "gemini"): string {
  if (provider === "openrouter") return "OPENROUTER_API_KEY";
  if (provider === "openai") return "OPENAI_API_KEY";
  if (provider === "anthropic") return "ANTHROPIC_API_KEY";
  return "GEMINI_API_KEY";
}
