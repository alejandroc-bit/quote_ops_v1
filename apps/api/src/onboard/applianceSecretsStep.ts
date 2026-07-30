import { createHash } from "node:crypto";
import { connect, type TLSSocket } from "node:tls";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  OnboardingError,
  type OnboardingAnswers,
  type OnboardingContext,
  type OnboardingPhase
} from "./onboardingFlow.js";
import {
  atomicWriteJson,
  atomicWriteText,
  readEnvFileValues,
  readSingleLineSecret,
  sha256File,
  updateAllowedEnv
} from "./onboardConfig.js";

type ApplianceSecretAnswers = Pick<
  OnboardingAnswers,
  "mailbox" | "sakbe" | "embeddings"
>;

type MailboxProbeReceipt = {
  schema_version: 1;
  provider: "resend" | "imap";
  status: "ok";
  agent_config_sha256: string;
  credential_revision: number;
  validated_at: string;
  code: "message_accepted" | "authenticated_read_only";
};

const APPLIANCE_ENV_KEYS = [
  "RESEND_API_KEY",
  "MAILBOX_USER",
  "MAILBOX_FROM",
  "MAILBOX_PASSWORD",
  "INEGI_SAKBE_KEY",
  "QUOTEOPS_EMBEDDING_API_KEY"
] as const;

export async function configureApplianceSecrets(
  input: ApplianceSecretAnswers,
  context: OnboardingContext
): Promise<void> {
  const currentBody = await readFile(context.paths.agentConfigFile, "utf8").catch(
    () => ""
  );
  const currentConfig = parseAgentConfig(currentBody);
  const updates: Record<string, string | null> = Object.fromEntries(
    APPLIANCE_ENV_KEYS.map((key) => [key, null])
  );
  let mailbox:
    | {
        provider: "resend";
        auth: "password";
        processed_mailbox: null;
        poll_interval_ms: 60000;
        imap_host: null;
        imap_port: null;
      }
    | {
        provider: "imap";
        auth: "password";
        processed_mailbox: null;
        poll_interval_ms: 60000;
        imap_host: string;
        imap_port: number;
      }
    | undefined;
  let mailboxProbe:
    | { provider: "resend"; code: "message_accepted" }
    | { provider: "imap"; code: "authenticated_read_only" }
    | undefined;

  if (input.mailbox?.provider === "resend") {
    const apiKey = await readSingleLineSecret(input.mailbox.api_key, context);
    const intakeAddress = validateEmailLike(input.mailbox.intake_address);
    const fromAddress = validateEmailLike(input.mailbox.from_address);
    await probeResend(
      {
        apiKey,
        intakeAddress,
        fromAddress,
        idempotencyKey: mailboxIdempotencyKey(context, {
          provider: "resend",
          intakeAddress,
          fromAddress
        })
      },
      context
    );
    updates.RESEND_API_KEY = apiKey;
    updates.MAILBOX_USER = intakeAddress;
    updates.MAILBOX_FROM = fromAddress;
    mailbox = {
      provider: "resend",
      auth: "password",
      processed_mailbox: null,
      poll_interval_ms: 60000,
      imap_host: null,
      imap_port: null
    };
    mailboxProbe = { provider: "resend", code: "message_accepted" };
  } else if (input.mailbox?.provider === "imap") {
    const password = await readSingleLineSecret(input.mailbox.password, context);
    const user = validateNonSecretText(input.mailbox.user);
    const host = validateMailboxHost(input.mailbox.host);
    if (
      !Number.isInteger(input.mailbox.port) ||
      input.mailbox.port < 1 ||
      input.mailbox.port > 65535
    ) {
      throw new OnboardingError("mailbox_config_invalid");
    }
    const probe = context.probeImap ?? probeImapTls;
    try {
      await probe({
        host,
        port: input.mailbox.port,
        user,
        password,
        timeoutMs: 10_000
      });
    } catch {
      throw new OnboardingError("mailbox_auth_rejected");
    }
    updates.MAILBOX_USER = user;
    updates.MAILBOX_PASSWORD = password;
    mailbox = {
      provider: "imap",
      auth: "password",
      processed_mailbox: null,
      poll_interval_ms: 60000,
      imap_host: host,
      imap_port: input.mailbox.port
    };
    mailboxProbe = { provider: "imap", code: "authenticated_read_only" };
  }

  if (input.sakbe) {
    updates.INEGI_SAKBE_KEY = await readSingleLineSecret(
      input.sakbe.api_key,
      context
    );
  }

  let embeddings: Record<string, unknown> | undefined;
  if (input.embeddings) {
    updates.QUOTEOPS_EMBEDDING_API_KEY = await readSingleLineSecret(
      input.embeddings.api_key,
      context
    );
    const model = validateNonSecretText(input.embeddings.model);
    embeddings =
      input.embeddings.provider === "gemini"
        ? {
            provider: "gemini",
            model,
            api_key_env: "QUOTEOPS_EMBEDDING_API_KEY",
            base_url: null
          }
        : {
            provider: "openai_compatible",
            model,
            api_key_env: "QUOTEOPS_EMBEDDING_API_KEY",
            base_url: validateHttpsUrl(input.embeddings.base_url)
          };
  }

  const nextConfig = {
    ...currentConfig,
    ...(mailbox ? { mailbox } : {}),
    ...(embeddings ? { embeddings } : {})
  };
  if (!mailbox) delete nextConfig.mailbox;
  if (!embeddings) delete nextConfig.embeddings;

  await updateAllowedEnv(
    context.paths.clientSecretsFile,
    updates,
    APPLIANCE_ENV_KEYS,
    () => context.afterAtomicRename?.("appliance_client_env")
  );
  await atomicWriteText(
    context.paths.agentConfigFile,
    stringifyYaml(nextConfig),
    {
      mode: 0o600,
      afterRename: () => context.afterAtomicRename?.("appliance_agent_config")
    }
  );

  const revisionFile = join(
    context.paths.settingsDir,
    "appliance-secrets-credential.json"
  );
  const revision = (await readRevision(revisionFile)) + 1;
  await atomicWriteJson(
    revisionFile,
    { schema_version: 1, credential_revision: revision },
    {
      mode: 0o600,
      afterRename: () =>
        context.afterAtomicRename?.("appliance_credential_revision")
    }
  );
  if (mailboxProbe) {
    const receipt: MailboxProbeReceipt = {
      schema_version: 1,
      provider: mailboxProbe.provider,
      status: "ok",
      agent_config_sha256: await sha256File(context.paths.agentConfigFile),
      credential_revision: revision,
      validated_at: (context.now?.() ?? new Date()).toISOString(),
      code: mailboxProbe.code
    };
    await atomicWriteJson(context.paths.mailboxProbeReceiptFile, receipt, {
      mode: 0o600,
      afterRename: () => context.afterAtomicRename?.("mailbox_probe_receipt")
    });
  }
}

export const applianceSecretsPhase: OnboardingPhase = {
  id: "appliance_secrets",
  async isComplete(context) {
    return isApplianceSecretsComplete(context);
  },
  async run(context) {
    if (context.answers) {
      await configureApplianceSecrets(context.answers, context);
      return;
    }
    if (!context.guided) {
      throw new OnboardingError("onboarding_pending", {
        phase: "appliance_secrets"
      });
    }
    const existing = parseAgentConfig(
      await readFile(context.paths.agentConfigFile, "utf8").catch(() => "")
    );
    const input: ApplianceSecretAnswers = {};
    const configuredMailbox =
      existing.mailbox && typeof existing.mailbox === "object"
        ? (existing.mailbox as Record<string, unknown>)
        : null;
    if (configuredMailbox?.provider === "resend") {
      input.mailbox = {
        provider: "resend",
        api_key: {
          file: await context.io.ask("Archivo 0600 con la clave de Resend")
        },
        intake_address: await context.io.ask("Buzón de entrada"),
        from_address: await context.io.ask("Remitente validado")
      };
    } else if (configuredMailbox?.provider === "imap") {
      input.mailbox = {
        provider: "imap",
        user: await context.io.ask("Usuario IMAP"),
        password: {
          file: await context.io.ask("Archivo 0600 con la contraseña IMAP")
        },
        host: String(configuredMailbox.imap_host ?? ""),
        port: Number(configuredMailbox.imap_port ?? 993)
      };
    }
    const configuredEmbeddings =
      existing.embeddings && typeof existing.embeddings === "object"
        ? (existing.embeddings as Record<string, unknown>)
        : null;
    if (
      configuredEmbeddings?.provider === "gemini" ||
      configuredEmbeddings?.provider === "openai_compatible"
    ) {
      const keyFile = await context.io.ask(
        "Archivo 0600 con la clave de embeddings"
      );
      input.embeddings =
        configuredEmbeddings.provider === "gemini"
          ? {
              provider: "gemini",
              model: String(configuredEmbeddings.model ?? ""),
              api_key: { file: keyFile }
            }
          : {
              provider: "openai_compatible",
              model: String(configuredEmbeddings.model ?? ""),
              base_url: String(configuredEmbeddings.base_url ?? ""),
              api_key: { file: keyFile }
            };
    }
    await configureApplianceSecrets(input, context);
  }
};

export async function isApplianceSecretsComplete(
  context: OnboardingContext
): Promise<boolean> {
  let config: Record<string, unknown>;
  try {
    config = parseAgentConfig(
      await readFile(context.paths.agentConfigFile, "utf8")
    );
  } catch {
    return false;
  }
  const env = await readEnvFileValues(context.paths.clientSecretsFile);
  const mailbox =
    config.mailbox && typeof config.mailbox === "object"
      ? (config.mailbox as Record<string, unknown>)
      : null;
  if (mailbox) {
    const provider = mailbox.provider;
    const exactMailboxKeys =
      provider === "resend"
        ? env.has("RESEND_API_KEY") &&
          env.has("MAILBOX_USER") &&
          env.has("MAILBOX_FROM") &&
          !env.has("MAILBOX_PASSWORD")
        : provider === "imap"
          ? env.has("MAILBOX_USER") &&
            env.has("MAILBOX_PASSWORD") &&
            !env.has("RESEND_API_KEY") &&
            !env.has("MAILBOX_FROM")
          : false;
    if (!exactMailboxKeys) return false;
    const receipt = await readMailboxReceipt(
      context.paths.mailboxProbeReceiptFile
    );
    const revision = await readRevision(
      join(context.paths.settingsDir, "appliance-secrets-credential.json")
    );
    if (
      !receipt ||
      receipt.provider !== provider ||
      receipt.credential_revision !== revision ||
      receipt.agent_config_sha256 !==
        (await sha256File(context.paths.agentConfigFile))
    ) {
      return false;
    }
  }
  const embeddings =
    config.embeddings && typeof config.embeddings === "object"
      ? (config.embeddings as Record<string, unknown>)
      : null;
  if (
    embeddings &&
    (embeddings.api_key_env !== "QUOTEOPS_EMBEDDING_API_KEY" ||
      !env.has("QUOTEOPS_EMBEDDING_API_KEY"))
  ) {
    return false;
  }
  return true;
}

export async function runKnowledgeIngestion(
  context: OnboardingContext
): Promise<void> {
  const config = parseAgentConfig(
    await readFile(context.paths.agentConfigFile, "utf8")
  );
  const embeddings =
    config.embeddings && typeof config.embeddings === "object"
      ? (config.embeddings as Record<string, unknown>)
      : null;
  const env = await readEnvFileValues(context.paths.clientSecretsFile);
  if (
    !embeddings ||
    embeddings.api_key_env !== "QUOTEOPS_EMBEDDING_API_KEY" ||
    !env.has("QUOTEOPS_EMBEDDING_API_KEY")
  ) {
    throw new OnboardingError("embeddings_not_configured");
  }

  const stableDir = knowledgeDirectory(context);
  await mkdir(stableDir, { recursive: true, mode: 0o700 });
  const answer = context.answers?.knowledge;
  let sourceHashes: string[];
  if (answer) {
    if (answer.consent_external_embedding_transfer !== true) {
      throw new OnboardingError("knowledge_consent_required");
    }
    sourceHashes = await stageKnowledgeSources(
      answer.sources.map((source) => source.file),
      stableDir,
      context.answersRoot
    );
  } else {
    if (!context.guided) {
      throw new OnboardingError("onboarding_pending", { phase: "knowledge" });
    }
    const consent = await context.io.confirm(
      "El texto de los documentos se enviará al proveedor de embeddings configurado; los vectores y la base de QuoteOps permanecen locales. ¿Continuar?"
    );
    if (!consent) throw new OnboardingError("knowledge_consent_required");
    const files = await listKnowledgeSourceFiles(stableDir);
    sourceHashes = await Promise.all(
      files.map(async (file) => createHash("sha256").update(await readFile(join(stableDir, file))).digest("hex"))
    );
  }
  if (sourceHashes.length === 0) {
    throw new OnboardingError("knowledge_sources_required");
  }

  let response: Response;
  try {
    response = await context.fetch(
      `${context.paths.apiBaseUrl}/api/knowledge/ingest`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(10_000)
      }
    );
  } catch {
    throw new OnboardingError("knowledge_ingest_unreachable");
  }
  if (!response.ok) throw new OnboardingError("knowledge_ingest_failed");
  let body: {
    document_count?: unknown;
    ingested?: unknown;
  };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new OnboardingError("knowledge_ingest_invalid_response");
  }
  const documentCount =
    typeof body.document_count === "number" ? body.document_count : 0;
  const chunkCount = Array.isArray(body.ingested)
    ? body.ingested.reduce(
        (sum, entry) =>
          sum +
          (entry &&
          typeof entry === "object" &&
          typeof (entry as { chunk_count?: unknown }).chunk_count === "number"
            ? Number((entry as { chunk_count: number }).chunk_count)
            : 0),
        0
      )
    : 0;
  if (documentCount <= 0 || chunkCount <= 0) {
    throw new OnboardingError("knowledge_ingest_empty");
  }
  await atomicWriteJson(
    context.paths.knowledgeReceiptFile,
    {
      schema_version: 1,
      source_hashes: sourceHashes.sort(),
      provider_config_sha256: await sha256File(
        context.paths.agentConfigFile
      ),
      document_count: documentCount,
      chunk_count: chunkCount,
      consent_external_embedding_transfer: true,
      consented_at: (context.now?.() ?? new Date()).toISOString()
    },
    {
      mode: 0o600,
      afterRename: () => context.afterAtomicRename?.("knowledge_receipt")
    }
  );
}

export const knowledgePhase: OnboardingPhase = {
  id: "knowledge",
  async isComplete(context) {
    try {
      const receipt = JSON.parse(
        await readFile(context.paths.knowledgeReceiptFile, "utf8")
      ) as {
        schema_version?: unknown;
        provider_config_sha256?: unknown;
        document_count?: unknown;
        chunk_count?: unknown;
        consent_external_embedding_transfer?: unknown;
      };
      if (
        receipt.schema_version !== 1 ||
        receipt.consent_external_embedding_transfer !== true ||
        Number(receipt.document_count) <= 0 ||
        Number(receipt.chunk_count) <= 0 ||
        receipt.provider_config_sha256 !==
          (await sha256File(context.paths.agentConfigFile))
      ) {
        return false;
      }
      const response = await context.fetch(
        `${context.paths.apiBaseUrl}/api/knowledge/status`,
        { signal: AbortSignal.timeout(10_000) }
      );
      if (!response.ok) return false;
      const status = (await response.json()) as {
        knowledge_chunks_count?: unknown;
      };
      return Number(status.knowledge_chunks_count) > 0;
    } catch {
      return false;
    }
  },
  async run(context) {
    await runKnowledgeIngestion(context);
  }
};

export async function stageKnowledgeSources(
  sources: string[],
  destination: string,
  acceptanceRoot?: string
): Promise<string[]> {
  if (sources.length < 1 || sources.length > 20) {
    throw new OnboardingError("knowledge_sources_invalid");
  }
  const hashes: string[] = [];
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const source of sources) {
    const sourcePath = resolve(source);
    if (acceptanceRoot) {
      let canonicalRoot: string;
      let canonicalSource: string;
      try {
        [canonicalRoot, canonicalSource] = await Promise.all([
          realpath(resolve(acceptanceRoot)),
          realpath(sourcePath)
        ]);
      } catch {
        throw new OnboardingError("knowledge_source_unsafe");
      }
      const fromRoot = relative(canonicalRoot, canonicalSource);
      if (
        fromRoot === ".." ||
        fromRoot.startsWith(`..${sep}`) ||
        isAbsolute(fromRoot)
      ) {
        throw new OnboardingError("knowledge_source_unsafe");
      }
    }
    const metadata = await lstat(sourcePath).catch(() => null);
    const extension = extname(sourcePath).toLowerCase();
    if (
      !metadata ||
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size > 5 * 1024 * 1024 ||
      ![".md", ".txt", ".json"].includes(extension)
    ) {
      throw new OnboardingError("knowledge_source_unsafe");
    }
    const contents = await readFile(sourcePath);
    const hash = createHash("sha256").update(contents).digest("hex");
    const safeBase = basename(sourcePath)
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 120);
    await atomicWriteText(join(destination, `${hash.slice(0, 16)}-${safeBase}`), contents.toString("utf8"), {
      mode: 0o600
    });
    hashes.push(hash);
  }
  return hashes;
}

export async function listKnowledgeSourceFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name !== "README.md" &&
          !entry.name.startsWith(".") &&
          [".md", ".txt", ".json"].includes(extname(entry.name).toLowerCase())
      )
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function probeResend(
  input: {
    apiKey: string;
    intakeAddress: string;
    fromAddress: string;
    idempotencyKey: string;
  },
  context: OnboardingContext
): Promise<void> {
  let response: Response;
  try {
    response = await context.fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
        "Idempotency-Key": input.idempotencyKey
      },
      body: JSON.stringify({
        from: input.fromAddress,
        to: [input.intakeAddress],
        subject: "QuoteOps onboarding validation",
        text: "QuoteOps onboarding validation"
      }),
      signal: AbortSignal.timeout(10_000)
    });
  } catch {
    throw new OnboardingError("mailbox_probe_unreachable");
  }
  if (response.status === 401 || response.status === 403) {
    throw new OnboardingError("mailbox_auth_rejected");
  }
  if (!response.ok) throw new OnboardingError("mailbox_probe_failed");
  try {
    const body = (await response.json()) as { id?: unknown };
    if (typeof body.id !== "string" || !body.id) {
      throw new OnboardingError("mailbox_probe_invalid_response");
    }
  } catch (error) {
    if (error instanceof OnboardingError) throw error;
    throw new OnboardingError("mailbox_probe_invalid_response");
  }
}

async function probeImapTls(input: {
  host: string;
  port: number;
  user: string;
  password: string;
  timeoutMs: number;
}): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let buffer = "";
    let stage = 0;
    const socket: TLSSocket = connect({
      host: input.host,
      port: input.port,
      servername: input.host,
      rejectUnauthorized: true
    });
    const timer = setTimeout(() => {
      socket.destroy();
      rejectPromise(new Error("timeout"));
    }, input.timeoutMs);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.destroy();
      error ? rejectPromise(error) : resolvePromise();
    };
    socket.once("error", () => finish(new Error("connection")));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (stage === 0 && /^\* OK\b/i.test(line)) {
          stage = 1;
          socket.write(
            `a1 LOGIN ${quoteImap(input.user)} ${quoteImap(input.password)}\r\n`
          );
        } else if (stage === 1 && /^a1 OK\b/i.test(line)) {
          stage = 2;
          socket.write("a2 EXAMINE INBOX\r\n");
        } else if (stage === 1 && /^a1 (?:NO|BAD)\b/i.test(line)) {
          finish(new Error("auth"));
        } else if (stage === 2 && /^a2 OK\b/i.test(line)) {
          stage = 3;
          socket.write("a3 LOGOUT\r\n");
        } else if (stage === 2 && /^a2 (?:NO|BAD)\b/i.test(line)) {
          finish(new Error("mailbox"));
        } else if (stage === 3 && /^a3 OK\b/i.test(line)) {
          finish();
        }
      }
    });
  });
}

function quoteImap(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function parseAgentConfig(contents: string): Record<string, unknown> {
  if (!contents.trim()) return {};
  const parsed = parseYaml(contents) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OnboardingError("agent_config_invalid");
  }
  return parsed as Record<string, unknown>;
}

function validateEmailLike(value: string): string {
  const normalized = validateNonSecretText(value);
  if (
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized) ||
    normalized.length > 254
  ) {
    throw new OnboardingError("mailbox_config_invalid");
  }
  return normalized;
}

function validateMailboxHost(value: string): string {
  const normalized = validateNonSecretText(value).toLowerCase();
  if (
    normalized.length > 253 ||
    normalized.split(".").some(
      (label) =>
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label) ||
        label.length > 63
    )
  ) {
    throw new OnboardingError("mailbox_config_invalid");
  }
  return normalized;
}

function validateNonSecretText(value: string): string {
  if (
    !value ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new OnboardingError("onboarding_input_invalid");
  }
  return value;
}

function validateHttpsUrl(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash
    ) {
      throw new Error("unsafe");
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new OnboardingError("embeddings_config_invalid");
  }
}

function mailboxIdempotencyKey(
  context: OnboardingContext,
  value: unknown
): string {
  const installation = context.env.QUOTEOPS_INSTALLATION_ID ?? "local";
  return `quoteops-onboarding-${createHash("sha256")
    .update(`${installation}:${JSON.stringify(value)}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function knowledgeDirectory(context: OnboardingContext): string {
  return join(dirname(dirname(context.paths.agentConfigFile)), "knowledge");
}

async function readRevision(file: string): Promise<number> {
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

async function readMailboxReceipt(
  file: string
): Promise<MailboxProbeReceipt | null> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as Partial<
      MailboxProbeReceipt
    >;
    return value.schema_version === 1 &&
      (value.provider === "resend" || value.provider === "imap") &&
      value.status === "ok" &&
      typeof value.agent_config_sha256 === "string" &&
      typeof value.credential_revision === "number" &&
      typeof value.validated_at === "string" &&
      (value.code === "message_accepted" ||
        value.code === "authenticated_read_only")
      ? (value as MailboxProbeReceipt)
      : null;
  } catch {
    return null;
  }
}
