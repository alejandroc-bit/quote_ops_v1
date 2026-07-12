import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInstallationLicense, generateLicenseKeyPair } from "@quoteops/shared";
import { createQuoteOpsApi } from "../src/index.js";
import { createInMemoryQuoteOpsStore } from "../src/storage/InMemoryQuoteOpsStore.js";

const licenseKeys = [
  "QUOTEOPS_CLIENT_ID",
  "QUOTEOPS_INSTALLATION_ID",
  "QUOTEOPS_LICENSE_JSON",
  "QUOTEOPS_LICENSE_PUBLIC_KEY_PEM",
  "QUOTEOPS_LICENSE_PATH",
  "QUOTEOPS_LICENSE_PUBLIC_KEY_PATH"
] as const;
const originalLicenseEnv = Object.fromEntries(licenseKeys.map((key) => [key, process.env[key]]));

beforeAll(() => installValidLicense());
afterAll(() => {
  for (const key of licenseKeys) {
    const value = originalLicenseEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("traced run API", () => {
  it("lists runs, returns run plus steps, and streams named step/done SSE events", async () => {
    const store = createInMemoryQuoteOpsStore();
    await store.createRun({ run_id: "run-api-1", channel: "email", status: "running", summary: "start" });
    await store.appendStep({
      run_id: "run-api-1",
      seq: 1,
      node: "classify",
      status: "end",
      summary: "classified",
      ts: "2026-07-12T12:00:00.000Z"
    });
    await store.updateRunStatus("run-api-1", "done", "complete");
    const app = createQuoteOpsApi({ store });
    const list = JSON.parse((await dispatch(app, "GET", "/api/runs?limit=1")).body);
    const detail = JSON.parse((await dispatch(app, "GET", "/api/runs/run-api-1")).body);
    const stream = (await dispatch(app, "GET", "/api/runs/run-api-1/stream")).body;

    expect(list.runs).toHaveLength(1);
    expect(detail).toMatchObject({
      run: { run_id: "run-api-1", status: "done" },
      steps: [{ seq: 1, node: "classify", status: "end" }]
    });
    expect(stream).toContain("event: step\n");
    expect(stream).toContain('data: {"run_id":"run-api-1"');
    expect(stream).toContain("event: done\n");
  });

  it("resumes a new-graph interrupted run while keeping the decision contract", async () => {
    const store = createInMemoryQuoteOpsStore();
    await store.createRun({
      run_id: "run-api-review",
      channel: "email",
      status: "waiting_approval",
      summary: "review"
    });
    const resumed: unknown[] = [];
    const app = createQuoteOpsApi({ store, graphRuntime: {
      resume: async (runId, decision) => {
        resumed.push({ runId, decision });
        await store.updateRunStatus(runId, "done", "approved");
        return { run_id: runId, response_sent: true } as never;
      }
    }});

    const response = await dispatch(
      app,
      "POST",
      "/api/approvals/run-api-review/decision",
      { action: "approve" }
    );
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(resumed).toEqual([
      { runId: "run-api-review", decision: { action: "approve" } }
    ]);
    expect(body).toMatchObject({
      run_id: "run-api-review",
      approval_decision: { action: "approve", email_sent: false },
      response_sent: true
    });
  });

  it("blocks new-graph approval resume when the appliance license is missing", async () => {
    const previous = process.env.QUOTEOPS_LICENSE_JSON;
    delete process.env.QUOTEOPS_LICENSE_JSON;
    process.env.QUOTEOPS_LICENSE_PATH = "/tmp/quoteops-review-missing-license.json";
    const store = createInMemoryQuoteOpsStore();
    await store.createRun({
      run_id: "run-api-unlicensed",
      channel: "email",
      status: "waiting_approval",
      summary: "review"
    });
    let resumes = 0;
    const app = createQuoteOpsApi({
      store,
      graphRuntime: {
        resume: async () => { resumes += 1; return {} as never; }
      }
    });

    const response = await dispatch(app, "POST", "/api/approvals/run-api-unlicensed/decision", {
      action: "approve"
    });

    expect(response.statusCode).toBe(423);
    expect(JSON.parse(response.body)).toMatchObject({ error: "appliance_locked" });
    expect(resumes).toBe(0);
    if (previous === undefined) delete process.env.QUOTEOPS_LICENSE_JSON;
    else process.env.QUOTEOPS_LICENSE_JSON = previous;
    installValidLicense();
  });

  it("refuses to resume a new-graph run that is not waiting for approval", async () => {
    const store = createInMemoryQuoteOpsStore();
    await store.createRun({
      run_id: "run-api-running",
      channel: "email",
      status: "running",
      summary: "running"
    });
    let resumes = 0;
    const app = createQuoteOpsApi({
      store,
      graphRuntime: {
        resume: async () => { resumes += 1; return {} as never; }
      }
    });

    const response = await dispatch(app, "POST", "/api/approvals/run-api-running/decision", {
      action: "approve"
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toEqual({ error: "run_not_waiting_approval" });
    expect(resumes).toBe(0);
  });

  it("atomically rejects a duplicate approval before repeating graph side effects", async () => {
    const store = createInMemoryQuoteOpsStore();
    await store.createRun({
      run_id: "run-api-duplicate",
      channel: "email",
      status: "waiting_approval",
      summary: "review"
    });
    let resumes = 0;
    const app = createQuoteOpsApi({
      store,
      graphRuntime: {
        resume: async (runId) => {
          resumes += 1;
          await store.updateRunStatus(runId, "done", "sent");
          return { run_id: runId, response_sent: true } as never;
        }
      }
    });

    const first = await dispatch(app, "POST", "/api/approvals/run-api-duplicate/decision", {
      action: "approve"
    });
    const duplicate = await dispatch(app, "POST", "/api/approvals/run-api-duplicate/decision", {
      action: "approve"
    });

    expect(first.statusCode).toBe(200);
    expect(duplicate.statusCode).toBe(409);
    expect(resumes).toBe(1);
  });
});

function installValidLicense(): void {
  const keys = generateLicenseKeyPair();
  process.env.QUOTEOPS_CLIENT_ID = "NMX";
  process.env.QUOTEOPS_INSTALLATION_ID = "nmx-install-001";
  process.env.QUOTEOPS_LICENSE_JSON = JSON.stringify(
    createInstallationLicense({
      client_id: "NMX",
      installation_id: "nmx-install-001",
      release_channel: "stable",
      features: ["quotes"],
      issued_at: "2026-01-01T00:00:00.000Z",
      expires_at: "2030-01-01T00:00:00.000Z",
      private_key_pem: keys.private_key_pem
    })
  );
  process.env.QUOTEOPS_LICENSE_PUBLIC_KEY_PEM = keys.public_key_pem;
  delete process.env.QUOTEOPS_LICENSE_PATH;
  delete process.env.QUOTEOPS_LICENSE_PUBLIC_KEY_PATH;
}

async function dispatch(
  app: ReturnType<typeof createQuoteOpsApi>,
  method: string,
  url: string,
  json?: unknown
): Promise<{ statusCode: number; body: string }> {
  const raw = json === undefined ? "" : JSON.stringify(json);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []) as Readable & Record<string, unknown>;
  req.method = method;
  req.url = url;
  req.headers = raw
    ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(raw)) }
    : {};
  (req as Record<string, unknown>).connection = {};
  (req as Record<string, unknown>).socket = {};

  const headers = new Map<string, unknown>();
  const chunks: Buffer[] = [];
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const res = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), value); },
    getHeader(name: string) { return headers.get(name.toLowerCase()); },
    getHeaders() { return Object.fromEntries(headers); },
    removeHeader(name: string) { headers.delete(name.toLowerCase()); },
    writeHead(statusCode: number) { this.statusCode = statusCode; this.headersSent = true; return this; },
    flushHeaders() { this.headersSent = true; },
    write(chunk: unknown) { chunks.push(Buffer.from(String(chunk))); return true; },
    end(chunk?: unknown) {
      if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      this.writableEnded = true;
      resolveDone();
      return this;
    },
    on() { return this; },
    once() { return this; },
    emit() { return true; }
  } as unknown as import("node:http").ServerResponse;

  app.handle(req as never, res as never);
  await done;
  return { statusCode: res.statusCode, body: Buffer.concat(chunks).toString("utf8") };
}
