import { type IncomingMessage, ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex, Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createApplianceWorkflowTools, createQuoteOpsApi } from "@quoteops/api";
import { createInstallationLicense, generateLicenseKeyPair } from "@quoteops/shared";
import { nmxCriteriaNodes, nmxManifest, nmxRfq } from "../fixtures/nmx/clientPack";

const tempDirs: string[] = [];
const envRestores: Array<() => void> = [];

afterEach(async () => {
  while (envRestores.length > 0) {
    envRestores.pop()?.();
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("NMX appliance runtime", () => {
  it("runs through API using live SAKBE, TMS files, and OpenRouter guide config", async () => {
    const root = await mkdtemp(join(tmpdir(), "quoteops-nmx-appliance-"));
    tempDirs.push(root);
    const routeCachePath = join(root, "sakbe", "route-cache.json");
    const historicalQuotesPath = join(root, "tms", "historical-quotes.csv");
    const quoteWritebacksPath = join(root, "tms", "quote-writebacks.jsonl");
    const agentConfigPath = join(root, "agent", "agent-config.yaml");
    await mkdir(join(root, "sakbe"), { recursive: true });
    await mkdir(join(root, "tms"), { recursive: true });
    await mkdir(join(root, "agent"), { recursive: true });
    await writeFile(routeCachePath, "not-json-cache-should-not-be-read", "utf8");
    await writeFile(historicalQuotesPath, nmxHistoricalQuotesCsv.trim(), "utf8");
    await writeFile(agentConfigPath, nmxAgentConfigYaml, "utf8");

    const api = startApi({
      ...licenseEnv("NMX", "nmx-local-001"),
      QUOTEOPS_INSTALLATION_ID: "nmx-local-001",
      QUOTEOPS_AGENT_CONFIG_PATH: agentConfigPath,
      QUOTEOPS_ROUTE_CACHE_PATH: routeCachePath,
      QUOTEOPS_SAKBE_CACHE_MODE: "live_only",
      QUOTEOPS_SAKBE_LIVE_ENABLED: "true",
      INEGI_SAKBE_KEY: "test-sakbe-key",
      OPENROUTER_API_KEY: "sk-or-test",
      QUOTEOPS_TMS_HISTORICAL_QUOTES_PATH: historicalQuotesPath,
      QUOTEOPS_TMS_QUOTE_WRITEBACKS_PATH: quoteWritebacksPath,
      QUOTEOPS_HISTORICAL_FROM: "2026-01-01",
      QUOTEOPS_HISTORICAL_TO: "2026-12-31"
    }, testFetch);
    const response = await api.post("/api/rfqs", {
      run_id: "RUN-NMX-APPLIANCE-001",
      client_id: "NMX",
      manifest_version: "nmx-supabase-snapshot-2026.06.15.5",
      criteria_version: "nmx-criteria-2026.06.19.1",
      connector_versions: {
        tms: "file-import@2.0.0",
        route_provider: "sakbe@2.0.0"
      },
      raw_rfq: nmxRfq,
      manifest: nmxManifest,
      criteria_nodes: nmxCriteriaNodes
    });
    const submitted = response.body;
    const stateResponse = await api.get("/api/workflow-state/RUN-NMX-APPLIANCE-001");
    const state = stateResponse.body;
    const writebackLines = (await readFile(quoteWritebacksPath, "utf8")).trim().split("\n");
    const writeback = JSON.parse(writebackLines[0] ?? "{}") as Record<string, unknown>;

    expect(response.status).toBe(202);
    expect(submitted).toMatchObject({
      status: "APPROVED",
      approval_required: false
    });
    expect(state.route_evidence).toMatchObject({
      source: "sakbe",
      km_loaded: 905.45,
      tolls_mxn: 3859
    });
    expect(state.base_quote).toMatchObject({
      pricing_model: "profitability",
      base_rate_mxn: 36574.12
    });
    expect(state.recommendation).toMatchObject({
      status: "completed",
      recommended_rate_mxn: 36574.12
    });
    expect(state.writeback_result).toMatchObject({
      status: "queued",
      quote_id: "quote-v2-RFQ-2026-000901-L01"
    });
    expect(writeback).toMatchObject({
      quote_id: "quote-v2-RFQ-2026-000901-L01",
      rfq_id: "RFQ-2026-000901",
      lane_id: "RFQ-2026-000901-L01",
      rate_mxn: 36574.12
    });
  });
});

function startApi(env: NodeJS.ProcessEnv, fetchFn: typeof fetch = fetch) {
  applyProcessEnv(env);
  const app = createQuoteOpsApi({
    defaultTools: createApplianceWorkflowTools({
      env,
      fetch: fetchFn,
      now: () => new Date("2026-06-19T18:00:00.000Z")
    })
  });

  return {
    get(path: string) {
      return directRequest(app, "GET", path);
    },
    post(path: string, body: Record<string, unknown>) {
      return directRequest(app, "POST", path, body);
    }
  };
}

async function directRequest(
  app: ReturnType<typeof createQuoteOpsApi>,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>
): Promise<{ status: number; body: Record<string, any>; text: string }> {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const socket = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    }
  });
  const req = Readable.from(payload ? [Buffer.from(payload)] : []) as unknown as IncomingMessage;
  Object.assign(req, {
    method,
    url: path,
    socket,
    connection: socket,
    httpVersion: "1.1",
    httpVersionMajor: 1,
    httpVersionMinor: 1,
    complete: true,
    headers: {
      host: "quoteops-appliance.test",
      ...(payload
        ? {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(payload))
          }
        : {})
    }
  });

  const res = new ServerResponse(req);
  res.assignSocket(socket as never);
  const chunks: Buffer[] = [];
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  res.write = ((chunk: unknown, ...args: unknown[]) => {
    if (chunk !== undefined && chunk !== null) chunks.push(Buffer.from(chunk as never));
    return originalWrite(chunk as never, ...(args as never[]));
  }) as typeof res.write;
  res.end = ((chunk?: unknown, ...args: unknown[]) => {
    if (chunk !== undefined && chunk !== null) chunks.push(Buffer.from(chunk as never));
    return originalEnd(chunk as never, ...(args as never[]));
  }) as typeof res.end;

  const finished = new Promise<void>((resolve, reject) => {
    res.once("finish", resolve);
    res.once("error", reject);
  });
  app(req, res);
  await finished;

  const text = Buffer.concat(chunks).toString("utf8");
  const contentType = String(res.getHeader("content-type") ?? "");
  return {
    status: res.statusCode,
    body:
      text && contentType.includes("application/json")
        ? (JSON.parse(text) as Record<string, any>)
        : {},
    text
  };
}

function licenseEnv(clientId: string, installationId: string): NodeJS.ProcessEnv {
  const keyPair = generateLicenseKeyPair();
  const license = createInstallationLicense({
    client_id: clientId,
    installation_id: installationId,
    release_channel: "stable",
    features: ["rfq_processing"],
    issued_at: "2026-06-01T00:00:00.000Z",
    expires_at: "2099-01-01T00:00:00.000Z",
    private_key_pem: keyPair.private_key_pem
  });

  return {
    QUOTEOPS_LICENSE_JSON: JSON.stringify(license),
    QUOTEOPS_LICENSE_PUBLIC_KEY_PEM: keyPair.public_key_pem
  };
}

function applyProcessEnv(env: NodeJS.ProcessEnv): void {
  const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  envRestores.push(() => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

const nmxHistoricalQuotesCsv = `
quote_id,rfq_id,lane_id,customer_id,origin_city,origin_state,origin_country,destination_city,destination_state,destination_country,vehicle_profile_id,equipment_request,commodity,commodity_category,sector,weight_kg,rate_mxn,direct_cost_mxn,margin_pct,quoted_at,service_type,status
QUOTE-NMX-1,RFQ-2026-000101,RFQ-2026-000101-L01,NMX-CUST-DEMO,Monterrey,Nuevo Leon,MX,Ciudad de Mexico,Ciudad de Mexico,MX,T3S3_53_DRYVAN,caja seca 53,carga general,general,industrial,18000,36000,21000,0.42,2026-03-15,cuota,won
QUOTE-NMX-2,RFQ-2026-000102,RFQ-2026-000102-L01,NMX-CUST-DEMO,Monterrey,Nuevo Leon,MX,Ciudad de Mexico,Ciudad de Mexico,MX,T3S3_53_DRYVAN,caja seca 53,carga general,general,industrial,18000,36574.12,22000,0.41,2026-04-15,cuota,won
QUOTE-NMX-3,RFQ-2026-000103,RFQ-2026-000103-L01,NMX-CUST-DEMO,Monterrey,Nuevo Leon,MX,Ciudad de Mexico,Ciudad de Mexico,MX,T3S3_53_DRYVAN,caja seca 53,carga general,general,industrial,18000,51269.8,31000,0.39,2026-05-15,cuota,won
`;

const nmxAgentConfigYaml = `
model:
  provider: openrouter
  model_name: nvidia/nemotron-3-ultra-550b-a55b:free
  temperature: 0
  api_key_env: OPENROUTER_API_KEY
authorization:
  tools:
    route.resolve:
      effect: read
      mode: allowed
    tms.searchHistorical:
      effect: read
      mode: allowed
    tms.writeQuoteResult:
      effect: write
      mode: allowed
`;

const testFetch: typeof fetch = async (url, init) => {
  const href = String(url);
  const endpoint = href.split("/").pop() || "";
  if (href.includes("openrouter.ai")) {
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "Nemotron guide: quote-core rate is within the deterministic RB policy."
            }
          }
        ]
      }),
      { headers: { "content-type": "application/json" } }
    );
  }

  const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
  if (endpoint === "buscadestino") {
    const query = body.get("buscar") || "";
    const isCdmx = query.toLowerCase().includes("ciudad");
    return jsonResponse([
      {
        id_dest: isCdmx ? "200" : "100",
        nombre: isCdmx ? "Ciudad de Mexico" : "Monterrey",
        ent_abr: isCdmx ? "CDMX" : "N.L."
      }
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
};

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    headers: { "content-type": "application/json" }
  });
}
