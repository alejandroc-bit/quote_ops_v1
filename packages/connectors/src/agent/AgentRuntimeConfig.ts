import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export type AgentModelProvider =
  | "deterministic"
  | "gemini_sdk"
  | "openai"
  | "openrouter"
  | "claude_cli";
export type AgentToolEffect = "read" | "write" | "send" | "approve";
export type AgentToolMode = "allowed" | "approval_required" | "disabled";

export type AgentToolPolicy = {
  effect: AgentToolEffect;
  mode: AgentToolMode;
};

export type AgentMailboxProvider = "gmail" | "outlook" | "imap";
export type AgentMailboxAuthType = "oauth2" | "password";

/**
 * A mailbox the client assigns to the agent as an intake tool. This holds only
 * non-secret connection settings; the address and credentials are read from the
 * appliance secrets env (MAILBOX_USER, MAILBOX_PASSWORD or MAILBOX_OAUTH_*),
 * never from the client pack.
 */
export type AgentMailboxConfig = {
  provider: AgentMailboxProvider;
  auth: AgentMailboxAuthType;
  processed_mailbox: string | null;
  poll_interval_ms: number;
  imap_host: string | null;
  imap_port: number | null;
};

export const agentMailboxConfigSchema = z
  .object({
    provider: z.enum(["gmail", "outlook", "imap"]).default("gmail"),
    auth: z.enum(["oauth2", "password"]).default("oauth2"),
    processed_mailbox: z.string().min(1).nullable().default(null),
    poll_interval_ms: z.number().int().positive().default(60_000),
    imap_host: z.string().min(1).nullable().default(null),
    imap_port: z.number().int().positive().nullable().default(null)
  })
  .strict();

export type AgentEmbeddingsProvider = "gemini" | "openai_compatible";

/**
 * Embedding provider for the local vector knowledge base (the agent's
 * commercial brain). Non-secret settings only; the API key lives in the
 * appliance secrets under `api_key_env`. Without this block, knowledge
 * ingestion/search stays disabled (fail-closed).
 */
export type AgentEmbeddingsConfig = {
  provider: AgentEmbeddingsProvider;
  model: string;
  api_key_env: string;
  base_url: string | null;
};

export const agentEmbeddingsConfigSchema = z
  .object({
    provider: z.enum(["gemini", "openai_compatible"]).default("gemini"),
    model: z.string().min(1).default("text-embedding-004"),
    api_key_env: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an env var name")
      .default("QUOTEOPS_EMBEDDING_API_KEY"),
    base_url: z.string().url().nullable().default(null)
  })
  .strict();

export type AgentRuntimeConfig = {
  model: {
    provider: AgentModelProvider;
    model_name: string;
    temperature: number;
    api_key_env?: string | null;
  };
  authorization: {
    tools: Record<string, AgentToolPolicy>;
  };
  mailbox: AgentMailboxConfig | null;
  embeddings: AgentEmbeddingsConfig | null;
};

const agentModelProviders = [
  "deterministic",
  "gemini_sdk",
  "openai",
  "openrouter",
  "claude_cli"
] as const satisfies readonly AgentModelProvider[];
const agentToolEffects = [
  "read",
  "write",
  "send",
  "approve"
] as const satisfies readonly AgentToolEffect[];
const agentToolModes = [
  "allowed",
  "approval_required",
  "disabled"
] as const satisfies readonly AgentToolMode[];

export class AgentAuthorizationError extends Error {
  readonly code: string;
  readonly toolName: string;

  constructor(message: string, options: { code: string; toolName: string }) {
    super(message);
    this.name = "AgentAuthorizationError";
    this.code = options.code;
    this.toolName = options.toolName;
  }
}

export async function loadAgentRuntimeConfig(path?: string): Promise<AgentRuntimeConfig> {
  if (!path) {
    return defaultAgentRuntimeConfig();
  }

  let raw = "";
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`Agent runtime config not found: ${path}`);
    }
    throw error;
  }

  if (!raw.trim()) {
    throw new Error(`Agent runtime config is empty: ${path}`);
  }

  const parsed = path.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
  return normalizeAgentRuntimeConfig(parsed);
}

export function defaultAgentRuntimeConfig(): AgentRuntimeConfig {
  return {
    model: {
      provider: "deterministic",
      model_name: "quote-core-preserver",
      temperature: 0,
      api_key_env: null
    },
    authorization: {
      tools: {
        "email.intake": { effect: "read", mode: "allowed" },
        "knowledge.search": { effect: "read", mode: "allowed" },
        "route.resolve": { effect: "read", mode: "allowed" },
        "tms.searchHistorical": { effect: "read", mode: "allowed" },
        "tms.writeQuoteResult": { effect: "write", mode: "allowed" },
        "email.sendQuote": { effect: "send", mode: "approval_required" },
        "approval.decide": { effect: "approve", mode: "approval_required" }
      }
    },
    mailbox: null,
    embeddings: null
  };
}

export function assertAgentToolAllowed({
  config,
  toolName,
  approvalGranted = false
}: {
  config: AgentRuntimeConfig;
  toolName: string;
  approvalGranted?: boolean;
}): void {
  const policy = config.authorization.tools[toolName] ?? disabledPolicyForUndeclaredTool();

  if (policy.mode === "disabled") {
    throw new AgentAuthorizationError(`Agent tool is disabled: ${toolName}`, {
      code: "agent_tool_disabled",
      toolName
    });
  }

  if (policy.mode === "approval_required" && !approvalGranted) {
    throw new AgentAuthorizationError(`Agent tool requires approval: ${toolName}`, {
      code: "agent_tool_approval_required",
      toolName
    });
  }
}

function normalizeAgentRuntimeConfig(value: unknown): AgentRuntimeConfig {
  const defaults = defaultAgentRuntimeConfig();
  if (!isRecord(value)) {
    throw new Error("Agent runtime config must be an object");
  }

  assertKnownKeys(value, ["model", "authorization", "mailbox", "embeddings"], "Agent runtime config");
  const model = requiredRecord(value, "model", "Agent runtime config model");
  const authorization = requiredRecord(
    value,
    "authorization",
    "Agent runtime config authorization"
  );
  const tools = requiredRecord(authorization, "tools", "Agent runtime config authorization.tools");

  return {
    model: {
      provider: hasOwn(model, "provider")
        ? parseProvider(model.provider)
        : parseMissing("Agent runtime config model.provider"),
      model_name: hasOwn(model, "model_name")
        ? parseNonEmptyString(model.model_name, "Agent runtime config model.model_name")
        : parseMissing("Agent runtime config model.model_name"),
      temperature: hasOwn(model, "temperature")
        ? parseFiniteNumber(model.temperature, "Agent runtime config model.temperature")
        : defaults.model.temperature,
      api_key_env: hasOwn(model, "api_key_env")
        ? parseOptionalEnvName(model.api_key_env, "Agent runtime config model.api_key_env")
        : defaults.model.api_key_env
    },
    authorization: {
      tools: normalizeToolPolicies(tools)
    },
    mailbox:
      hasOwn(value, "mailbox") && value.mailbox != null
        ? agentMailboxConfigSchema.parse(value.mailbox)
        : null,
    embeddings:
      hasOwn(value, "embeddings") && value.embeddings != null
        ? agentEmbeddingsConfigSchema.parse(value.embeddings)
        : null
  };
}

function normalizeToolPolicies(value: Record<string, unknown>): Record<string, AgentToolPolicy> {
  return Object.fromEntries(
    Object.entries(value).map(([toolName, policy]) => [
      toolName,
      normalizeToolPolicy(toolName, policy)
    ])
  );
}

function normalizeToolPolicy(toolName: string, policy: unknown): AgentToolPolicy {
  if (!isRecord(policy)) {
    throw new Error(`Agent runtime config tool policy for ${toolName} must be an object`);
  }

  return {
    effect: parseEffect(policy.effect, toolName),
    mode: parseMode(policy.mode, toolName)
  };
}

function disabledPolicyForUndeclaredTool(): AgentToolPolicy {
  return { effect: "write", mode: "disabled" };
}

function parseProvider(value: unknown): AgentModelProvider {
  if (isAgentModelProvider(value)) {
    return value;
  }
  throw new Error(
    `Invalid agent model provider: ${formatConfigValue(value)}. Expected one of: ${agentModelProviders.join(", ")}`
  );
}

function parseEffect(value: unknown, toolName: string): AgentToolEffect {
  if (isAgentToolEffect(value)) {
    return value;
  }
  throw new Error(
    `Invalid agent tool policy effect for ${toolName}: ${formatConfigValue(value)}. Expected one of: ${agentToolEffects.join(", ")}`
  );
}

function parseMode(value: unknown, toolName: string): AgentToolMode {
  if (isAgentToolMode(value)) {
    return value;
  }
  throw new Error(
    `Invalid agent tool policy mode for ${toolName}: ${formatConfigValue(value)}. Expected one of: ${agentToolModes.join(", ")}`
  );
}

function parseNonEmptyString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new Error(`${label} must be a non-empty string`);
}

function parseFiniteNumber(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new Error(`${label} must be a finite number`);
}

function parseOptionalEnvName(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new Error(`${label} must be a non-empty string or null`);
}

function parseMissing(label: string): never {
  throw new Error(`${label} is required`);
}

function requiredRecord(
  record: Record<string, unknown>,
  key: string,
  label: string
): Record<string, unknown> {
  if (!hasOwn(record, key)) {
    throw new Error(`${label} is required`);
  }

  const value = record[key];
  if (isRecord(value)) {
    return value;
  }
  throw new Error(`${label} must be an object`);
}

function assertKnownKeys(
  record: Record<string, unknown>,
  knownKeys: readonly string[],
  label: string
): void {
  const known = new Set(knownKeys);
  const unknown = Object.keys(record).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown key: ${unknown[0]}`);
  }
}

function isAgentModelProvider(value: unknown): value is AgentModelProvider {
  return typeof value === "string" && (agentModelProviders as readonly string[]).includes(value);
}

function isAgentToolEffect(value: unknown): value is AgentToolEffect {
  return typeof value === "string" && (agentToolEffects as readonly string[]).includes(value);
}

function isAgentToolMode(value: unknown): value is AgentToolMode {
  return typeof value === "string" && (agentToolModes as readonly string[]).includes(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function formatConfigValue(value: unknown): string {
  if (typeof value === "string") {
    return `"${value}"`;
  }
  if (value === undefined) {
    return "undefined";
  }
  return JSON.stringify(value) ?? String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
