import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { HistoricalSearchQuery } from "@quoteops/connectors";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import type { Copilot } from "./onboardConfig.js";

export type OnboardingPhaseId =
  | "ai_provider"
  | "license_activation"
  | "cloudflare"
  | "appliance_secrets"
  | "tms"
  | "units"
  | "authorization"
  | "pricing"
  | "knowledge"
  | "test_rfq";

export const ONBOARDING_PHASE_IDS: readonly OnboardingPhaseId[] = [
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
];

export type OnboardingIo = {
  ask(prompt: string, initial?: string): Promise<string>;
  askMasked(prompt: string): Promise<string>;
  confirm(prompt: string): Promise<boolean>;
  select<T extends string>(
    prompt: string,
    options: Array<{ value: T; label: string }>
  ): Promise<T>;
  info(message: string): void;
  warn(message: string): void;
};

export type OnboardPaths = {
  apiBaseUrl: string;
  agentConfigFile: string;
  clientSecretsFile: string;
  cloudflareSecretsFile: string;
  aiValidationReceiptFile: string;
  mailboxProbeReceiptFile: string;
  knowledgeReceiptFile: string;
  settingsDir: string;
  onboardingStateFile: string;
  tmsAdapterConfigFile: string;
  tmsProbeFile: string;
  testRfqReceiptFile: string;
};

export type SecretFileRef = {
  file: string;
};

export type OnboardingFileRef = {
  file: string;
};

export type OnboardingAnswers = {
  schema_version: 1;
  ai_provider?: {
    provider: "openrouter" | "gemini";
    api_key: SecretFileRef;
  };
  cloudflare?: {
    public_hostname: string;
    tunnel_token: SecretFileRef;
    access_client_id: SecretFileRef;
    access_client_secret: SecretFileRef;
  };
  activation?: {
    authorized_email: string;
  };
  tms?: {
    mode: "quoteops-tms-http-v1";
    base_url: string;
    api_key: SecretFileRef;
    sample_query: HistoricalSearchQuery;
  };
  mailbox?:
    | {
        provider: "resend";
        api_key: SecretFileRef;
        intake_address: string;
        from_address: string;
      }
    | {
        provider: "imap";
        user: string;
        password: SecretFileRef;
        host: string;
        port: number;
      };
  sakbe?: {
    api_key: SecretFileRef;
  };
  embeddings?:
    | {
        provider: "gemini";
        model: string;
        api_key: SecretFileRef;
      }
    | {
        provider: "openai_compatible";
        model: string;
        base_url: string;
        api_key: SecretFileRef;
      };
  knowledge?: {
    sources: OnboardingFileRef[];
    consent_external_embedding_transfer: true;
  };
  accept_generated_profiles?: true;
  accept_default_authorization?: true;
  accept_sample_prices?: true;
};

const secretFileRefSchema = z.object({ file: z.string().min(1) }).strict();
const onboardingFileRefSchema = z.object({ file: z.string().min(1) }).strict();
const optionalNullableText = z.string().min(1).nullable().optional();
const historicalSearchQuerySchema = z
  .object({
    request_id: z.string().min(1),
    origin: z
      .object({
        city: z.string().min(1),
        state: z.string().min(1),
        country: z.string().length(2)
      })
      .strict(),
    destination: z
      .object({
        city: z.string().min(1),
        state: z.string().min(1),
        country: z.string().length(2)
      })
      .strict(),
    vehicle_profile_id: optionalNullableText,
    equipment_request: optionalNullableText,
    customer_id: optionalNullableText,
    customer_type: optionalNullableText,
    cargo: z
      .object({
        commodity: optionalNullableText,
        commodity_category: optionalNullableText,
        sector: optionalNullableText,
        weight_kg: z.number().finite().nonnegative().nullable().optional(),
        hazmat: z.boolean().nullable().optional(),
        temperature_controlled: z.boolean().nullable().optional()
      })
      .strict()
      .optional(),
    service_type: optionalNullableText,
    time_window: z
      .object({
        from: z.string().datetime({ offset: true }),
        to: z.string().datetime({ offset: true })
      })
      .strict(),
    max_results: z.number().int().positive().optional()
  })
  .strict();

export const onboardingAnswersSchema: z.ZodType<OnboardingAnswers> = z
  .object({
    schema_version: z.literal(1),
    ai_provider: z
      .object({
        provider: z.enum(["openrouter", "gemini"]),
        api_key: secretFileRefSchema
      })
      .strict()
      .optional(),
    cloudflare: z
      .object({
        public_hostname: z.string().min(1),
        tunnel_token: secretFileRefSchema,
        access_client_id: secretFileRefSchema,
        access_client_secret: secretFileRefSchema
      })
      .strict()
      .optional(),
    activation: z
      .object({ authorized_email: z.string().email() })
      .strict()
      .optional(),
    tms: z
      .object({
        mode: z.literal("quoteops-tms-http-v1"),
        base_url: z.string().url(),
        api_key: secretFileRefSchema,
        sample_query: historicalSearchQuerySchema
      })
      .strict()
      .optional(),
    mailbox: z
      .discriminatedUnion("provider", [
        z
          .object({
            provider: z.literal("resend"),
            api_key: secretFileRefSchema,
            intake_address: z.string().email(),
            from_address: z.string().email()
          })
          .strict(),
        z
          .object({
            provider: z.literal("imap"),
            user: z.string().min(1),
            password: secretFileRefSchema,
            host: z.string().min(1),
            port: z.number().int().min(1).max(65535)
          })
          .strict()
      ])
      .optional(),
    sakbe: z.object({ api_key: secretFileRefSchema }).strict().optional(),
    embeddings: z
      .discriminatedUnion("provider", [
        z
          .object({
            provider: z.literal("gemini"),
            model: z.string().min(1),
            api_key: secretFileRefSchema
          })
          .strict(),
        z
          .object({
            provider: z.literal("openai_compatible"),
            model: z.string().min(1),
            base_url: z.string().url(),
            api_key: secretFileRefSchema
          })
          .strict()
      ])
      .optional(),
    knowledge: z
      .object({
        sources: z.array(onboardingFileRefSchema).min(1).max(20),
        consent_external_embedding_transfer: z.literal(true)
      })
      .strict()
      .optional(),
    accept_generated_profiles: z.literal(true).optional(),
    accept_default_authorization: z.literal(true).optional(),
    accept_sample_prices: z.literal(true).optional()
  })
  .strict();

export function parseOnboardingAnswers(value: unknown): OnboardingAnswers {
  const result = onboardingAnswersSchema.safeParse(value);
  if (!result.success) {
    throw new OnboardingError("onboarding_answers_invalid", { exitCode: 2 });
  }
  return result.data;
}

const MAX_ANSWERS_FILE_BYTES = 64 * 1024;

export async function readOnboardingAnswersFile(
  file: string
): Promise<OnboardingAnswers> {
  let handle;
  try {
    handle = await open(resolve(file), "r");
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size < 1 ||
      metadata.size > MAX_ANSWERS_FILE_BYTES
    ) {
      throw new OnboardingError("onboarding_answers_invalid", { exitCode: 2 });
    }
    const bytes = Buffer.alloc(MAX_ANSWERS_FILE_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset === 0 || offset > MAX_ANSWERS_FILE_BYTES) {
      throw new OnboardingError("onboarding_answers_invalid", { exitCode: 2 });
    }
    return parseOnboardingAnswers(JSON.parse(bytes.subarray(0, offset).toString("utf8")));
  } catch (error) {
    if (
      error instanceof OnboardingError &&
      error.code === "onboarding_answers_invalid"
    ) {
      throw error;
    }
    throw new OnboardingError("onboarding_answers_invalid", {
      exitCode: 2
    });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export type OnboardingContext = {
  io: OnboardingIo;
  env: NodeJS.ProcessEnv;
  paths: OnboardPaths;
  guided: boolean;
  answers: OnboardingAnswers | null;
  fetch: typeof fetch;
  stateStore: OnboardingStateStore;
  /** Root containing answer-file secret inputs. Required for unattended mode. */
  answersRoot?: string;
  /** Injectable to make DNS safety deterministic in tests. */
  resolveHostname?: (hostname: string) => Promise<string[]>;
  /** Production remains fixed at 10 seconds; tests may use a shorter deadline. */
  aiValidationTimeoutMs?: number;
  mailboxProbeTimeoutMs?: number;
  httpProbeTimeoutMs?: number;
  now?: () => Date;
  /**
   * Test-only durability seam. It runs after a committed rename and before the
   * next staged write, allowing crash recovery to be exercised deterministically.
   */
  afterAtomicRename?: (label: string) => void | Promise<void>;
  /** Test-only seam for verifying pathname replacement after O_NOFOLLOW open. */
  afterSecretOpen?: () => void | Promise<void>;
  probeImap?: (input: {
    host: string;
    port: number;
    user: string;
    password: string;
    timeoutMs: number;
  }) => Promise<void>;
  copilot?: Copilot;
};

export type OnboardingPhase = {
  id: OnboardingPhaseId;
  isComplete(context: OnboardingContext): Promise<boolean>;
  run(context: OnboardingContext): Promise<void>;
};

export type OnboardingPhaseSelection =
  | { mode: "all" }
  | { mode: "through"; phase: OnboardingPhaseId }
  | { mode: "only"; phase: OnboardingPhaseId };

export type RunOnboardingInput = {
  phases: OnboardingPhase[];
  context: OnboardingContext;
  selection: OnboardingPhaseSelection;
};

export type OnboardingAuditState = {
  schema_version: 1;
  observed_complete: Array<{
    phase: OnboardingPhaseId;
    observed_at: string;
  }>;
};

export type OnboardingStateStore = {
  load(): Promise<OnboardingAuditState>;
  save(state: OnboardingAuditState): Promise<void>;
};

export type OnboardingResult = {
  selected_phases: OnboardingPhaseId[];
  completed_phases: OnboardingPhaseId[];
  pending_phases: OnboardingPhaseId[];
  public_url: string | null;
};

export class OnboardingError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly phase?: OnboardingPhaseId;

  constructor(
    code: string,
    options: {
      exitCode?: number;
      phase?: OnboardingPhaseId;
      cause?: unknown;
    } = {}
  ) {
    super(code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OnboardingError";
    this.code = code;
    this.exitCode = options.exitCode ?? 1;
    this.phase = options.phase;
  }
}

export async function runOnboarding(
  input: RunOnboardingInput
): Promise<OnboardingResult> {
  assertPhaseList(input.phases);
  const selected = selectPhases(input.phases, input.selection);
  const audit = await input.context.stateStore.load();
  const completed: OnboardingPhaseId[] = [];

  if (input.selection.mode === "only") {
    const targetPhase = input.selection.phase;
    const targetIndex = input.phases.findIndex(
      (candidate) => candidate.id === targetPhase
    );
    for (const prerequisite of input.phases.slice(0, targetIndex)) {
      if (!(await prerequisite.isComplete(input.context))) {
        throw new OnboardingError("onboarding_prerequisite_incomplete", {
          phase: prerequisite.id
        });
      }
    }
  }

  for (const current of selected) {
    const alreadyComplete = await current.isComplete(input.context);
    if (!alreadyComplete) {
      await assertUnattendedPhaseAnswers(current.id, input.context);
      await current.run(input.context);
    }
    completed.push(current.id);
    observeCompletion(audit, current.id, input.context.now?.() ?? new Date());
    await input.context.stateStore.save(audit);
  }

  return {
    selected_phases: selected.map((phase) => phase.id),
    completed_phases: completed,
    pending_phases: selected
      .map((phase) => phase.id)
      .filter((phase) => !completed.includes(phase)),
    public_url: await readPublicUrl(input.context.paths.settingsDir)
  };
}

async function assertUnattendedPhaseAnswers(
  phase: OnboardingPhaseId,
  context: OnboardingContext
): Promise<void> {
  if (context.guided) return;
  const answers = context.answers;
  const mailboxEnabled =
    phase === "appliance_secrets"
      ? await isMailboxEnabled(context)
      : false;
  const complete =
    phase === "ai_provider"
      ? Boolean(answers?.ai_provider)
      : phase === "license_activation"
        ? Boolean(answers?.activation)
        : phase === "cloudflare"
          ? Boolean(answers?.cloudflare)
          : phase === "appliance_secrets"
            ? Boolean(
                answers?.embeddings &&
                  (!mailboxEnabled || answers.mailbox)
              )
            : phase === "tms"
              ? Boolean(answers?.tms)
              : phase === "units"
                ? answers?.accept_generated_profiles === true
                : phase === "authorization"
                  ? answers?.accept_default_authorization === true
                  : phase === "pricing"
                    ? answers?.accept_sample_prices === true
                    : phase === "knowledge"
                      ? Boolean(answers?.knowledge)
                      : true;
  if (!complete) {
    throw new OnboardingError("onboarding_pending", { phase });
  }
}

export async function isMailboxEnabled(
  context: Pick<OnboardingContext, "paths">
): Promise<boolean> {
  let body: string;
  try {
    body = await readFile(context.paths.agentConfigFile, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
  if (!body.trim()) return false;
  try {
    const parsed = parseYaml(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return true;
    }
    const config = parsed as Record<string, unknown>;
    return (
      Object.prototype.hasOwnProperty.call(config, "mailbox") &&
      config.mailbox !== null &&
      config.mailbox !== undefined
    );
  } catch {
    // Malformed configuration is treated conservatively as enabled so an
    // omitted answer can never erase an existing mailbox declaration.
    return true;
  }
}

export function parseOnboardingSelection(
  argv: string[]
): OnboardingPhaseSelection {
  if (
    argv.includes("--answers-file") &&
    (argv.includes("--allow-static-guidance") ||
      argv.includes("--sync-units") ||
      argv.includes("--map-tms"))
  ) {
    throw new OnboardingError("onboarding_selection_conflict", {
      exitCode: 2
    });
  }
  let through: OnboardingPhaseId | undefined;
  let only: OnboardingPhaseId | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--until" && argument !== "--only") continue;
    const rawPhase = argv[index + 1];
    if (!rawPhase || rawPhase.startsWith("--") || !isPhaseId(rawPhase)) {
      throw new OnboardingError("onboarding_phase_invalid", { exitCode: 2 });
    }
    if (argument === "--until") {
      if (through || only) {
        throw new OnboardingError("onboarding_selection_conflict", {
          exitCode: 2
        });
      }
      through = rawPhase;
    } else {
      if (only || through) {
        throw new OnboardingError("onboarding_selection_conflict", {
          exitCode: 2
        });
      }
      only = rawPhase;
    }
    index += 1;
  }
  if (through) return { mode: "through", phase: through };
  if (only) return { mode: "only", phase: only };
  return { mode: "all" };
}

export function createFileOnboardingStateStore(
  file: string
): OnboardingStateStore {
  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
        return parseAuditState(parsed);
      } catch {
        return emptyAuditState();
      }
    },
    async save(state) {
      await atomicWriteFile(
        file,
        `${JSON.stringify(parseAuditState(state), null, 2)}\n`,
        0o600
      );
    }
  };
}

function selectPhases(
  phases: OnboardingPhase[],
  selection: OnboardingPhaseSelection
): OnboardingPhase[] {
  if (selection.mode === "all") return phases;
  const index = phases.findIndex((phase) => phase.id === selection.phase);
  if (index < 0) {
    throw new OnboardingError("onboarding_phase_invalid", { exitCode: 2 });
  }
  return selection.mode === "through" ? phases.slice(0, index + 1) : [phases[index]!];
}

function assertPhaseList(phases: OnboardingPhase[]): void {
  if (phases.length > 0 && phases[0]?.id !== "ai_provider") {
    throw new OnboardingError("onboarding_ai_provider_must_be_first", {
      exitCode: 2
    });
  }
  const seen = new Set<OnboardingPhaseId>();
  for (const phase of phases) {
    if (!isPhaseId(phase.id) || seen.has(phase.id)) {
      throw new OnboardingError("onboarding_phase_invalid", { exitCode: 2 });
    }
    seen.add(phase.id);
  }
}

function observeCompletion(
  state: OnboardingAuditState,
  phase: OnboardingPhaseId,
  observedAt: Date
): void {
  state.observed_complete = state.observed_complete.filter(
    (entry) => entry.phase !== phase
  );
  state.observed_complete.push({
    phase,
    observed_at: observedAt.toISOString()
  });
}

function parseAuditState(value: unknown): OnboardingAuditState {
  if (!value || typeof value !== "object") return emptyAuditState();
  const candidate = value as {
    schema_version?: unknown;
    observed_complete?: unknown;
  };
  if (
    candidate.schema_version !== 1 ||
    !Array.isArray(candidate.observed_complete)
  ) {
    return emptyAuditState();
  }
  return {
    schema_version: 1,
    observed_complete: candidate.observed_complete.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const phase = (entry as { phase?: unknown }).phase;
      const observedAt = (entry as { observed_at?: unknown }).observed_at;
      return isPhaseId(phase) &&
        typeof observedAt === "string" &&
        !Number.isNaN(Date.parse(observedAt))
        ? [{ phase, observed_at: observedAt }]
        : [];
    })
  };
}

function emptyAuditState(): OnboardingAuditState {
  return { schema_version: 1, observed_complete: [] };
}

function isPhaseId(value: unknown): value is OnboardingPhaseId {
  return (
    typeof value === "string" &&
    (ONBOARDING_PHASE_IDS as readonly string[]).includes(value)
  );
}

async function readPublicUrl(settingsDir: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(
      await readFile(join(settingsDir, "cloudflare.json"), "utf8")
    ) as { public_hostname?: unknown };
    return typeof parsed.public_hostname === "string"
      ? `https://${parsed.public_hostname}`
      : null;
  } catch {
    return null;
  }
}

async function atomicWriteFile(
  file: string,
  contents: string,
  mode: number
): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const target = resolve(file);
  const temporary = `${target}.tmp-${process.pid}-${Math.random()
    .toString(16)
    .slice(2)}`;
  await writeFile(temporary, contents, { encoding: "utf8", mode });
  await chmod(temporary, mode);
  await rename(temporary, target);
  await chmod(target, mode);
  const metadata = await stat(target);
  if (!metadata.isFile()) {
    throw new OnboardingError("onboarding_state_write_failed");
  }
}
