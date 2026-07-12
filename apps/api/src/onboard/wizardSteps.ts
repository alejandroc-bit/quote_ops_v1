import {
  calculateQuote,
  type ProfitabilityRbBracket,
  type QuoteManifest,
  type QuoteVehicleProfile,
  type RouteEvidence
} from "@quoteops/quote-core";

// Pure logic for the onboarding wizard's new steps (pricing params,
// authorization tenant, sample-quote validation). No TTY, no fs — the CLI
// wires prompts to these so the risky parts stay unit-testable.

// ---------------------------------------------------------------- pricing

export function validateMarginParams(target: number, minimum: number): string[] {
  const errors: string[] = [];
  const valid = (value: number) => Number.isFinite(value) && value >= 0 && value < 1;
  if (!valid(target)) errors.push("margin_target_pct debe estar entre 0 y 1 (ej. 0.25)");
  if (!valid(minimum)) errors.push("minimum_margin_pct debe estar entre 0 y 1 (ej. 0.18)");
  if (errors.length === 0 && minimum > target) {
    errors.push("minimum_margin_pct no puede ser mayor que margin_target_pct");
  }
  return errors;
}

/**
 * Parse a custom RB table typed as "100:0.6, 500:0.6, 1000:0.57, *:0.5".
 * `*` (or "null") is the open-ended bracket and must come last. Returns null
 * for empty input (caller keeps quote-core's defaults). Throws on bad input.
 */
export function parseRbTable(text: string): ProfitabilityRbBracket[] | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const brackets: ProfitabilityRbBracket[] = trimmed.split(",").map((chunk) => {
    const [kmRaw, rbRaw] = chunk.split(":").map((part) => part?.trim());
    if (!kmRaw || !rbRaw) throw new Error(`bracket inválido: "${chunk.trim()}" (usa max_km:rb, ej. 500:0.6)`);
    const maxKm = kmRaw === "*" || kmRaw.toLowerCase() === "null" ? null : Number(kmRaw);
    const rbPct = Number(rbRaw);
    if (maxKm !== null && (!Number.isFinite(maxKm) || maxKm <= 0)) {
      throw new Error(`max_km inválido: "${kmRaw}"`);
    }
    if (!Number.isFinite(rbPct) || rbPct < 0 || rbPct >= 1) {
      throw new Error(`rb_pct inválido: "${rbRaw}" (debe estar entre 0 y 1)`);
    }
    return { max_km: maxKm, rb_pct: rbPct };
  });
  for (let i = 1; i < brackets.length; i += 1) {
    const prev = brackets[i - 1]!.max_km;
    const curr = brackets[i]!.max_km;
    if (prev === null) throw new Error("el bracket abierto (*) debe ser el último");
    if (curr !== null && curr <= prev) throw new Error("los max_km deben ir en orden ascendente");
  }
  if (brackets[brackets.length - 1]!.max_km !== null) {
    throw new Error("falta el bracket abierto final (*:rb) para rutas largas");
  }
  return brackets;
}

// ----------------------------------------------------------- authorization

export type ManifestAuthorization = {
  /** Tenant approver with max decision power. */
  approver_email: string;
  /** Anyone at these domains can request quotes / be CC'd. */
  allowed_domains: string[];
  /** WhatsApp number of the approver (E.164-ish, e.g. +5281xxxxxxxx). */
  whatsapp_approver_phone: string;
};

export type OnboardManifest = QuoteManifest & { authorization?: ManifestAuthorization };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const PHONE_RE = /^\+?[0-9]{10,15}$/;

export function validateAuthorization(input: {
  approver_email: string;
  allowed_domains: string[];
  whatsapp_approver_phone: string;
}): string[] {
  const errors: string[] = [];
  if (!EMAIL_RE.test(input.approver_email.trim())) {
    errors.push(`correo de aprobador inválido: "${input.approver_email}"`);
  }
  if (input.allowed_domains.length === 0) {
    errors.push("captura al menos un dominio permitido (ej. empresa.com)");
  }
  for (const domain of input.allowed_domains) {
    if (!DOMAIN_RE.test(domain.trim().toLowerCase())) {
      errors.push(`dominio inválido: "${domain}"`);
    }
  }
  const phone = input.whatsapp_approver_phone.replace(/[\s()-]/g, "");
  if (phone && !PHONE_RE.test(phone)) {
    errors.push(`teléfono WhatsApp inválido: "${input.whatsapp_approver_phone}"`);
  }
  return errors;
}

export function parseDomainList(raw: string): string[] {
  return raw
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Persist the authorization tenant into the client manifest: a top-level
 * `authorization` block plus mirroring allowed_domains into the default
 * business unit's requester_email_domains (the existing intake policy field).
 */
export function applyAuthorization(
  manifest: OnboardManifest,
  auth: ManifestAuthorization
): OnboardManifest {
  const normalized: ManifestAuthorization = {
    approver_email: auth.approver_email.trim().toLowerCase(),
    allowed_domains: auth.allowed_domains.map((domain) => domain.trim().toLowerCase()),
    whatsapp_approver_phone: auth.whatsapp_approver_phone.replace(/[\s()-]/g, "")
  };
  const businessUnits = manifest.business_units.map((unit) =>
    unit.default
      ? {
          ...unit,
          requester_email_domains: [
            ...new Set([...(unit.requester_email_domains ?? []), ...normalized.allowed_domains])
          ]
        }
      : unit
  );
  return { ...manifest, business_units: businessUnits, authorization: normalized };
}

// -------------------------------------------------------- sample validation

export type SampleQuoteRow = {
  origin: string;
  destination: string;
  unit: string;
  pricing_model: string;
  rate_mxn: number;
};

const SAMPLE_LANES = [
  { origin: "Monterrey, Nuevo Leon", destination: "Saltillo, Coahuila", km: 90, minutes: 75, tolls: 180 },
  { origin: "Monterrey, Nuevo Leon", destination: "Ciudad de Mexico, CDMX", km: 920, minutes: 660, tolls: 2350 },
  { origin: "Guadalajara, Jalisco", destination: "Tijuana, Baja California", km: 2250, minutes: 1560, tolls: 3900 }
] as const;

function mockRoute(lane: (typeof SAMPLE_LANES)[number]): RouteEvidence {
  return {
    status: "resolved",
    source: "mock",
    km_loaded: lane.km,
    estimated_minutes: lane.minutes,
    tolls_mxn: lane.tolls,
    requires_return_route: false
  };
}

function splitCityState(place: string): { city: string; state: string } {
  const [city = "", state = ""] = place.split(",").map((part) => part.trim());
  return { city, state };
}

/**
 * Run 3 fixed sample lanes through the deterministic quote-core with the
 * configured manifest + mock route evidence. quote-core is the ONLY rate
 * source — this just formats what it returns for the operator to eyeball.
 */
export function buildSampleQuoteRows(
  manifest: QuoteManifest,
  profile?: QuoteVehicleProfile
): SampleQuoteRow[] {
  const target = profile ?? manifest.vehicle_profiles[0];
  if (!target) throw new Error("el manifest no tiene vehicle_profiles");
  return SAMPLE_LANES.map((lane, index) => {
    const result = calculateQuote({
      rfq: {
        rfq_id: `onboard-sample-${index + 1}`,
        lane_id: `onboard-sample-${index + 1}`,
        client_id: manifest.client_id,
        business_unit_id: target.business_unit_id,
        origin: { ...splitCityState(lane.origin), country: "MX" },
        destination: { ...splitCityState(lane.destination), country: "MX" },
        vehicle_profile_id: target.vehicle_profile_id,
        cargo: { weight_kg: 12000 },
        service: { return_policy: "one_way", route_policy: "standard" },
        commercial: {}
      },
      manifest,
      route_evidence: mockRoute(lane)
    });
    return {
      origin: lane.origin,
      destination: lane.destination,
      unit: target.vehicle_profile_id,
      pricing_model: result.pricing_model,
      rate_mxn: result.base_rate_mxn
    };
  });
}

export function renderQuoteTable(rows: SampleQuoteRow[]): string {
  const header = ["Origen → Destino", "Unidad", "Modelo", "Tarifa MXN"];
  const cells = rows.map((row) => [
    `${row.origin} → ${row.destination}`,
    row.unit,
    row.pricing_model,
    row.rate_mxn.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...cells.map((row) => row[column]!.length))
  );
  const line = (row: string[]) =>
    row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ");
  return [line(header), widths.map((width) => "-".repeat(width)).join("  "), ...cells.map(line)].join(
    "\n"
  );
}
