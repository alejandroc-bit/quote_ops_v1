import { chmod, readFile, writeFile } from "node:fs/promises";
import { stringify as stringifyYaml } from "yaml";
import type { QuoteManifest, QuoteVehicleProfile } from "@quoteops/quote-core";
import type { TmsCanonicalPerformance } from "@quoteops/contracts";

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
  if (value.includes("\n")) throw new Error("secret values cannot contain newlines");
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
  const current = await readFile(file, "utf8").catch(() => "");
  await writeFile(file, upsertEnvLine(current, key, value), "utf8");
  await chmod(file, 0o600);
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
        ? { ...existing, performance_source: "tms", tms_real_cost_per_km: stub.tms_real_cost_per_km }
        : stub
    );
  }
  return { ...manifest, vehicle_profiles: [...byId.values()] };
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
