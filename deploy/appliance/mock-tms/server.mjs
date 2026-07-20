#!/usr/bin/env node
/**
 * Mock TMS con API HTTP — habla el contrato exacto de HttpTmsAdapter
 * (packages/connectors/src/tms/HttpTmsAdapter.ts, endpoints default) para
 * demos e instalaciones de prueba sin un TMS real.
 *
 * Cero dependencias: corre con `node server.mjs` en cualquier Node >= 20
 * (Mac, VPS o dentro de un contenedor node:22-alpine).
 *
 * Datos que sirve:
 *  - Unidades con clave NOM mexicana en el id de perfil (T3S3_53_DRYVAN,
 *    T3S2_53_DRYVAN, T3S2R4_DOUBLE_40_DRYVAN) — el mapeo UNIT_CODE_TO_NOM del
 *    SakbeRouteAdapter las entiende y así INEGI SAKBE sabe qué unidad cotiza.
 *  - Rendimiento por unidad (kpl_yield) y costo real por km — lo que el
 *    overlay `performance_source: tms` consume. El costo de operador vive en
 *    el manifest del cliente (operator_cost_per_km_mxn); aquí se refleja
 *    dentro del desglose de las liquidaciones.
 *  - Liquidaciones: la fuente de verdad de los históricos. Cada fila tiene
 *    origen-destino + unidad + categoría de carga + costo liquidado + margen.
 *  - Búsqueda histórica por capas (misma lógica y mismos strings de razones
 *    que packages/connectors/src/tms/historicalAnalysis.ts): ruta+unidad,
 *    categoría de carga, sector, banda de peso y tipo de servicio.
 *  - Writebacks de cotización/estatus (en memoria, inspeccionables por GET).
 */
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

// ── Dataset ──────────────────────────────────────────────────────────────────

const UNITS = [
  { unit_id: "T3S3_53_DRYVAN", status: "Available", current_lat: 20.6597, current_lng: -103.3496, next_destination_city: "Monterrey" },
  { unit_id: "T3S2_53_DRYVAN", status: "Available", current_lat: 25.6866, current_lng: -100.3161, next_destination_city: "Ciudad de Mexico" },
  { unit_id: "T3S2R4_DOUBLE_40_DRYVAN", status: "En_Ruta", current_lat: 19.4326, current_lng: -99.1332, next_destination_city: "Guadalajara" }
];

const PERFORMANCE = [
  { unit_type: "T3S3_53_DRYVAN", kpl_yield: 2.8, real_cost_per_km: 8.5 },
  { unit_type: "T3S2_53_DRYVAN", kpl_yield: 3.0, real_cost_per_km: 7.9 },
  { unit_type: "T3S2R4_DOUBLE_40_DRYVAN", kpl_yield: 2.2, real_cost_per_km: 11.4 }
];

const AVAILABILITY_ZONES = [
  { zone_id: "ZONA-GDL", city: "Guadalajara", state: "Jalisco", country: "MX", available_units: 4 },
  { zone_id: "ZONA-MTY", city: "Monterrey", state: "Nuevo Leon", country: "MX", available_units: 3 },
  { zone_id: "ZONA-CDMX", city: "Ciudad de Mexico", state: "Ciudad de Mexico", country: "MX", available_units: 5 }
];

const CUSTOMERS = [
  { customer_id: "VPSE2E-CUST-01", name: "Cliente Demo VPS", company_alias: "Demo VPS Corp", customer_type: "industrial", business_unit_id: "DV_53_FT" }
];

const AGREEMENTS = [
  { agreement_id: "AGR-VPSE2E-01", customer_id: "VPSE2E-CUST-01", lane_id: null, rate_mxn: null, effective_from: "2026-01-01", effective_to: null }
];

const UNIT_POSITIONS = [
  { unit_id: "T3S3_53_DRYVAN", vehicle_profile_id: "T3S3_53_DRYVAN", city: "Guadalajara", state: "Jalisco", country: "MX", available_at: "2026-07-21T08:00:00-06:00" },
  { unit_id: "T3S2_53_DRYVAN", vehicle_profile_id: "T3S2_53_DRYVAN", city: "Monterrey", state: "Nuevo Leon", country: "MX", available_at: "2026-07-21T08:00:00-06:00" }
];

// Liquidaciones: costo liquidado real por viaje — la base de los históricos.
// operator_cost_mxn es el componente de operador dentro del costo liquidado.
function liq(id, o, oe, d, de, unit, cat, sector, weightKg, service, quotedAt, rate, cost, operatorCost) {
  return {
    liquidation_id: id,
    origin_city: o, origin_state: oe, origin_country: "MX",
    destination_city: d, destination_state: de, destination_country: "MX",
    vehicle_profile_id: unit, commodity_category: cat, sector,
    weight_kg: weightKg, service_type: service, quoted_at: quotedAt,
    rate_mxn: rate, direct_cost_mxn: cost, operator_cost_mxn: operatorCost,
    margin_pct: Math.round(((rate - cost) / rate) * 100) / 100
  };
}

const LIQUIDATIONS = [
  // Guadalajara → Monterrey, T3S3, general/industrial — clúster para auto-aprobación
  liq("LIQ-0001", "Guadalajara", "Jalisco", "Monterrey", "Nuevo Leon", "T3S3_53_DRYVAN", "general", "industrial", 18000, "cuota", "2026-03-10", 18100, 7783, 1490),
  liq("LIQ-0002", "Guadalajara", "Jalisco", "Monterrey", "Nuevo Leon", "T3S3_53_DRYVAN", "general", "industrial", 18000, "cuota", "2026-04-15", 19200, 8256, 1512),
  liq("LIQ-0003", "Guadalajara", "Jalisco", "Monterrey", "Nuevo Leon", "T3S3_53_DRYVAN", "general", "industrial", 18000, "cuota", "2026-05-10", 19850, 8536, 1533),
  liq("LIQ-0004", "Guadalajara", "Jalisco", "Monterrey", "Nuevo Leon", "T3S3_53_DRYVAN", "general", "industrial", 18000, "cuota", "2026-06-05", 20600, 8858, 1560),
  liq("LIQ-0005", "Guadalajara", "Jalisco", "Monterrey", "Nuevo Leon", "T3S3_53_DRYVAN", "general", "industrial", 18000, "cuota", "2026-06-28", 21400, 9202, 1581),
  // Monterrey → CDMX, T3S3
  liq("LIQ-0006", "Monterrey", "Nuevo Leon", "Ciudad de Mexico", "Ciudad de Mexico", "T3S3_53_DRYVAN", "general", "industrial", 18000, "cuota", "2026-04-20", 35800, 20900, 2410),
  liq("LIQ-0007", "Monterrey", "Nuevo Leon", "Ciudad de Mexico", "Ciudad de Mexico", "T3S3_53_DRYVAN", "general", "industrial", 18000, "cuota", "2026-05-25", 36574, 21600, 2455),
  liq("LIQ-0008", "Monterrey", "Nuevo Leon", "Ciudad de Mexico", "Ciudad de Mexico", "T3S3_53_DRYVAN", "general", "industrial", 24000, "cuota", "2026-06-18", 37900, 22400, 2490),
  // CDMX → Guadalajara, T3S2, autopartes/automotriz
  liq("LIQ-0009", "Ciudad de Mexico", "Ciudad de Mexico", "Guadalajara", "Jalisco", "T3S2_53_DRYVAN", "autopartes", "automotriz", 15000, "cuota", "2026-05-02", 30800, 17900, 2100),
  liq("LIQ-0010", "Ciudad de Mexico", "Ciudad de Mexico", "Guadalajara", "Jalisco", "T3S2_53_DRYVAN", "autopartes", "automotriz", 15000, "cuota", "2026-06-11", 31650, 18300, 2130)
];

const quoteWritebacks = [];
const statusWritebacks = [];

// ── Análisis histórico por capas (idéntico a historicalAnalysis.ts) ─────────

const norm = (v) => String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
const roundMoney = (v) => Math.round(v * 100) / 100;

function weightBand(kg) {
  if (kg < 5000) return "0t_5t";
  if (kg < 10000) return "5t_10t";
  if (kg < 15000) return "10t_15t";
  if (kg < 20000) return "15t_20t";
  return "20t_plus";
}

function percentile(sorted, p) {
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return roundMoney(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo));
}

function median(sorted) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? roundMoney((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

function comparable(layer, matchQuality, rows, extras = {}) {
  const rates = rows.map((r) => r.rate_mxn).sort((a, b) => a - b);
  if (rates.length === 0) return null;
  const costs = rows.map((r) => r.direct_cost_mxn).filter((v) => typeof v === "number");
  const margins = rows.map((r) => r.margin_pct).filter((v) => typeof v === "number");
  const avg = (vals) => roundMoney(vals.reduce((s, v) => s + v, 0) / vals.length);
  return {
    layer, match_quality: matchQuality, count: rates.length,
    min_rate_mxn: rates[0], p25_rate_mxn: percentile(rates, 0.25),
    median_rate_mxn: median(rates), p75_rate_mxn: percentile(rates, 0.75),
    max_rate_mxn: rates[rates.length - 1],
    ...(costs.length ? { avg_direct_cost_mxn: avg(costs) } : {}),
    ...(margins.length ? { avg_margin_pct: avg(margins) } : {}),
    ...extras
  };
}

function analyze(query) {
  const from = query.time_window?.from ?? "1970-01-01";
  const to = query.time_window?.to ?? "9999-12-31";
  const rows = LIQUIDATIONS
    .filter((r) => r.quoted_at >= from && r.quoted_at <= to)
    .filter((r) => !query.vehicle_profile_id || norm(r.vehicle_profile_id) === norm(query.vehicle_profile_id));

  const comparables = [];
  const insufficient = [];
  const cat = query.cargo?.commodity_category?.trim() || null;
  const sector = query.cargo?.sector?.trim() || null;

  const routeRows = rows.filter((r) =>
    norm(r.origin_city) === norm(query.origin?.city) && norm(r.origin_state) === norm(query.origin?.state) &&
    norm(r.destination_city) === norm(query.destination?.city) && norm(r.destination_state) === norm(query.destination?.state) &&
    (!cat || norm(r.commodity_category) === norm(cat)) && (!sector || norm(r.sector) === norm(sector))
  );
  const routeComp = comparable("route_unit_cost", "exact_route_exact_unit", routeRows);
  routeComp ? comparables.push(routeComp) : insufficient.push({ layer: "route_unit_cost", reason: "exact_route_unit_history_missing" });

  if (cat) {
    const catRows = rows.filter((r) => norm(r.commodity_category) === norm(cat) && (!sector || norm(r.sector) === norm(sector)));
    const comp = comparable("commodity_category", sector ? "same_commodity_sector_same_unit" : "same_commodity_same_unit", catRows, { commodity_category: cat, ...(sector ? { sector } : {}) });
    comp ? comparables.push(comp) : insufficient.push({ layer: "commodity_category", reason: "commodity_category_history_missing" });
  }
  if (sector) {
    const sRows = rows.filter((r) => norm(r.sector) === norm(sector));
    const comp = comparable("sector", "same_sector_same_unit", sRows, { sector });
    comp ? comparables.push(comp) : insufficient.push({ layer: "sector", reason: "sector_history_missing" });
  }
  const weight = query.cargo?.weight_kg;
  if (weight === null || weight === undefined) {
    insufficient.push({ layer: "weight_band", reason: "weight_kg_missing" });
  } else {
    const band = weightBand(weight);
    const wRows = rows.filter((r) => typeof r.weight_kg === "number" && weightBand(r.weight_kg) === band);
    const comp = comparable("weight_band", "same_weight_band_same_unit", wRows, { weight_band: band });
    comp ? comparables.push(comp) : insufficient.push({ layer: "weight_band", reason: "weight_band_history_missing" });
  }
  const service = query.service_type?.trim() || null;
  if (service) {
    const svcRows = rows.filter((r) => norm(r.service_type) === norm(service));
    const comp = comparable("service_type", "same_service_type_same_unit", svcRows);
    comp ? comparables.push(comp) : insufficient.push({ layer: "service_type", reason: "service_type_history_missing" });
  }

  return {
    request_id: query.request_id ?? "mock-tms",
    search_layers: ["route_unit_cost", "commodity_category", "sector", "weight_band", "service_type"],
    time_window: { from: query.time_window?.from ?? from, to: query.time_window?.to ?? to },
    comparables,
    insufficient_data: insufficient
  };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

export function createMockTmsServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (req.method === "GET" && path === "/health") {
        return json(res, 200, { ok: true, service: "mock-tms", liquidations: LIQUIDATIONS.length, units: UNITS.length });
      }
      if (req.method === "GET" && path === "/units") return json(res, 200, UNITS);
      if (req.method === "GET" && path === "/unit-performance") return json(res, 200, PERFORMANCE);
      if (req.method === "GET" && path === "/availability-zones") return json(res, 200, AVAILABILITY_ZONES);
      if (req.method === "GET" && path === "/unit-positions") return json(res, 200, UNIT_POSITIONS);
      if (req.method === "GET" && path === "/liquidations") return json(res, 200, LIQUIDATIONS);
      if (req.method === "GET" && path === "/rfqs/new") return json(res, 200, []);
      if (req.method === "GET" && path.startsWith("/rfqs/")) return json(res, 404, { error: "rfq_not_found" });
      if (req.method === "GET" && path.startsWith("/customers/") && path.endsWith("/agreements")) {
        const id = decodeURIComponent(path.split("/")[2]);
        return json(res, 200, AGREEMENTS.filter((a) => a.customer_id === id));
      }
      if (req.method === "GET" && path.startsWith("/customers/")) {
        const id = decodeURIComponent(path.split("/")[2]);
        const customer = CUSTOMERS.find((c) => c.customer_id === id);
        return customer ? json(res, 200, customer) : json(res, 404, { error: "customer_not_found" });
      }
      if (req.method === "POST" && path === "/historical-quotes/search") {
        return json(res, 200, analyze(await readBody(req)));
      }
      if (req.method === "POST" && path === "/historical-shipments/search") return json(res, 200, []);
      if (req.method === "POST" && path === "/quotes") {
        const input = await readBody(req);
        quoteWritebacks.push({ ...input, received_at: new Date().toISOString() });
        console.log(`[mock-tms] quote writeback: ${input.quote_id} ${input.rate_mxn} ${input.currency}`);
        return json(res, 200, { quote_id: input.quote_id, status: "written" });
      }
      if (req.method === "POST" && path === "/status") {
        const input = await readBody(req);
        statusWritebacks.push({ ...input, received_at: new Date().toISOString() });
        return json(res, 200, { entity_id: input.entity_id, status: "written" });
      }
      if (req.method === "GET" && path === "/quote-writebacks") return json(res, 200, quoteWritebacks);
      if (req.method === "GET" && path === "/status-writebacks") return json(res, 200, statusWritebacks);
      return json(res, 404, { error: "not_found", path });
    } catch (error) {
      return json(res, 500, { error: "mock_tms_error", message: error instanceof Error ? error.message : String(error) });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8099);
  createMockTmsServer().listen(port, "0.0.0.0", () => {
    console.log(`[mock-tms] listening on :${port} — ${LIQUIDATIONS.length} liquidaciones, ${UNITS.length} unidades NOM`);
  });
}
