import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { loadAgentRuntimeConfig, type AgentRuntimeConfig } from "@quoteops/connectors";
import type { QuoteManifest } from "@quoteops/quote-core";
import { createChatModel } from "../llm/chatModel.js";
import type { QuoteAgentRuntime } from "../graph/runtime.js";
import {
  buildRfqFromEmail,
  RfqExtractionError,
  type IntakeModel,
  type IntakeModelPart
} from "./extractRfq.js";
import {
  mailboxCredentialsPresent,
  openConfiguredMailbox,
  type MailboxSource
} from "./mailbox.js";

export type MailboxIntakeOptions = {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  manifest?: QuoteManifest;
  model?: IntakeModel | null;
  mailbox?: MailboxSource;
  now?: () => Date;
  log?: (message: string) => void;
  graphRuntime?: Pick<QuoteAgentRuntime, "invoke">;
  authorizeGraphRun?: () => Promise<void>;
};

export type MailboxIntakeResult = {
  processed: string[];
  ignored: string[];
  failed: string[];
};

export async function runMailboxIntakeOnce(
  options: MailboxIntakeOptions = {}
): Promise<MailboxIntakeResult> {
  const env = options.env ?? process.env;
  const fetchFn = options.fetch ?? fetch;
  const log = options.log ?? ((message) => console.log(`[mailbox-intake] ${message}`));
  const now = options.now ?? (() => new Date());

  const manifest = options.manifest ?? (await loadManifest(env));
  const clientId = env.QUOTEOPS_CLIENT_ID?.trim() || manifest.client_id;
  const allowedDomains = new Set(
    manifest.business_units.flatMap((unit) =>
      (unit.requester_email_domains ?? []).map((domain) => domain.toLowerCase().trim())
    )
  );
  const apiUrl = (env.QUOTEOPS_API_URL ?? "http://quoteops-api:8080").replace(/\/+$/, "");

  const agentConfig = await tryLoadAgentConfig(env);
  const model =
    options.model !== undefined ? options.model : buildIntakeModel(agentConfig, env, fetchFn);

  const injectedMailbox = options.mailbox;
  const mailbox = injectedMailbox ?? (await openMailboxFromConfig(agentConfig, env, fetchFn));
  if (!mailbox) {
    throw new Error("mailbox intake requires a mailbox configured in agent-config.yaml");
  }

  const result: MailboxIntakeResult = { processed: [], ignored: [], failed: [] };
  try {
    for (const uid of await mailbox.listUnread()) {
      const email = await mailbox.fetch(uid);
      const senderDomain = email.from_email.split("@")[1]?.toLowerCase() ?? "";
      if (!allowedDomains.has(senderDomain)) {
        log(`ignoring ${uid}: sender domain not authorized (${senderDomain || "unknown"})`);
        await mailbox.finish(uid, "ignored");
        result.ignored.push(uid);
        continue;
      }

      try {
        const rfqId = generateRfqId(now());
        if (options.graphRuntime) {
          if (!options.authorizeGraphRun) {
            throw new Error("appliance_locked:mailbox_license_guard_missing");
          }
          await options.authorizeGraphRun();
          const runId = `run-${rfqId.toLowerCase()}`;
          await options.graphRuntime.invoke({ run_id: runId, channel: "email", message: email });
          await mailbox.finish(uid, "processed");
          result.processed.push(uid);
          log(`processed ${uid} as ${runId} through LangGraph`);
          continue;
        }
        const rfq = await buildRfqFromEmail({ email, manifest, model, rfqId });
        const response = await fetchFn(`${apiUrl}/api/rfqs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            run_id: `run-${rfqId.toLowerCase()}`,
            client_id: clientId,
            raw_rfq: rfq
          })
        });
        if (!response.ok) {
          throw new Error(`appliance API rejected RFQ: HTTP ${response.status}`);
        }
        await mailbox.finish(uid, "processed");
        result.processed.push(uid);
        log(`processed ${uid} as ${rfqId} (${rfq.parsed.lanes.length} lanes)`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`failed ${uid}: ${message}`);
        await mailbox.finish(uid, "error").catch(() => undefined);
        result.failed.push(uid);
        if (!(error instanceof RfqExtractionError)) {
          // API/network failures should surface loudly instead of silently skipping
          throw error;
        }
      }
    }
  } finally {
    if (!injectedMailbox) {
      await mailbox.close();
    }
  }

  return result;
}

export async function startMailboxIntake(
  env: NodeJS.ProcessEnv = process.env,
  graphRuntime?: Pick<QuoteAgentRuntime, "invoke">,
  authorizeGraphRun?: () => Promise<void>
): Promise<NodeJS.Timeout | null> {
  const agentConfig = await tryLoadAgentConfig(env);
  const config = agentConfig?.mailbox ?? null;
  if (!config) {
    console.log("[mailbox-intake] disabled: no mailbox configured in agent-config.yaml");
    return null;
  }
  if (!mailboxCredentialsPresent(config, env)) {
    console.log("[mailbox-intake] disabled: mailbox credentials not configured in secrets");
    return null;
  }

  const intervalMs = config.poll_interval_ms;
  const timer = setInterval(() => {
    runMailboxIntakeOnce({ env, graphRuntime, authorizeGraphRun }).catch((error) => {
      console.error(
        `[mailbox-intake] poll failed: ${error instanceof Error ? error.message : error}`
      );
    });
  }, intervalMs);
  timer.unref?.();
  console.log(`[mailbox-intake] polling ${config.provider} every ${intervalMs}ms`);
  return timer;
}

async function openMailboxFromConfig(
  agentConfig: AgentRuntimeConfig | null,
  env: NodeJS.ProcessEnv,
  fetchFn: typeof fetch
): Promise<MailboxSource | null> {
  const config = agentConfig?.mailbox;
  if (!config || !mailboxCredentialsPresent(config, env)) {
    return null;
  }
  return openConfiguredMailbox({ config, env, fetch: fetchFn });
}

async function tryLoadAgentConfig(env: NodeJS.ProcessEnv): Promise<AgentRuntimeConfig | null> {
  try {
    return await loadAgentRuntimeConfig(env.QUOTEOPS_AGENT_CONFIG_PATH);
  } catch {
    return null;
  }
}

export function buildIntakeModel(
  agentConfig: AgentRuntimeConfig | null,
  env: NodeJS.ProcessEnv,
  fetchFn: typeof fetch
): IntakeModel | null {
  if (!agentConfig) return null;

  if (agentConfig.model.provider === "openrouter") {
    const apiKey = env[agentConfig.model.api_key_env || "OPENROUTER_API_KEY"];
    if (!apiKey?.trim()) return null;
    return openRouterIntakeModel({
      apiKey: apiKey.trim(),
      modelName: agentConfig.model.model_name,
      fetchFn
    });
  }

  if (agentConfig.model.provider === "gemini_sdk") {
    const apiKey = env[agentConfig.model.api_key_env || "GEMINI_API_KEY"];
    if (!apiKey?.trim()) return null;
    return geminiIntakeModel({ apiKey: apiKey.trim(), modelName: agentConfig.model.model_name });
  }

  if (agentConfig.model.provider === "openai") {
    const apiKeyEnv = agentConfig.model.api_key_env;
    if (!apiKeyEnv || !env[apiKeyEnv]?.trim()) return null;
    return openaiIntakeModel({
      modelName: agentConfig.model.model_name,
      apiKeyEnv,
      baseUrl: agentConfig.model.base_url,
      env
    });
  }

  return null;
}

async function loadManifest(env: NodeJS.ProcessEnv): Promise<QuoteManifest> {
  const path = env.QUOTEOPS_MANIFEST_PATH ?? "/opt/quoteops-v1/manifests/client-manifest.yaml";
  const manifest = parseYaml(await readFile(path, "utf8")) as QuoteManifest;
  if (!manifest?.client_id || !Array.isArray(manifest.business_units)) {
    throw new Error(`client manifest is invalid: ${path}`);
  }
  return manifest;
}

function openRouterIntakeModel({
  apiKey,
  modelName,
  fetchFn
}: {
  apiKey: string;
  modelName: string;
  fetchFn: typeof fetch;
}): IntakeModel {
  return async (parts: IntakeModelPart[]) => {
    const content = parts.map((part) =>
      part.type === "text"
        ? { type: "text", text: part.text }
        : {
            type: "image_url",
            image_url: { url: `data:${part.mimeType};base64,${part.dataBase64}` }
          }
    );
    const response = await fetchFn("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "http-referer": "https://quoteops.local",
        "x-title": "QuoteOps Appliance"
      },
      body: JSON.stringify({
        model: modelName,
        temperature: 0,
        messages: [{ role: "user", content }]
      })
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`OpenRouter extraction responded with HTTP ${response.status}`);
    }
    const body = JSON.parse(raw) as { choices?: { message?: { content?: string } }[] };
    return body.choices?.[0]?.message?.content ?? "";
  };
}

function geminiIntakeModel({
  apiKey,
  modelName
}: {
  apiKey: string;
  modelName: string;
}): IntakeModel {
  return async (parts: IntakeModelPart[]) => {
    const { GoogleGenAI } = await import("@google/genai");
    const client = new GoogleGenAI({ apiKey });
    const response = await client.models.generateContent({
      model: modelName,
      contents: [
        {
          role: "user",
          parts: parts.map((part) =>
            part.type === "text"
              ? { text: part.text }
              : { inlineData: { mimeType: part.mimeType, data: part.dataBase64 } }
          )
        }
      ]
    });
    return response.text ?? "";
  };
}

function openaiIntakeModel({
  modelName,
  apiKeyEnv,
  baseUrl,
  env
}: {
  modelName: string;
  apiKeyEnv: string;
  baseUrl?: string | null;
  env: NodeJS.ProcessEnv;
}): IntakeModel {
  const model = createChatModel({ provider: "openai", model_name: modelName, api_key_env: apiKeyEnv, base_url: baseUrl }, env);
  return async (parts: IntakeModelPart[]) => {
    const content = parts.map((part) =>
      part.type === "text"
        ? { type: "text" as const, text: part.text }
        : {
            type: "image_url" as const,
            image_url: { url: `data:${part.mimeType};base64,${part.dataBase64}` }
          }
    );
    const response = await model.invoke([{ role: "user", content }]);
    return typeof response.content === "string" ? response.content : JSON.stringify(response.content);
  };
}

function generateRfqId(now: Date): string {
  // ponytail: random 6-digit suffix; collision odds are negligible at appliance volume
  const suffix = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
  return `RFQ-${now.getFullYear()}-${suffix}`;
}
