import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  writeFile
} from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep
} from "node:path";
import { TextDecoder } from "node:util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type {
  ProfitabilityRbBracket,
  QuoteManifest,
  QuoteVehicleProfile
} from "@quoteops/quote-core";
import type { TmsCanonicalPerformance } from "@quoteops/contracts";
import type { ManifestAuthorization } from "./wizardSteps.js";
import {
  OnboardingError,
  type OnboardingContext,
  type SecretFileRef
} from "./onboardingFlow.js";

// Pure config builders for the onboarding CLI. Kept side-effect free (except the
// thin file wrappers) so the risky logic — secret escaping, TMS yaml, profile
// stubs — is unit-tested without a TTY or a running appliance.

/**
 * Upsert one KEY="value" line into a dotenv-style file body. Mirrors the
 * escaping in deploy/appliance/secrets.sh so the appliance's env_file parser
 * reads the value back verbatim. Rejects newlines (env_file has no escape).
 */
export function upsertEnvLine(contents: string, key: string, value: string): string {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`invalid secret key: ${key}`);
  if (/[\r\n]/.test(value)) throw new Error("secret values cannot contain newlines");
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`");
  const line = `${key}="${escaped}"`;
  const kept = contents
    .split("\n")
    .filter((existing) => existing.trim() !== "" && !existing.startsWith(`${key}=`));
  return [...kept, line].join("\n") + "\n";
}

export async function writeSecret(file: string, key: string, value: string): Promise<void> {
  await updateAllowedEnv(file, { [key]: value }, [key]);
}

const MAX_SECRET_BYTES = 16 * 1024;
const SECRET_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/**
 * Load a credential without ever copying it back into the parsed answer object.
 * File inputs are deliberately stricter than normal config files: a regular,
 * non-symlink 0600 file, owned by root or the invoking uid, under answersRoot.
 */
export async function readSingleLineSecret(
  input: string | SecretFileRef,
  context?: Pick<OnboardingContext, "answersRoot" | "afterSecretOpen">
): Promise<string> {
  if (typeof input === "string") return validateSingleLineSecret(input);
  const requested = resolve(input.file);
  let canonicalRoot: string | undefined;
  let canonicalParentBefore: string | undefined;
  if (context?.answersRoot) {
    try {
      [canonicalRoot, canonicalParentBefore] = await Promise.all([
        realpath(resolve(context.answersRoot)),
        realpath(dirname(requested))
      ]);
    } catch {
      throw new OnboardingError("secret_file_unsafe");
    }
    if (!isPathInside(canonicalRoot, canonicalParentBefore)) {
      throw new OnboardingError("secret_file_unsafe");
    }
  }

  let handle;
  try {
    handle = await open(
      requested,
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
  } catch {
    throw new OnboardingError("secret_file_unsafe");
  }
  try {
    await context?.afterSecretOpen?.();
    const metadata = await handle.stat();
    const invokingUid =
      typeof process.getuid === "function" ? process.getuid() : metadata.uid;
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o777) !== 0o600 ||
      (metadata.uid !== 0 && metadata.uid !== invokingUid)
    ) {
      throw new OnboardingError("secret_file_unsafe");
    }
    if (metadata.size > MAX_SECRET_BYTES) {
      throw new OnboardingError("secret_invalid");
    }

    let pathMetadata;
    let canonicalRequested: string;
    let canonicalParentAfter: string;
    try {
      [pathMetadata, canonicalRequested, canonicalParentAfter] =
        await Promise.all([
          lstat(requested),
          realpath(requested),
          realpath(dirname(requested))
        ]);
    } catch {
      throw new OnboardingError("secret_file_unsafe");
    }
    if (
      pathMetadata.isSymbolicLink() ||
      !pathMetadata.isFile() ||
      pathMetadata.dev !== metadata.dev ||
      pathMetadata.ino !== metadata.ino ||
      canonicalRequested !== resolve(canonicalParentAfter, basename(requested)) ||
      (canonicalParentBefore !== undefined &&
        canonicalParentAfter !== canonicalParentBefore) ||
      (canonicalRoot !== undefined &&
        (!isPathInside(canonicalRoot, canonicalParentAfter) ||
          !isPathInside(canonicalRoot, canonicalRequested)))
    ) {
      throw new OnboardingError("secret_file_unsafe");
    }

    const bytes = Buffer.alloc(MAX_SECRET_BYTES + 1);
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
    if (offset > MAX_SECRET_BYTES) {
      throw new OnboardingError("secret_invalid");
    }
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, offset)
      );
    } catch {
      throw new OnboardingError("secret_invalid");
    }
    return validateSingleLineSecret(decoded);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return !(
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  );
}

export function validateSingleLineSecret(value: string): string {
  if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
    throw new OnboardingError("secret_invalid");
  }
  const normalized = value.endsWith("\n") ? value.slice(0, -1) : value;
  if (
    normalized.length === 0 ||
    normalized.includes("\n") ||
    normalized.includes("\r") ||
    SECRET_CONTROL_CHARACTERS.test(normalized) ||
    normalized.trim() !== normalized
  ) {
    throw new OnboardingError("secret_invalid");
  }
  return normalized;
}

/**
 * Atomically merge a bounded set of env keys. All values are validated before
 * the original file is read, so a rejected value cannot cause a partial write.
 * null removes a key, which is used to guarantee exact active-provider keys.
 */
export async function updateAllowedEnv(
  file: string,
  updates: Record<string, string | null | undefined>,
  allowlist: readonly string[],
  afterRename?: () => void | Promise<void>
): Promise<void> {
  const allowed = new Set(allowlist);
  const validated = new Map<string, string | null>();
  for (const [key, value] of Object.entries(updates)) {
    if (!allowed.has(key) || !/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      throw new OnboardingError("secret_env_key_invalid");
    }
    validated.set(
      key,
      value === null || value === undefined
        ? null
        : validateSingleLineSecret(value)
    );
  }

  const current = await readFile(file, "utf8").catch(() => "");
  const retained = current.split(/\r?\n/).filter((line) => {
    const match =
      /^\s*export\s+([A-Z_][A-Z0-9_]*)=/.exec(line) ??
      /^\s*([A-Z_][A-Z0-9_]*)=/.exec(line);
    return !match?.[1] || !validated.has(match[1]);
  });
  while (retained.at(-1) === "") retained.pop();
  for (const [key, value] of validated) {
    if (value !== null) retained.push(serializeEnvLine(key, value));
  }
  await atomicWriteText(file, `${retained.join("\n")}${retained.length ? "\n" : ""}`, {
    mode: 0o600,
    afterRename
  });
}

export async function readEnvFileValues(
  file: string
): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  const contents = await readFile(file, "utf8").catch(() => "");
  for (const line of contents.split(/\r?\n/)) {
    const match =
      /^\s*export\s+([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line) ??
      /^\s*([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match?.[1]) continue;
    values.set(match[1], parseEnvValue(match[2] ?? ""));
  }
  return values;
}

export async function atomicWriteJson(
  file: string,
  value: unknown,
  options: {
    mode?: number;
    afterRename?: () => void | Promise<void>;
  } = {}
): Promise<void> {
  await atomicWriteText(file, `${JSON.stringify(value, null, 2)}\n`, options);
}

export async function atomicWriteText(
  file: string,
  contents: string,
  options: {
    mode?: number;
    afterRename?: () => void | Promise<void>;
  } = {}
): Promise<void> {
  const mode = options.mode ?? 0o600;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${Math.random()
    .toString(16)
    .slice(2)}`;
  await writeFile(temporary, contents, { encoding: "utf8", mode });
  await chmod(temporary, mode);
  await rename(temporary, file);
  await chmod(file, mode);
  if (!(await stat(file)).isFile()) {
    throw new OnboardingError("atomic_write_failed");
  }
  await options.afterRename?.();
}

export async function sha256File(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

function serializeEnvLine(key: string, value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`");
  return `${key}="${escaped}"`;
}

function parseEnvValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\\\/g, "\u0000")
      .replace(/\\"/g, '"')
      .replace(/\\\$/g, "$")
      .replace(/\\`/g, "`")
      .replace(/\u0000/g, "\\");
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Preserve the tool policy while persisting the onboarding approver identity. */
export function applyAuthorizationToAgentConfig(
  contents: string,
  authorization: ManifestAuthorization
): string {
  const parsed = parseYaml(contents) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("agent-config debe ser un objeto YAML");
  }
  const current =
    parsed.authorization && typeof parsed.authorization === "object"
      ? (parsed.authorization as Record<string, unknown>)
      : {};
  return stringifyYaml({
    ...parsed,
    authorization: {
      ...current,
      approver_email: authorization.approver_email,
      allowed_domains: authorization.allowed_domains,
      whatsapp_approver_phone: authorization.whatsapp_approver_phone
    }
  });
}

export type TmsAdapterYamlInput =
  | { provider: "file_import" }
  | {
      provider: "http";
      base_url_env: string;
      endpoints?: Record<string, string>;
    }
  | {
      provider: "sql";
      dialect: "postgres" | "mysql" | "mssql";
      connection_url_env: string;
      queries: Record<string, string>;
      write_quote?: string;
    };

const FILE_IMPORT_DEFAULTS = {
  provider: "file_import",
  rfqs_path_env: "QUOTEOPS_TMS_RFQS_PATH",
  historical_quotes_path_env: "QUOTEOPS_TMS_HISTORICAL_QUOTES_PATH",
  historical_shipments_path_env: "QUOTEOPS_TMS_HISTORICAL_SHIPMENTS_PATH",
  customers_path_env: "QUOTEOPS_TMS_CUSTOMERS_PATH",
  agreements_path_env: "QUOTEOPS_TMS_AGREEMENTS_PATH",
  unit_positions_path_env: "QUOTEOPS_TMS_UNIT_POSITIONS_PATH",
  units_path_env: "QUOTEOPS_TMS_UNITS_PATH",
  performance_path_env: "QUOTEOPS_TMS_PERFORMANCE_PATH",
  availability_zones_path_env: "QUOTEOPS_TMS_AVAILABILITY_ZONES_PATH",
  quote_writebacks_path_env: "QUOTEOPS_TMS_QUOTE_WRITEBACKS_PATH",
  status_writebacks_path_env: "QUOTEOPS_TMS_STATUS_WRITEBACKS_PATH"
};

/** Build a tms-adapter.yaml body for the chosen provider (validated on first load). */
export function buildTmsAdapterYaml(input: TmsAdapterYamlInput): string {
  if (input.provider === "file_import") {
    return stringifyYaml(FILE_IMPORT_DEFAULTS);
  }
  if (input.provider === "http") {
    return stringifyYaml({
      provider: "http",
      base_url_env: input.base_url_env,
      ...(input.endpoints ?? {})
    });
  }
  return stringifyYaml({
    provider: "sql",
    dialect: input.dialect,
    connection_url_env: input.connection_url_env,
    queries: input.queries,
    ...(input.write_quote ? { write_quote: { statement: input.write_quote } } : {})
  });
}

export type ProfileCommercialLayer = {
  business_unit_id: string;
  pricing_model: "formula" | "profitability";
  margin_target_pct: number;
  minimum_margin_pct: number;
  keywords?: string[];
  /** Custom RB brackets for the profitability model; omitted = quote-core defaults. */
  profitability_rb_table?: ProfitabilityRbBracket[];
};

/**
 * Build a vehicle-profile stub for a TMS unit type. The unit_type IS the
 * profile id (and a keyword) so the F3 overlay matches performance rows to it.
 * Physical/fuel numbers are placeholders the overlay overwrites from the TMS.
 */
export function buildProfileStub(
  performance: TmsCanonicalPerformance,
  commercial: ProfileCommercialLayer
): QuoteVehicleProfile {
  const keywords = [...new Set([performance.unit_type, ...(commercial.keywords ?? [])])];
  return {
    vehicle_profile_id: performance.unit_type,
    business_unit_id: commercial.business_unit_id,
    keywords,
    payload_capacity_kg: 0,
    fuel_loaded_km_per_l: performance.kpl_yield,
    fuel_empty_km_per_l: performance.kpl_yield,
    operator_cost_per_km_mxn: performance.real_cost_per_km,
    pricing_model: commercial.pricing_model,
    diesel_price_mxn_per_liter: 0,
    margin_target_pct: commercial.margin_target_pct,
    minimum_margin_pct: commercial.minimum_margin_pct,
    ...(commercial.profitability_rb_table
      ? { profitability_rb_table: commercial.profitability_rb_table }
      : {}),
    performance_source: "tms",
    tms_real_cost_per_km: performance.real_cost_per_km
  };
}

/** Merge stubs into the manifest by vehicle_profile_id (existing profiles win their commercial layer). */
export function mergeProfileStubs(
  manifest: QuoteManifest,
  stubs: QuoteVehicleProfile[]
): QuoteManifest {
  const byId = new Map(manifest.vehicle_profiles.map((profile) => [profile.vehicle_profile_id, profile]));
  for (const stub of stubs) {
    const existing = byId.get(stub.vehicle_profile_id);
    // keep the human-tuned commercial layer if the profile already exists; only
    // refresh the TMS-sourced fields so re-running sync never clobbers pricing
    byId.set(
      stub.vehicle_profile_id,
      existing
        ? {
            ...existing,
            fuel_loaded_km_per_l: stub.fuel_loaded_km_per_l,
            fuel_empty_km_per_l: stub.fuel_empty_km_per_l,
            operator_cost_per_km_mxn: stub.operator_cost_per_km_mxn,
            performance_source: "tms",
            tms_real_cost_per_km: stub.tms_real_cost_per_km
          }
        : stub
    );
  }
  return { ...manifest, vehicle_profiles: [...byId.values()] };
}

/** Apply a pricing choice captured in the same run after refreshing TMS fields. */
export function mergeConfiguredProfileStubs(
  manifest: QuoteManifest,
  configurations: Array<{ stub: QuoteVehicleProfile; commercial: ProfileCommercialLayer }>
): QuoteManifest {
  const merged = mergeProfileStubs(
    manifest,
    configurations.map(({ stub }) => stub)
  );
  const commercialById = new Map(
    configurations.map(({ stub, commercial }) => [stub.vehicle_profile_id, commercial])
  );
  return {
    ...merged,
    vehicle_profiles: merged.vehicle_profiles.map((profile) => {
      const commercial = commercialById.get(profile.vehicle_profile_id);
      if (!commercial) return profile;
      return {
        ...profile,
        business_unit_id: commercial.business_unit_id,
        pricing_model: commercial.pricing_model,
        margin_target_pct: commercial.margin_target_pct,
        minimum_margin_pct: commercial.minimum_margin_pct,
        keywords: [...new Set([...(profile.keywords ?? []), ...(commercial.keywords ?? [])])],
        profitability_rb_table:
          commercial.pricing_model === "profitability"
            ? commercial.profitability_rb_table
            : undefined
      };
    })
  };
}

export type Copilot = {
  explain(fallback: string, stepContext: string): Promise<string>;
};

export type CopilotOptions = {
  provider: "openrouter" | "gemini";
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetch?: typeof fetch;
};

/**
 * Best-effort onboarding guide backed by the client's own AI key. It only ever
 * receives step descriptions — never secret values — and falls back to the
 * static text on any error so onboarding never blocks on the model.
 */
export function createCopilot(options: CopilotOptions): Copilot {
  const fetchFn = options.fetch ?? fetch;
  const system =
    "Eres el copiloto de onboarding de INDUCTA QUOTE SYSTEM. Explica el paso en 2-3 frases claras en español. No pidas ni menciones claves ni secretos.";
  return {
    async explain(fallback, stepContext) {
      try {
        const text = await callChat(options, fetchFn, system, stepContext);
        return text?.trim() || fallback;
      } catch {
        return fallback;
      }
    }
  };
}

async function callChat(
  options: CopilotOptions,
  fetchFn: typeof fetch,
  system: string,
  user: string
): Promise<string | null> {
  if (options.provider === "gemini") {
    const base = options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    const response = await fetchFn(
      `${base}/models/${options.model}:generateContent?key=${options.apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }]
        })
      }
    );
    if (!response.ok) return null;
    const body = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return body.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  }
  const base = options.baseUrl ?? "https://openrouter.ai/api/v1";
  const response = await fetchFn(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.apiKey}`
    },
    body: JSON.stringify({
      model: options.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    })
  });
  if (!response.ok) return null;
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return body.choices?.[0]?.message?.content ?? null;
}
