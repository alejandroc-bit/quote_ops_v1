import { readFile } from "node:fs/promises";

export const DEFAULT_LOCAL_KEYS_PATH = "/Users/alejandro/inducta/## KEYS.md";

export type LocalApiKeyOptions = {
  env?: NodeJS.ProcessEnv;
  apiKeyEnv?: string | null;
  envFilePath?: string | null;
  keysPath?: string | null;
};

const SAKBE_PROVIDER_PATTERN = /(^|[^A-Za-z0-9])(?:sakb[eé]|sacv|sacbe)([^A-Za-z0-9]|$)/i;
const INEGI_PROVIDER_PATTERN = /(^|[^A-Za-z0-9])inegi([^A-Za-z0-9]|$)/i;

export async function loadSakbeApiKey(options: LocalApiKeyOptions = {}): Promise<string | null> {
  const env = options.env ?? process.env;
  const fromEnv =
    readEnv(env, options.apiKeyEnv) ??
    readEnv(env, "INEGI_SAKBE_KEY") ??
    readEnv(env, "QUOTEOPS_SAKBE_API_KEY");
  if (fromEnv) {
    return fromEnv;
  }

  const envFileKey =
    (await loadEnvFileValue({
      env,
      key: options.apiKeyEnv || "INEGI_SAKBE_KEY",
      envFilePath: options.envFilePath
    })) ??
    (await loadEnvFileValue({ env, key: "INEGI_SAKBE_KEY", envFilePath: options.envFilePath })) ??
    (await loadEnvFileValue({
      env,
      key: "QUOTEOPS_SAKBE_API_KEY",
      envFilePath: options.envFilePath
    }));
  if (envFileKey) {
    return envFileKey;
  }

  const keysPath = options.keysPath ?? null;
  if (!keysPath) {
    return null;
  }

  try {
    const raw = await readFile(keysPath, "utf8");
    return extractSakbeApiKey(raw);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function loadEnvFileValue({
  env = process.env,
  key,
  envFilePath
}: {
  env?: NodeJS.ProcessEnv;
  key: string;
  envFilePath?: string | null;
}): Promise<string | null> {
  const path = envFilePath === undefined ? env.QUOTEOPS_SECRETS_ENV_FILE : envFilePath;
  if (!path) {
    return null;
  }

  try {
    const raw = await readFile(path, "utf8");
    const parsed = parseEnvFile(raw);
    return parsed[key]?.trim() || null;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function parseEnvFile(raw: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }
    const [, key, value] = match;
    if (!key || value === undefined) {
      continue;
    }
    output[key] = unquoteEnvValue(value);
  }
  return output;
}

export function extractSakbeApiKey(raw: string): string | null {
  const lines = raw.split(/\r?\n/);
  const sakbeLabelled = extractLabelledKey(lines, SAKBE_PROVIDER_PATTERN);
  if (sakbeLabelled) {
    return sakbeLabelled;
  }

  const sakbeBlock = extractFromProviderBlock(lines, SAKBE_PROVIDER_PATTERN);
  if (sakbeBlock) {
    return sakbeBlock;
  }

  const inegiLabelled = extractLabelledKey(lines, INEGI_PROVIDER_PATTERN, { rejectLine: /denue/i });
  if (inegiLabelled) {
    return inegiLabelled;
  }

  return extractFromProviderBlock(lines, INEGI_PROVIDER_PATTERN, { rejectLine: /denue/i });
}

function extractLabelledKey(
  lines: string[],
  providerPattern: RegExp,
  options: { rejectLine?: RegExp } = {}
): string | null {
  for (const line of lines) {
    if (!providerPattern.test(line) || options.rejectLine?.test(line)) {
      continue;
    }
    const explicit = line.match(
      /(?:sakb[eé]|sacv|sacbe|inegi)[A-Za-z0-9_\-\s]*(?:api[_\-\s]*)?(?:key|token|llave)?\s*[:=]\s*([^\s`'"]+)/i
    )?.[1];
    const normalized = normalizeCandidate(explicit);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function extractFromProviderBlock(
  lines: string[],
  providerPattern: RegExp,
  options: { rejectLine?: RegExp } = {}
): string | null {
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripMarkdown(lines[index] ?? "");
    if (!providerPattern.test(line) || options.rejectLine?.test(line)) {
      continue;
    }

    for (const candidateLine of lines.slice(index + 1, index + 8)) {
      const normalized = normalizeCandidate(extractCandidate(candidateLine));
      if (normalized) {
        return normalized;
      }
      if (/^#{1,6}\s+\S/.test(candidateLine)) {
        break;
      }
    }
  }
  return null;
}

function extractCandidate(line: string): string | null {
  const withoutComment = stripMarkdown(line).split(/\s+#/)[0]?.trim() ?? "";
  if (!withoutComment) {
    return null;
  }

  return (
    withoutComment.match(/(?:api[_\-\s]*)?(?:key|token|llave)\s*[:=]\s*([^\s`'"]+)/i)?.[1] ??
    withoutComment.match(/^[-*]?\s*([A-Za-z0-9][A-Za-z0-9._~:/+=-]{15,})\s*$/)?.[1] ??
    null
  );
}

function normalizeCandidate(value: string | null | undefined): string | null {
  const candidate = value?.trim().replace(/^['"`]+|['"`]+$/g, "");
  if (!candidate || candidate.length < 16) {
    return null;
  }
  if (/^sk-or-/i.test(candidate)) {
    return null;
  }
  if (/gemini|openrouter|placeholder|example|redacted/i.test(candidate)) {
    return null;
  }
  if (!/[0-9._~:/+=-]/.test(candidate)) {
    return null;
  }
  return candidate;
}

function stripMarkdown(value: string): string {
  return value.replace(/^#{1,6}\s*/, "").trim();
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\`/g, "`")
      .replace(/\\\$/g, "$")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readEnv(env: NodeJS.ProcessEnv, key: string | null | undefined): string | null {
  if (!key) {
    return null;
  }
  const value = env[key];
  return value?.trim() || null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
