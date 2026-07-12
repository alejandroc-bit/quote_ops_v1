import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileImportTmsAdapter,
  SqlTmsAdapter,
  translateMssqlParams,
  translatePgParams,
  type HistoricalSearchQuery,
  type SqlExecutor,
  type SqlRow
} from "../src/index";

class RecordingExecutor implements SqlExecutor {
  readonly calls: Array<{ sql: string; params: Record<string, unknown> }> = [];
  constructor(private readonly rowsByMatch: Array<{ match: string; rows: SqlRow[] }>) {}
  async query(sql: string, params: Record<string, unknown>): Promise<SqlRow[]> {
    this.calls.push({ sql, params });
    const hit = this.rowsByMatch.find((entry) => sql.includes(entry.match));
    return hit ? hit.rows : [];
  }
  async close(): Promise<void> {}
}

const query: HistoricalSearchQuery = {
  request_id: "req-1",
  origin: { city: "Monterrey", state: "Nuevo Leon", country: "MX" },
  destination: { city: "Ciudad de Mexico", state: "CDMX", country: "MX" },
  vehicle_profile_id: "PLAT_FULL",
  cargo: { commodity_category: "industrial", sector: "manufactura", weight_kg: 22000 },
  service_type: null,
  time_window: { from: "2026-01-01", to: "2026-12-31" }
};

// same three historical rows, expressed as CSV (file) and as typed SQL rows
const historicalRows = [
  {
    origin_city: "Monterrey",
    origin_state: "Nuevo Leon",
    origin_country: "MX",
    destination_city: "Ciudad de Mexico",
    destination_state: "CDMX",
    destination_country: "MX",
    vehicle_profile_id: "PLAT_FULL",
    commodity_category: "industrial",
    sector: "manufactura",
    weight_kg: 22000,
    rate_mxn: 18000,
    direct_cost_mxn: 14000,
    margin_pct: 0.22,
    quoted_at: "2026-03-01"
  },
  {
    origin_city: "Monterrey",
    origin_state: "Nuevo Leon",
    origin_country: "MX",
    destination_city: "Ciudad de Mexico",
    destination_state: "CDMX",
    destination_country: "MX",
    vehicle_profile_id: "PLAT_FULL",
    commodity_category: "industrial",
    sector: "manufactura",
    weight_kg: 21000,
    rate_mxn: 20000,
    direct_cost_mxn: 15500,
    margin_pct: 0.225,
    quoted_at: "2026-04-01"
  },
  {
    origin_city: "Monterrey",
    origin_state: "Nuevo Leon",
    origin_country: "MX",
    destination_city: "Ciudad de Mexico",
    destination_state: "CDMX",
    destination_country: "MX",
    vehicle_profile_id: "PLAT_FULL",
    commodity_category: "industrial",
    sector: "manufactura",
    weight_kg: 23000,
    rate_mxn: 22000,
    direct_cost_mxn: 16800,
    margin_pct: 0.235,
    quoted_at: "2026-05-01"
  }
];

async function csvFrom(rows: Array<Record<string, unknown>>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sql-tms-"));
  const path = join(dir, "historical-quotes.csv");
  const headers = Object.keys(rows[0]!);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => String(row[h] ?? "")).join(","));
  }
  await writeFile(path, lines.join("\n"));
  return path;
}

describe("SqlTmsAdapter parity with FileImportTmsAdapter", () => {
  it("produces the identical HistoricalAnalysis from the same rows", async () => {
    const csvPath = await csvFrom(historicalRows);
    const file = new FileImportTmsAdapter({ historicalQuotesPath: csvPath });
    const fileAnalysis = await file.searchHistoricalQuotes(query);

    const sql = new SqlTmsAdapter(
      { queries: { historical_quotes: "SELECT * FROM cotizaciones WHERE origen = :origin_city" } },
      new RecordingExecutor([{ match: "cotizaciones", rows: historicalRows as SqlRow[] }])
    );
    const sqlAnalysis = await sql.searchHistoricalQuotes(query);

    expect(sqlAnalysis).toEqual(fileAnalysis);
    const routeLayer = sqlAnalysis.comparables.find((c) => c.layer === "route_unit_cost");
    expect(routeLayer?.median_rate_mxn).toBe(20000);
  });
});

describe("SqlTmsAdapter", () => {
  it("passes RFQ values as bind params, never interpolated", async () => {
    const executor = new RecordingExecutor([]);
    const sql = new SqlTmsAdapter(
      { queries: { historical_quotes: "SELECT * FROM q WHERE ciudad = :origin_city" } },
      executor
    );
    await sql.searchHistoricalQuotes(query);
    expect(executor.calls[0]!.params.origin_city).toBe("Monterrey");
    expect(executor.calls[0]!.params.weight_kg).toBe(22000);
    // the SQL string itself is unchanged — the value is bound, not spliced in
    expect(executor.calls[0]!.sql).toContain(":origin_city");
    expect(executor.calls[0]!.sql).not.toContain("Monterrey");
  });

  it("maps canonical performance and units rows", async () => {
    const sql = new SqlTmsAdapter(
      {
        queries: {
          performance: "SELECT tipo AS unit_type, rend AS kpl_yield, costo AS real_cost_per_km FROM u",
          units: "SELECT * FROM unidades"
        }
      },
      new RecordingExecutor([
        {
          match: "kpl_yield",
          rows: [{ unit_type: "PLAT_FULL", kpl_yield: 2.6, real_cost_per_km: 12.4 }]
        },
        {
          match: "unidades",
          rows: [{ unit_id: "T-101", current_lat: 25.6, current_lng: -100.3, status: "Available" }]
        }
      ])
    );
    const perf = await sql.getUnitPerformance();
    expect(perf).toEqual([{ unit_type: "PLAT_FULL", kpl_yield: 2.6, real_cost_per_km: 12.4 }]);
    const units = await sql.getUnits();
    expect(units[0]!.unit_id).toBe("T-101");
    expect(units[0]!.status).toBe("Available");
  });

  it("returns unsupported_write when no write_quote statement is configured", async () => {
    const sql = new SqlTmsAdapter({ queries: {} }, new RecordingExecutor([]));
    const result = await sql.writeQuoteResult({
      quote_id: "q-1",
      rfq_id: "r-1",
      lane_id: "l-1",
      rate_mxn: 100,
      currency: "MXN"
    });
    expect(result).toEqual({ quote_id: "q-1", status: "unsupported_write" });
  });

  it("writes back via the configured statement with bind params", async () => {
    const executor = new RecordingExecutor([]);
    const sql = new SqlTmsAdapter(
      { queries: {}, write_quote: { statement: "INSERT INTO outbox VALUES (:quote_id, :rate_mxn)" } },
      executor
    );
    const result = await sql.writeQuoteResult({
      quote_id: "q-9",
      rfq_id: "r-9",
      lane_id: "l-9",
      rate_mxn: 999,
      currency: "MXN"
    });
    expect(result.status).toBe("written");
    expect(executor.calls[0]!.params).toMatchObject({ quote_id: "q-9", rate_mxn: 999 });
  });

  it("reports capabilities from configured queries", async () => {
    const sql = new SqlTmsAdapter(
      { queries: { units: "SELECT 1", performance: "SELECT 1" } },
      new RecordingExecutor([{ match: "SELECT 1", rows: [] }])
    );
    const health = await sql.healthCheck();
    expect(health.ok).toBe(true);
    expect(health.capabilities.read_units).toBe(true);
    expect(health.capabilities.read_unit_performance).toBe(true);
    expect(health.capabilities.read_availability_zones).toBe(false);
  });
});

describe("SQL param translation", () => {
  it("translates :name to $n for postgres, reusing indexes and skipping ::casts", () => {
    const { text, values } = translatePgParams(
      "SELECT * FROM q WHERE a = :city AND b = :city AND c = :n::text",
      { city: "MTY", n: "5" }
    );
    expect(text).toBe("SELECT * FROM q WHERE a = $1 AND b = $1 AND c = $2::text");
    expect(values).toEqual(["MTY", "5"]);
  });

  it("leaves an unbound :name untouched", () => {
    const { text, values } = translatePgParams("SELECT :missing", {});
    expect(text).toBe("SELECT :missing");
    expect(values).toEqual([]);
  });

  it("translates :name to @name for mssql without touching ::casts", () => {
    expect(translateMssqlParams("WHERE a = :city AND b = :n::text")).toBe(
      "WHERE a = @city AND b = @n::text"
    );
  });
});
