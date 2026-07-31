import { lstat, readFile } from "node:fs/promises";
import {
  loadAgentRuntimeConfig,
  loadTmsAdapterConfig,
  type AgentRuntimeConfig,
  type TmsAdapterFactoryConfig
} from "@quoteops/connectors";

const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;
const CLOUDFLARE_HOSTNAME =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

export type LifecycleSecretKeyInput = {
  agentConfigPath: string;
  tmsConfigPath: string;
  cloudflareSettingsPath?: string;
  sakbeLive: boolean;
  availableKeys: readonly string[];
};

export class MissingActiveSecretKeyError extends Error {
  constructor(key: string) {
    super(`required active secret key is missing: ${key}`);
    this.name = "MissingActiveSecretKeyError";
  }
}

export async function deriveLifecycleRequiredSecretKeys(
  input: LifecycleSecretKeyInput
): Promise<string[]> {
  const available = validateAvailableKeys(input.availableKeys);
  await assertRegularConfigFile(input.agentConfigPath, "agent config");
  await assertRegularConfigFile(input.tmsConfigPath, "TMS config");

  const [agent, tms] = await Promise.all([
    loadAgentRuntimeConfig(input.agentConfigPath),
    loadTmsAdapterConfig(input.tmsConfigPath)
  ]);
  const required = new Set<string>([
    "POSTGRES_PASSWORD",
    "QUOTEOPS_REGISTRATION_TOKEN"
  ]);

  addAgentKeys(required, agent);
  addTmsKeys(required, tms);

  if (input.cloudflareSettingsPath) {
    await validateCloudflareSettings(input.cloudflareSettingsPath);
    required.add("TUNNEL_TOKEN");
  }
  if (input.sakbeLive) {
    required.add(
      available.has("INEGI_SAKBE_KEY")
        ? "INEGI_SAKBE_KEY"
        : "QUOTEOPS_SAKBE_API_KEY"
    );
  }

  const sorted = [...required].sort();
  for (const key of sorted) {
    if (!available.has(key)) {
      throw new MissingActiveSecretKeyError(key);
    }
  }
  return sorted;
}

export function parseLifecycleBoolean(value: string): boolean {
  switch (value.toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      throw new Error("SAKBE live setting is invalid");
  }
}

function addAgentKeys(required: Set<string>, config: AgentRuntimeConfig): void {
  const modelKey = modelApiKey(config);
  if (modelKey) {
    required.add(modelKey);
  }

  if (config.mailbox) {
    required.add("MAILBOX_USER");
    if (config.mailbox.provider === "resend") {
      required.add("RESEND_API_KEY");
    } else if (config.mailbox.auth === "password") {
      required.add("MAILBOX_PASSWORD");
    } else {
      required.add("MAILBOX_OAUTH_CLIENT_ID");
      required.add("MAILBOX_OAUTH_CLIENT_SECRET");
      required.add("MAILBOX_OAUTH_REFRESH_TOKEN");
    }
  }

  if (config.embeddings) {
    required.add(config.embeddings.api_key_env);
  }
}

function modelApiKey(config: AgentRuntimeConfig): string | null {
  const configured = config.model.api_key_env ?? null;
  switch (config.model.provider) {
    case "deterministic":
    case "claude_cli":
      return null;
    case "openrouter":
      return configured ?? "OPENROUTER_API_KEY";
    case "gemini_sdk":
      return configured ?? "GEMINI_API_KEY";
    case "openai":
      if (!configured) {
        throw new Error("active OpenAI model config requires api_key_env");
      }
      return configured;
  }
}

function addTmsKeys(required: Set<string>, config: TmsAdapterFactoryConfig): void {
  if (config.provider === "file_import") {
    return;
  }
  if (config.provider === "sql") {
    required.add(config.connection_url_env);
    return;
  }
  for (const value of Object.values(config.headers ?? {})) {
    for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      required.add(match[1]!);
    }
  }
}

function validateAvailableKeys(keys: readonly string[]): Set<string> {
  const available = new Set<string>();
  for (const key of keys) {
    if (!ENV_KEY.test(key)) {
      throw new Error("available secret key name is invalid");
    }
    if (available.has(key)) {
      throw new Error(`available secret key is duplicated: ${key}`);
    }
    available.add(key);
  }
  return available;
}

async function assertRegularConfigFile(path: string, label: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
}

async function validateCloudflareSettings(path: string): Promise<void> {
  await assertRegularConfigFile(path, "Cloudflare settings");
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(parsed)) {
    throw new Error("Cloudflare settings must be an object");
  }
  const keys = Object.keys(parsed).sort();
  if (
    keys.join("\n") !== ["origin_url", "provider", "public_hostname"].join("\n") ||
    parsed.provider !== "cloudflare" ||
    parsed.origin_url !== "http://caddy:80" ||
    typeof parsed.public_hostname !== "string" ||
    !CLOUDFLARE_HOSTNAME.test(parsed.public_hostname)
  ) {
    throw new Error("Cloudflare settings failed exact-schema validation");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
