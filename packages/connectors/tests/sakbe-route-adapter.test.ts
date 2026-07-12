import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSakbeRouteCacheKey,
  SakbeRouteAdapter,
  type SakbeRouteCacheRow
} from "../src/index";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("SakbeRouteAdapter", () => {
  it("uses valid SAKBE cache before attempting live calls", async () => {
    const cachePath = await createTempJson("route-cache.json", {
      [cacheKey]: cacheRow({ expires_at: "2026-06-22T01:00:00.000Z" })
    });
    const adapter = new SakbeRouteAdapter({
      cachePath,
      liveEnabled: false,
      now: () => new Date("2026-06-19T18:00:00.000Z")
    });

    await expect(adapter.resolveRoute(rfqLane)).resolves.toMatchObject({
      status: "resolved",
      source: "sakbe",
      km_loaded: 905.45,
      estimated_minutes: 565.82,
      tolls_mxn: 3859
    });
  });

  it("fails closed when the cache misses and live SAKBE is disabled", async () => {
    const cachePath = await createTempJson("route-cache.json", {});
    const adapter = new SakbeRouteAdapter({
      cachePath,
      liveEnabled: false,
      now: () => new Date("2026-06-19T18:00:00.000Z")
    });

    await expect(adapter.resolveRoute(rfqLane)).rejects.toMatchObject({
      name: "SakbeRouteAdapterError",
      code: "sakbe_cache_miss"
    });
  });

  it("calls live SAKBE on cache miss and stores normalized evidence", async () => {
    const cachePath = await createTempJson("route-cache.json", {});
    const calls: string[] = [];
    const adapter = new SakbeRouteAdapter({
      cachePath,
      apiKey: "test-key",
      fetch: async (url) => {
        const endpoint = String(url).split("/").pop() || "";
        calls.push(endpoint);
        if (endpoint === "buscadestino") {
          return jsonResponse([
            { id_dest: calls.length === 1 ? "100" : "200", nombre: calls.length === 1 ? "Monterrey" : "Ciudad de Mexico", ent_abr: calls.length === 1 ? "N.L." : "CDMX" }
          ]);
        }
        if (endpoint === "cuota") {
          return jsonResponse([
            {
              long_km: 905.45,
              tiempo_min: 565.82,
              peaje: "t",
              costo_caseta: 3859,
              geojson: "{\"type\":\"LineString\",\"coordinates\":[]}"
            }
          ]);
        }
        return jsonResponse([
          {
            direccion: "Caseta demo",
            long_m: 1000,
            tiempo_min: 5,
            costo_caseta: 3859,
            giro: 0
          }
        ]);
      },
      now: () => new Date("2026-06-19T18:00:00.000Z")
    });

    const route = await adapter.resolveRoute(rfqLane);
    const cache = JSON.parse(await readFile(cachePath, "utf8")) as Record<string, SakbeRouteCacheRow>;

    expect(calls).toEqual(["buscadestino", "buscadestino", "cuota", "detalle_c"]);
    expect(route).toMatchObject({
      source: "sakbe",
      km_loaded: 905.45,
      tolls_mxn: 3859
    });
    expect(cache[cacheKey]).toMatchObject({
      cache_key: cacheKey,
      source: "inegi_sakbe",
      km_loaded: 905.45,
      tolls_mxn: 3859
    });
  });

  it("live_only bypasses SAKBE cache reads and writes", async () => {
    const cachePath = await createTempJson("route-cache.json", { invalid: "ignored" });
    await writeFile(cachePath, "not-json", "utf8");
    const calls: string[] = [];
    const adapter = new SakbeRouteAdapter({
      cachePath,
      cacheMode: "live_only",
      apiKey: "test-key",
      fetch: async (url) => {
        const endpoint = String(url).split("/").pop() || "";
        calls.push(endpoint);
        if (endpoint === "buscadestino") {
          return jsonResponse([
            {
              id_dest: calls.length === 1 ? "100" : "200",
              nombre: calls.length === 1 ? "Monterrey" : "Ciudad de Mexico",
              ent_abr: calls.length === 1 ? "N.L." : "CDMX"
            }
          ]);
        }
        if (endpoint === "cuota") {
          return jsonResponse([
            {
              long_km: 905.45,
              tiempo_min: 565.82,
              peaje: "t",
              costo_caseta: 3859
            }
          ]);
        }
        return jsonResponse([]);
      },
      now: () => new Date("2026-06-19T18:00:00.000Z")
    });

    const route = await adapter.resolveRoute(rfqLane);

    expect(route).toMatchObject({
      source: "sakbe",
      km_loaded: 905.45,
      tolls_mxn: 3859
    });
    expect(await readFile(cachePath, "utf8")).toBe("not-json");
  });

  it("loads the SAKBE API key through the configured loader", async () => {
    const cachePath = await createTempJson("route-cache.json", {});
    const requestBodies: URLSearchParams[] = [];
    const adapter = new SakbeRouteAdapter({
      cachePath,
      cacheMode: "live_only",
      apiKeyLoader: async () => "sakbe-loaded-key-1234567890",
      fetch: async (url, init) => {
        requestBodies.push(new URLSearchParams(String(init?.body)));
        const endpoint = String(url).split("/").pop() || "";
        if (endpoint === "buscadestino") {
          return jsonResponse([
            {
              id_dest: requestBodies.length === 1 ? "100" : "200",
              nombre: requestBodies.length === 1 ? "Monterrey" : "Ciudad de Mexico",
              ent_abr: requestBodies.length === 1 ? "N.L." : "CDMX"
            }
          ]);
        }
        if (endpoint === "cuota") {
          return jsonResponse([
            {
              long_km: 905.45,
              tiempo_min: 565.82,
              peaje: "t",
              costo_caseta: 3859
            }
          ]);
        }
        return jsonResponse([]);
      },
      now: () => new Date("2026-06-19T18:00:00.000Z")
    });

    await expect(adapter.resolveRoute(rfqLane)).resolves.toMatchObject({
      source: "sakbe",
      km_loaded: 905.45
    });
    expect(requestBodies).toHaveLength(4);
    expect(requestBodies.every((body) => body.get("key") === "sakbe-loaded-key-1234567890")).toBe(
      true
    );
  });

  it("live_only fails closed when the SAKBE API key is missing", async () => {
    const cachePath = await createTempJson("route-cache.json", {
      [cacheKey]: cacheRow({ expires_at: "2026-06-22T01:00:00.000Z" })
    });
    const adapter = new SakbeRouteAdapter({
      cachePath,
      cacheMode: "live_only",
      liveEnabled: true,
      now: () => new Date("2026-06-19T18:00:00.000Z")
    });

    await expect(adapter.resolveRoute(rfqLane)).rejects.toMatchObject({
      name: "SakbeRouteAdapterError",
      code: "missing_sakbe_key"
    });
  });
});

async function createTempJson(name: string, content: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "quoteops-sakbe-"));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, name);
  await writeFile(filePath, `${JSON.stringify(content, null, 2)}\n`, "utf8");
  return filePath;
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    headers: { "content-type": "application/json" }
  });
}

const rfqLane = {
  rfq_id: "RFQ-2026-000901",
  lane_id: "RFQ-2026-000901-L01",
  requester_email: "compras@nuevomex.mx",
  client_id: "NMX",
  business_unit_id: "DV_53_FT",
  origin: { city: "Monterrey", state: "Nuevo Leon", country: "MX" },
  destination: { city: "Ciudad de Mexico", state: "Ciudad de Mexico", country: "MX" },
  vehicle_profile_id: "T3S3_53_DRYVAN",
  cargo: {
    weight_kg: 18000,
    value_mxn: 400000,
    commodity: "carga general",
    commodity_category: "general",
    sector: "industrial",
    hazmat: false
  },
  service: { return_policy: "sin_retorno", route_policy: "cuota" },
  commercial: { target_rate_mxn: null }
};

const cacheKey = buildSakbeRouteCacheKey({
  origin: rfqLane.origin,
  destination: rfqLane.destination,
  routePolicy: rfqLane.service.route_policy,
  nomConfiguration: "T3S3"
});

function cacheRow(overrides: Partial<SakbeRouteCacheRow> = {}): SakbeRouteCacheRow {
  return {
    cache_key: cacheKey,
    week_starts_at: "2026-06-15T01:00:00.000Z",
    expires_at: "2026-06-22T01:00:00.000Z",
    origin_raw: "Monterrey, Nuevo Leon, MX",
    destination_raw: "Ciudad de Mexico, Ciudad de Mexico, MX",
    route_policy: "cuota",
    vehicle_profile_id: "T3S3_53_DRYVAN",
    nom_configuration: "T3S3",
    sakbe_vehicle_code: 9,
    km_loaded: 905.45,
    estimated_minutes: 565.82,
    tolls_mxn: 3859,
    source: "inegi_sakbe",
    is_active: true,
    ...overrides
  };
}
