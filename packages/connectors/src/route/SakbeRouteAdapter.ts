import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { QuoteLocation, QuoteRfqLaneInput, RouteEvidence } from "@quoteops/quote-core";

const DEFAULT_BASE_URL = "https://gaia.inegi.org.mx/sakbe_v3.1";
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_SEARCH_TIMEOUT_MS = 45_000;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 450;
const DEFAULT_TIME_ZONE = "America/Monterrey";

const NOM_AXLES: Record<string, number> = {
  C2: 2,
  C3: 3,
  C2R2: 4,
  C3R2: 5,
  C2R3: 5,
  C3R3: 6,
  T2S1: 3,
  T2S2: 4,
  T2S3: 5,
  T3S1: 4,
  T3S2: 5,
  T3S3: 6,
  T2S1R2: 5,
  T2S2R2: 6,
  T2S1R3: 6,
  T3S1R2: 6,
  T3S1R3: 7,
  T3S2R2: 7,
  T3S2R3: 8,
  T3S2R4: 9,
  T2S2S2: 6,
  T3S2S2: 7,
  T3S3S2: 8
};

const UNIT_CODE_TO_NOM: Record<string, string> = {
  T3S3_53_DRYVAN: "T3S3",
  T3S2R4_DOUBLE_40_DRYVAN: "T3S2R4",
  T3S2_53_DRYVAN: "T3S2",
  T3S2_53_FLATBED: "T3S2",
  T3S2_53_FLATBED_PATONA: "T3S2",
  T3S2R2_DOUBLE_40_DRYVAN: "T3S2R2",
  T3S2R2_DOUBLE_40_FLATBED: "T3S2R2"
};

const STATE_ABBR: Record<string, string> = {
  "nuevo leon": "N.L.",
  coahuila: "Coah.",
  "coahuila de zaragoza": "Coah.",
  colima: "Col.",
  jalisco: "Jal.",
  queretaro: "Qro.",
  "san luis potosi": "S.L.P.",
  tamaulipas: "Tamps.",
  guanajuato: "Gto.",
  veracruz: "Ver.",
  puebla: "Pue.",
  "ciudad de mexico": "CDMX",
  cdmx: "CDMX",
  mexico: "Mex."
};

type CacheFile = Record<string, SakbeRouteCacheRow>;

export type SakbeRouteCacheRow = {
  cache_key: string;
  week_starts_at?: string | null;
  expires_at?: string | null;
  origin_raw?: string | null;
  destination_raw?: string | null;
  origin_city?: string | null;
  origin_state?: string | null;
  destination_city?: string | null;
  destination_state?: string | null;
  route_policy?: string | null;
  vehicle_profile_id?: string | null;
  nom_configuration?: string | null;
  sakbe_vehicle_code?: number | null;
  km_loaded: number;
  estimated_minutes: number;
  tolls_mxn: number;
  toll_detail?: unknown[];
  route_segments?: unknown[];
  normalized_payload?: unknown;
  raw_payload?: unknown;
  source?: string | null;
  source_timestamp?: string | null;
  confidence?: number | null;
  warnings?: unknown[];
  is_active?: boolean;
};

export type SakbeRouteAdapterConfig = {
  cachePath?: string;
  cacheMode?: "cache_first" | "live_only";
  apiKey?: string;
  apiKeyLoader?: () => Promise<string | null>;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  searchTimeoutMs?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
  liveEnabled?: boolean;
  now?: () => Date;
};

export type SakbeVehicle = {
  nomConfiguration: string;
  requestedUnitType: string;
  totalAxles: number;
  sakbeVehicleCode: number;
};

type ResolvedSakbeDestination = {
  idDest: string;
  label: string;
  name?: string | null;
  stateAbbr?: string | null;
  requestedQuery?: string | null;
  queryUsed?: string | null;
  source?: string | null;
};

type RouteQuotePayload = {
  provider: "INEGI_SAKBE";
  routeType: string;
  resolvedInput: {
    origin: ResolvedSakbeDestination;
    destination: ResolvedSakbeDestination;
  };
  vehicle: SakbeVehicle & { vehicleProfileId: string };
  summary: {
    distanceKm: number;
    durationMinutes: number;
    hasTolls: boolean;
    tollTotalMxn: number;
    extraAxleTotalMxn: number;
  };
  geometry: unknown;
  tolls: unknown[];
  warnings: string[];
  meta: {
    computedAt: string;
    projection: string;
    attribution: string;
    raw?: unknown;
  };
};

export class SakbeRouteAdapterError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly details?: unknown;

  constructor(message: string, options: { code: string; status?: number; details?: unknown }) {
    super(message);
    this.name = "SakbeRouteAdapterError";
    this.code = options.code;
    this.status = options.status;
    this.details = options.details;
  }
}

export class SakbeRouteAdapter {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly liveEnabled: boolean;
  private readonly cacheMode: "cache_first" | "live_only";

  constructor(private readonly config: SakbeRouteAdapterConfig = {}) {
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchFn = config.fetch ?? fetch;
    this.liveEnabled = config.liveEnabled ?? true;
    this.cacheMode = config.cacheMode ?? "cache_first";
  }

  async resolveRoute(input: QuoteRfqLaneInput): Promise<RouteEvidence> {
    const loaded = await this.resolveSingleDirection({
      input,
      origin: input.origin,
      destination: input.destination
    });
    const needsReturn = requiresReturnRoute(input.service.return_policy);

    if (!needsReturn) {
      return { ...loaded, requires_return_route: false };
    }

    const returnRoute = await this.resolveSingleDirection({
      input,
      origin: input.destination,
      destination: input.origin
    });

    return {
      ...loaded,
      requires_return_route: true,
      km_return: returnRoute.km_loaded,
      return_tolls_mxn: returnRoute.tolls_mxn
    };
  }

  private async resolveSingleDirection({
    input,
    origin,
    destination
  }: {
    input: QuoteRfqLaneInput;
    origin: QuoteLocation;
    destination: QuoteLocation;
  }): Promise<RouteEvidence> {
    const vehicle = getSakbeVehicle(input.vehicle_profile_id);
    const routePolicy = input.service.route_policy || "cuota";
    const cacheKey = buildSakbeRouteCacheKey({
      origin,
      destination,
      routePolicy,
      nomConfiguration: vehicle.nomConfiguration
    });
    const now = this.now();
    const cached = this.cacheMode === "live_only" ? null : await this.readCache(cacheKey, now);

    if (cached) {
      return routeEvidenceFromCacheRow(cached);
    }

    if (!this.liveEnabled) {
      throw new SakbeRouteAdapterError("No valid SAKBE cache hit and live calls are disabled", {
        code: "sakbe_cache_miss"
      });
    }

    const payload = await this.quoteLiveRoute({ input, origin, destination, vehicle, routePolicy });
    const window = sakbeWeekWindow(now);
    const row = sakbeRouteCacheRowFromPayload({
      input,
      origin,
      destination,
      payload,
      cacheKey,
      weekStartsAt: window.weekStartsAt,
      expiresAt: window.expiresAt,
      vehicleProfileId: input.vehicle_profile_id,
      vehicle
    });
    if (this.cacheMode !== "live_only") {
      await this.upsertCache(row);
    }

    return routeEvidenceFromCacheRow(row);
  }

  private async quoteLiveRoute({
    input,
    origin,
    destination,
    vehicle,
    routePolicy
  }: {
    input: QuoteRfqLaneInput;
    origin: QuoteLocation;
    destination: QuoteLocation;
    vehicle: SakbeVehicle;
    routePolicy: string;
  }): Promise<RouteQuotePayload> {
    const [resolvedOrigin, resolvedDestination] = await Promise.all([
      this.resolveDestination(origin),
      this.resolveDestination(destination)
    ]);
    const sakbePayload = {
      dest_i: resolvedOrigin.idDest,
      dest_f: resolvedDestination.idDest,
      v: String(vehicle.sakbeVehicleCode),
      e: "0",
      proj: "GRS80",
      type: "json"
    };
    const [summaryRaw, detailRaw] = await Promise.all([
      this.postSakbe(routePolicy === "libre" ? "libre" : "cuota", sakbePayload, this.timeoutMs()),
      this.postSakbe("detalle_c", sakbePayload, this.timeoutMs())
    ]);

    return normalizeSakbeRoute({
      origin: resolvedOrigin,
      destination: resolvedDestination,
      vehicle: { ...vehicle, vehicleProfileId: input.vehicle_profile_id },
      summaryRaw,
      detailRaw,
      projection: sakbePayload.proj
    });
  }

  private async resolveDestination(input: QuoteLocation): Promise<ResolvedSakbeDestination> {
    const providedId = stringProperty(input, "idDest") || stringProperty(input, "sakbe_id");
    if (providedId) {
      return {
        idDest: providedId,
        label: locationLabel(input),
        name: input.city,
        stateAbbr: getTargetStateAbbr(input),
        requestedQuery: locationLabel(input),
        source: "provided"
      };
    }

    const attempts = buildSearchAttempts(input);
    const targetStateAbbr = getTargetStateAbbr(input);
    for (const query of attempts) {
      const data = await this.postSakbe(
        "buscadestino",
        {
          buscar: query,
          proj: "GRS80",
          type: "json",
          num: "15"
        },
        this.searchTimeoutMs()
      );
      const candidates = normalizeDestinationCandidates(data);
      const selected = pickDestinationCandidate(candidates, {
        targetStateAbbr,
        targetName: input.city
      });
      if (selected) {
        return {
          ...selected,
          requestedQuery: locationLabel(input),
          queryUsed: query,
          source: "sakbe_buscadestino"
        };
      }
    }

    throw new SakbeRouteAdapterError(`No SAKBE destination found for ${locationLabel(input)}`, {
      code: "destination_not_found",
      status: 404
    });
  }

  private async postSakbe(
    endpoint: string,
    params: Record<string, string>,
    timeoutMs: number
  ): Promise<unknown> {
    const apiKey = await this.apiKey();
    if (!apiKey) {
      throw new SakbeRouteAdapterError("Missing SAKBE API key", {
        code: "missing_sakbe_key",
        status: 500
      });
    }

    const attempts = Math.max(1, Math.min(this.config.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS, 5));
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.postSakbeOnce(endpoint, params, timeoutMs, apiKey);
      } catch (error) {
        lastError = error;
        if (attempt >= attempts || !isRetryableSakbeError(error)) {
          throw error;
        }
        await sleep(this.retryDelayMs() * attempt);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new SakbeRouteAdapterError("SAKBE request failed", { code: "sakbe_request_failed" });
  }

  private async postSakbeOnce(
    endpoint: string,
    params: Record<string, string>,
    timeoutMs: number,
    apiKey: string
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.fetchFn(`${this.baseUrl}/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...params, key: apiKey }),
        signal: controller.signal
      });
      const raw = await response.text();

      if (!response.ok) {
        throw new SakbeRouteAdapterError(`SAKBE responded with HTTP ${response.status}`, {
          code: "sakbe_http_error",
          status: response.status,
          details: raw.slice(0, 240)
        });
      }

      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new SakbeRouteAdapterError("SAKBE returned non-JSON response", {
          code: "sakbe_non_json_response",
          status: 502,
          details: raw.slice(0, 240)
        });
      }

      const body = isRecord(json) ? json : {};
      const responseMeta = isRecord(body.response) ? body.response : null;
      if (responseMeta && responseMeta.success === false) {
        throw new SakbeRouteAdapterError(String(responseMeta.message || "SAKBE rejected request"), {
          code: "sakbe_rejected",
          status: 401,
          details: responseMeta
        });
      }
      if (typeof body.error === "string") {
        throw new SakbeRouteAdapterError(body.error, {
          code: "sakbe_error",
          status: 502
        });
      }

      return body.data;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new SakbeRouteAdapterError("SAKBE timed out", {
          code: "sakbe_timeout",
          status: 504
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async readCache(cacheKey: string, now: Date): Promise<SakbeRouteCacheRow | null> {
    const cache = await this.readCacheFile();
    const row = cache[cacheKey];
    if (!row || row.is_active === false) {
      return null;
    }
    if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime()) {
      return null;
    }
    return row;
  }

  private async upsertCache(row: SakbeRouteCacheRow): Promise<void> {
    if (!this.config.cachePath) {
      return;
    }

    const cache = await this.readCacheFile();
    cache[row.cache_key] = row;
    await mkdir(dirname(this.config.cachePath), { recursive: true });
    await writeFile(this.config.cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  }

  private async readCacheFile(): Promise<CacheFile> {
    if (!this.config.cachePath) {
      return {};
    }

    let text = "";
    try {
      text = await readFile(this.config.cachePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return {};
      }
      throw error;
    }
    if (!text.trim()) {
      return {};
    }

    return normalizeCacheFile(JSON.parse(text));
  }

  private now(): Date {
    return this.config.now?.() ?? new Date();
  }

  private timeoutMs(): number {
    return positiveInteger(this.config.timeoutMs, DEFAULT_TIMEOUT_MS);
  }

  private searchTimeoutMs(): number {
    return positiveInteger(this.config.searchTimeoutMs, DEFAULT_SEARCH_TIMEOUT_MS);
  }

  private retryDelayMs(): number {
    return positiveInteger(this.config.retryDelayMs, DEFAULT_RETRY_DELAY_MS);
  }

  private async apiKey(): Promise<string | null> {
    const explicit = this.config.apiKey?.trim();
    if (explicit) {
      return explicit;
    }
    return (await this.config.apiKeyLoader?.())?.trim() || null;
  }
}

export function getSakbeVehicle(input: string): SakbeVehicle {
  const raw = String(input || "").toUpperCase();
  const mapped = UNIT_CODE_TO_NOM[raw] || raw;
  const nomConfiguration = mapped.replace(/[-_\s]/g, "");
  const totalAxles = NOM_AXLES[nomConfiguration];

  if (!totalAxles) {
    throw new SakbeRouteAdapterError(`Unsupported SAKBE unit type: ${input}`, {
      code: "invalid_unit_type",
      status: 400
    });
  }
  if (totalAxles < 2 || totalAxles > 9) {
    throw new SakbeRouteAdapterError("SAKBE supports trucks from 2 to 9 axles", {
      code: "unit_axles_out_of_range",
      status: 400
    });
  }

  return {
    nomConfiguration,
    requestedUnitType: raw,
    totalAxles,
    sakbeVehicleCode: totalAxles + 3
  };
}

export function buildSakbeRouteCacheKey({
  origin,
  destination,
  routePolicy = "cuota",
  nomConfiguration = ""
}: {
  origin: QuoteLocation;
  destination: QuoteLocation;
  routePolicy?: string;
  nomConfiguration?: string;
}): string {
  return [
    "sakbe",
    "v1",
    normalizeKeyPart(routePolicy),
    normalizeKeyPart(stringProperty(origin, "idDest") || stringProperty(origin, "sakbe_id") || locationLabel(origin)),
    normalizeKeyPart(
      stringProperty(destination, "idDest") ||
        stringProperty(destination, "sakbe_id") ||
        locationLabel(destination)
    ),
    normalizeKeyPart(nomConfiguration)
  ].join("|");
}

export function sakbeWeekWindow(
  at = new Date(),
  timeZone = DEFAULT_TIME_ZONE
): { weekStartsAt: string; expiresAt: string } {
  const date = at instanceof Date ? at : new Date(at);
  const local = zonedParts(date, timeZone);
  const localDay = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
  const localSunday = addDaysToLocalParts({ ...local, hour: 0, minute: 0, second: 0 }, -localDay);
  let weekStart = zonedDateTimeToUtc({ ...localSunday, hour: 19, minute: 0, second: 0 }, timeZone);

  if (date.getTime() < weekStart.getTime()) {
    const previousSunday = addDaysToLocalParts(
      { ...localSunday, hour: 0, minute: 0, second: 0 },
      -7
    );
    weekStart = zonedDateTimeToUtc({ ...previousSunday, hour: 19, minute: 0, second: 0 }, timeZone);
  }

  const startLocal = zonedParts(weekStart, timeZone);
  const nextSunday = addDaysToLocalParts({ ...startLocal, hour: 19, minute: 0, second: 0 }, 7);
  const expiresAt = zonedDateTimeToUtc({ ...nextSunday, hour: 19, minute: 0, second: 0 }, timeZone);

  return {
    weekStartsAt: weekStart.toISOString(),
    expiresAt: expiresAt.toISOString()
  };
}

function sakbeRouteCacheRowFromPayload({
  input,
  origin,
  destination,
  payload,
  cacheKey,
  weekStartsAt,
  expiresAt,
  vehicleProfileId,
  vehicle
}: {
  input: QuoteRfqLaneInput;
  origin: QuoteLocation;
  destination: QuoteLocation;
  payload: RouteQuotePayload;
  cacheKey: string;
  weekStartsAt: string;
  expiresAt: string;
  vehicleProfileId: string;
  vehicle: SakbeVehicle;
}): SakbeRouteCacheRow {
  const computedAt = payload.meta.computedAt;

  return {
    cache_key: cacheKey,
    week_starts_at: weekStartsAt,
    expires_at: expiresAt,
    origin_raw: locationLabel(origin),
    destination_raw: locationLabel(destination),
    origin_city: origin.city,
    origin_state: origin.state,
    destination_city: destination.city,
    destination_state: destination.state,
    route_policy: input.service.route_policy || payload.routeType || "cuota",
    vehicle_profile_id: vehicleProfileId,
    nom_configuration: vehicle.nomConfiguration,
    sakbe_vehicle_code: vehicle.sakbeVehicleCode,
    km_loaded: payload.summary.distanceKm,
    estimated_minutes: payload.summary.durationMinutes,
    tolls_mxn: payload.summary.tollTotalMxn,
    toll_detail: payload.tolls,
    route_segments: payload.geometry ? [payload.geometry] : [],
    normalized_payload: payload,
    raw_payload: payload.meta.raw || {},
    source: "inegi_sakbe",
    source_timestamp: computedAt,
    confidence: 0.99,
    warnings: payload.warnings,
    is_active: true
  };
}

function routeEvidenceFromCacheRow(row: SakbeRouteCacheRow): RouteEvidence {
  return {
    status: "resolved",
    source: "sakbe",
    km_loaded: finiteNumberOrNull(row.km_loaded),
    estimated_minutes: finiteNumberOrNull(row.estimated_minutes),
    tolls_mxn: finiteNumberOrNull(row.tolls_mxn),
    requires_return_route: false
  };
}

function normalizeSakbeRoute({
  origin,
  destination,
  vehicle,
  summaryRaw,
  detailRaw,
  projection
}: {
  origin: ResolvedSakbeDestination;
  destination: ResolvedSakbeDestination;
  vehicle: SakbeVehicle & { vehicleProfileId: string };
  summaryRaw: unknown;
  detailRaw: unknown;
  projection: string;
}): RouteQuotePayload {
  const summaryRows = Array.isArray(summaryRaw) ? summaryRaw : [summaryRaw];
  const summary = isRecord(summaryRows[0]) ? summaryRows[0] : {};
  const detailRows = Array.isArray(detailRaw)
    ? detailRaw
    : isRecord(detailRaw) && Array.isArray(detailRaw.tramos)
      ? detailRaw.tramos
      : [];
  const tolls = detailRows
    .filter(isRecord)
    .filter((row) => numberFrom(row.costo_caseta) > 0)
    .map((row, index) => ({
      sequence: index + 1,
      roadName: stringOrNull(row.direccion ?? row.nombre),
      direction: stringOrNull(row.direccion),
      segmentDistanceMeters: numberFrom(row.long_m),
      segmentDurationMinutes: numberFrom(row.tiempo_min),
      costMxn: numberFrom(row.costo_caseta),
      toll_mxn: numberFrom(row.costo_caseta),
      extraAxleCostMxn: 0,
      turnCode: numberFrom(row.giro),
      locationGeojson: parseMaybeJson(row.punto_caseta)
    }));

  return {
    provider: "INEGI_SAKBE",
    routeType: "cuota",
    resolvedInput: { origin, destination },
    vehicle,
    summary: {
      distanceKm: numberFrom(summary.long_km),
      durationMinutes: numberFrom(summary.tiempo_min),
      hasTolls: summary.peaje === "t" || numberFrom(summary.costo_caseta) > 0,
      tollTotalMxn: numberFrom(summary.costo_caseta),
      extraAxleTotalMxn: 0
    },
    geometry: parseMaybeJson(summary.geojson),
    tolls,
    warnings: [
      stringOrNull(summary.advertencia),
      "Ruta de cuota calculada con INEGI SAKBE. Casetas sujetas a actualizacion tarifaria."
    ].filter((value): value is string => Boolean(value)),
    meta: {
      computedAt: new Date().toISOString(),
      projection,
      attribution: "Fuente: INEGI - API de Ruteo SAKBE / Red Nacional de Caminos",
      raw: { summaryRaw, detailRaw }
    }
  };
}

function normalizeDestinationCandidates(data: unknown): ResolvedSakbeDestination[] {
  const rows = Array.isArray(data) ? data : [];
  return rows
    .filter(isRecord)
    .map((row) => ({
      idDest: String(row.id_dest ?? row.idDest ?? ""),
      label: [row.nombre, row.ent_abr].filter(Boolean).join(", "),
      name: stringOrNull(row.nombre),
      stateAbbr: stringOrNull(row.ent_abr),
      source: "sakbe_buscadestino"
    }))
    .filter((row) => row.idDest);
}

function pickDestinationCandidate(
  candidates: ResolvedSakbeDestination[],
  target: { targetStateAbbr: string | null; targetName: string }
): ResolvedSakbeDestination | null {
  if (candidates.length === 0) {
    return null;
  }

  const scored = candidates
    .map((candidate, index) => ({
      candidate,
      index,
      score: destinationCandidateScore(candidate, target)
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index);

  return scored[0]?.candidate ?? null;
}

function destinationCandidateScore(
  candidate: ResolvedSakbeDestination,
  target: { targetStateAbbr: string | null; targetName: string }
): number {
  let score = 0;
  if (target.targetStateAbbr) {
    score += normalizeText(candidate.stateAbbr) === normalizeText(target.targetStateAbbr) ? 100 : -60;
  }
  score += nameMatchScore(candidate.name || candidate.label, target.targetName);
  return score;
}

function nameMatchScore(candidateName: string, targetName: string): number {
  const candidate = normalizeText(candidateName);
  const target = normalizeText(targetName);
  if (!candidate || !target) return 0;
  if (candidate === target) return 80;
  if (candidate.startsWith(target)) return 55;
  if (candidate.includes(target)) return 45;
  if (target.includes(candidate)) return 35;
  return 0;
}

function buildSearchAttempts(input: QuoteLocation): string[] {
  return Array.from(
    new Set(
      [
        [input.city, input.state].filter(Boolean).join(", "),
        input.city,
        input.state
      ].filter(Boolean)
    )
  );
}

function getTargetStateAbbr(input: QuoteLocation): string | null {
  return STATE_ABBR[normalizeText(input.state)] || null;
}

type LocalDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function addDaysToLocalParts(parts: LocalDateTimeParts, days: number): LocalDateTimeParts {
  const date = new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day + days,
      parts.hour,
      parts.minute,
      parts.second
    )
  );
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds()
  };
}

function zonedParts(date: Date, timeZone: string): LocalDateTimeParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const rawParts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );

  return {
    year: numberFrom(rawParts.year),
    month: numberFrom(rawParts.month),
    day: numberFrom(rawParts.day),
    hour: numberFrom(rawParts.hour),
    minute: numberFrom(rawParts.minute),
    second: numberFrom(rawParts.second)
  };
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = zonedParts(date, timeZone);
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return localAsUtc - date.getTime();
}

function zonedDateTimeToUtc(parts: LocalDateTimeParts, timeZone: string): Date {
  let utc = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  );
  utc = new Date(utc.getTime() - timeZoneOffsetMs(utc, timeZone));
  return new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) -
      timeZoneOffsetMs(utc, timeZone)
  );
}

function normalizeCacheFile(value: unknown): CacheFile {
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value.filter(isCacheRow).map((row) => [row.cache_key, row] as const)
    );
  }
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([cacheKey, row]) => normalizeCacheRow(cacheKey, row))
      .filter((entry): entry is readonly [string, SakbeRouteCacheRow] => entry !== null)
  );
}

function normalizeCacheRow(
  cacheKey: string,
  value: unknown
): readonly [string, SakbeRouteCacheRow] | null {
  if (!isRecord(value)) {
    return null;
  }
  const row = {
    ...value,
    cache_key: typeof value.cache_key === "string" ? value.cache_key : cacheKey,
    km_loaded: numberFrom(value.km_loaded ?? value.km),
    estimated_minutes: numberFrom(value.estimated_minutes),
    tolls_mxn: numberFrom(value.tolls_mxn)
  };

  return isCacheRow(row) ? [row.cache_key, row] : null;
}

function isCacheRow(value: unknown): value is SakbeRouteCacheRow {
  return (
    isRecord(value) &&
    typeof value.cache_key === "string" &&
    Number.isFinite(value.km_loaded) &&
    Number.isFinite(value.estimated_minutes) &&
    Number.isFinite(value.tolls_mxn)
  );
}

function requiresReturnRoute(returnPolicy: string): boolean {
  const policy = normalizeText(returnPolicy);
  if (!policy || policy.includes("sin") || policy.includes("one-way")) {
    return false;
  }
  return policy.includes("retorno") || policy.includes("return") || policy.includes("round");
}

function locationLabel(location: QuoteLocation): string {
  return [location.city, location.state, location.country].filter(Boolean).join(", ");
}

function stringProperty(value: unknown, key: string): string | null {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : null;
}

function normalizeText(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeKeyPart(value: unknown): string {
  return (
    normalizeText(value)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "na"
  );
}

function finiteNumberOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberFrom(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback;
}

function parseMaybeJson(value: unknown): unknown {
  if (!value || typeof value !== "string") {
    return value ?? null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isRetryableSakbeError(error: unknown): boolean {
  if (error instanceof SakbeRouteAdapterError) {
    return (
      error.code === "sakbe_timeout" ||
      error.code === "sakbe_non_json_response" ||
      Number(error.status || 0) >= 500
    );
  }
  return error instanceof TypeError && /fetch|network|socket|terminated/i.test(error.message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
