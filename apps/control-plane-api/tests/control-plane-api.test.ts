import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createControlPlaneApi, type ControlPlaneStore } from "../src/index";
import { createFileControlPlaneStore } from "../src/stores/fileStore";
import {
  createInMemoryTenantDataStore,
  type TenantDataStore
} from "../src/tenantData";
import {
  generateLicenseKeyPair,
  verifyInstallationLicense,
  type InstallationLicense
} from "@quoteops/shared";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("minimal control-plane API", () => {
  it("exposes a minimal health check", async () => {
    const api = await startApi();
    const health = await api.get("/api/health");

    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({
      ok: true,
      service: "quoteops-control-plane-api",
      clients: 0
    });
  });

  it("creates a client, generates an install pack and activates with a signed license", async () => {
    const keyPair = generateLicenseKeyPair();
    const api = await startApi({
      keyPair,
      tokenGenerator: () => "registration-token-1",
      now: () => new Date("2026-06-25T12:00:00.000Z")
    });

    const created = await api.post("/api/admin/clients", {
      client_id: "NMX",
      legal_name: "Autolineas NuevoMex",
      authorized_email: "ops@nmx.example"
    });
    expect(created.status).toBe(201);
    expect(created.body.client.installation.installation_id).toBe("nmx-prod-001");

    const unauthorized = await api.post("/api/onboarding/login", {
      client_id: "NMX",
      email: "outsider@example.com"
    });
    expect(unauthorized.status).toBe(403);

    const pack = await api.post("/api/admin/clients/NMX/install-pack", {});
    expect(pack.status).toBe(201);
    expect(pack.body.install_pack.registration_token).toBe("registration-token-1");
    expect(pack.body.install_pack.install_command).not.toContain("registration-token-1");

    const login = await api.post("/api/onboarding/login", {
      client_id: "NMX",
      email: "ops@nmx.example"
    });
    expect(login.status).toBe(200);
    expect(login.body.authorized).toBe(true);

    const activated = await api.post("/api/onboarding/activate", {
      client_id: "NMX",
      installation_id: "nmx-prod-001",
      email: "ops@nmx.example",
      registration_token: "registration-token-1"
    });
    expect(activated.status).toBe(200);
    expect(activated.body.client.status).toBe("active");
    verifyInstallationLicense(activated.body.license as InstallationLicense, {
      public_key_pem: keyPair.public_key_pem,
      now: "2026-06-25T12:01:00.000Z",
      expected_client_id: "NMX",
      expected_installation_id: "nmx-prod-001"
    });

    const reused = await api.post("/api/onboarding/activate", {
      client_id: "NMX",
      installation_id: "nmx-prod-001",
      email: "ops@nmx.example",
      registration_token: "registration-token-1"
    });
    expect(reused.status).toBe(403);
    expect(reused.body.error).toBe("registration_token_used");
  });

  it("fails closed on admin routes without a valid Supabase session", async () => {
    const api = await startApi();
    const unauthorized = await api.get("/api/admin/clients", null);
    expect(unauthorized.status).toBe(401);

    const disabledApi = await startApi({ verifyAdminToken: null });
    const disabled = await disabledApi.get("/api/admin/clients");
    expect(disabled.status).toBe(503);
  });

  it("serves a self-extracting installer script for a valid registration token", async () => {
    const api = await startApi({
      tokenGenerator: () => "installer-token-1",
      now: () => new Date("2026-06-25T12:00:00.000Z")
    });

    await api.post("/api/admin/clients", {
      client_id: "NMX",
      legal_name: "Autolineas NuevoMex",
      authorized_email: "ops@nmx.example"
    });
    await api.post("/api/admin/clients/NMX/install-pack", {});

    const missing = await api.getText("/api/install/unknown-token");
    expect(missing.status).toBe(404);

    const installer = await api.getText("/api/install/installer-token-1");
    expect(installer.status).toBe(200);
    expect(installer.text.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(installer.text).toContain("--client 'NMX'");
    expect(installer.text).toContain("--installation-id 'nmx-prod-001'");
    expect(installer.text).toContain("QUOTEOPS_REGISTRATION_TOKEN:?");
    // the token authorizes the download but is never embedded in the script
    expect(installer.text).not.toContain("installer-token-1");

    await api.post("/api/onboarding/activate", {
      client_id: "NMX",
      installation_id: "nmx-prod-001",
      email: "ops@nmx.example",
      registration_token: "installer-token-1"
    });
    const used = await api.getText("/api/install/installer-token-1");
    expect(used.status).toBe(403);
  });

  it("does not issue a license to a suspended client", async () => {
    const api = await startApi({
      tokenGenerator: () => "registration-token-2",
      now: () => new Date("2026-06-25T12:00:00.000Z")
    });
    await api.post("/api/admin/clients", {
      client_id: "SUSP",
      legal_name: "Suspended Client",
      authorized_email: "ops@susp.example"
    });
    await api.post("/api/admin/clients/SUSP/install-pack", {});
    await api.post("/api/admin/clients/SUSP/suspend", {});

    const activated = await api.post("/api/onboarding/activate", {
      client_id: "SUSP",
      installation_id: "susp-prod-001",
      email: "ops@susp.example",
      registration_token: "registration-token-2"
    });

    expect(activated.status).toBe(403);
    expect(activated.body.error).toBe("client_not_active");
  });

  it("rejects expired registration tokens", async () => {
    let currentNow = new Date("2026-06-25T12:00:00.000Z");
    const api = await startApi({
      tokenGenerator: () => "registration-token-expired",
      tokenTtlMinutes: 1,
      now: () => currentNow
    });
    await api.post("/api/admin/clients", {
      client_id: "EXP",
      legal_name: "Expired Token Client",
      authorized_email: "ops@exp.example"
    });
    await api.post("/api/admin/clients/EXP/install-pack", {});
    currentNow = new Date("2026-06-25T12:02:00.000Z");

    const activated = await api.post("/api/onboarding/activate", {
      client_id: "EXP",
      installation_id: "exp-prod-001",
      email: "ops@exp.example",
      registration_token: "registration-token-expired"
    });

    expect(activated.status).toBe(403);
    expect(activated.body.error).toBe("registration_token_expired");
  });

  it("updates heartbeat and aggregate counters without accepting detail fields", async () => {
    const api = await startApi({
      now: () => new Date("2026-06-25T12:10:00.000Z")
    });
    await api.post("/api/admin/clients", {
      client_id: "CNT",
      legal_name: "Counters Client",
      authorized_email: "ops@cnt.example"
    });

    const heartbeat = await api.post("/api/installations/cnt-prod-001/heartbeat", {
      client_id: "CNT",
      ai_key_status: "configured",
      onboarding_status: "waiting_local_secrets"
    });
    expect(heartbeat.status).toBe(202);
    expect(heartbeat.body.client.installation.last_heartbeat_at).toBe("2026-06-25T12:10:00.000Z");
    expect(heartbeat.body.client.installation.ai_key_status).toBe("configured");

    const counters = await api.post("/api/installations/cnt-prod-001/counters", {
      client_id: "CNT",
      total: 5,
      validated: 3,
      rejected: 1,
      pending: 1,
      failed: 0
    });
    expect(counters.status).toBe(202);
    expect(counters.body.client.counters).toEqual({
      total: 5,
      validated: 3,
      rejected: 1,
      pending: 1,
      failed: 0
    });

    const secretLeak = await api.post("/api/installations/cnt-prod-001/heartbeat", {
      client_id: "CNT",
      ai_key_status: "configured",
      ai_api_key: "sk-test"
    });
    expect(secretLeak.status).toBe(400);

    const rfqLeak = await api.post("/api/installations/cnt-prod-001/counters", {
      client_id: "CNT",
      total: 5,
      validated: 3,
      rejected: 1,
      pending: 1,
      failed: 0,
      raw_rfq: { requester_email: "cliente@example.com" }
    });
    expect(rfqLeak.status).toBe(400);
  });

  it("ingests a strict aggregate sentinel report for the token tenant", async () => {
    const tenantData = createInMemoryTenantDataStore({
      tokens: [{ token: "installation-token", tenant_id: "tenant-a" }]
    });
    const api = await startApi({ tenantData });

    const accepted = await api.post(
      "/api/sentinel/reports",
      {
        installation_id: "tenant-a-prod-001",
        week_start: "2026-07-06",
        body_md: "# Weekly sentinel\n\nNo operational details.",
        stats: { runs: 12, errors: 1, interrupts: 2, avg_node_ms: 145.5 }
      },
      "Bearer installation-token"
    );

    expect(accepted.status).toBe(201);
    expect(tenantData.sentinelReports).toEqual([
      {
        tenant_id: "tenant-a",
        installation_id: "tenant-a-prod-001",
        week_start: "2026-07-06",
        body_md: "# Weekly sentinel\n\nNo operational details.",
        stats: { runs: 12, errors: 1, interrupts: 2, avg_node_ms: 145.5 },
        status: "new"
      }
    ]);

    const unauthorized = await api.post(
      "/api/sentinel/reports",
      {
        installation_id: "tenant-a-prod-001",
        week_start: "2026-07-06",
        body_md: "# Weekly sentinel",
        stats: { runs: 1, errors: 0, interrupts: 0, avg_node_ms: 10 }
      },
      "Bearer wrong-token"
    );
    expect(unauthorized.status).toBe(401);

    const detailLeak = await api.post(
      "/api/sentinel/reports",
      {
        installation_id: "tenant-a-prod-001",
        week_start: "2026-07-06",
        body_md: "# Weekly sentinel",
        stats: {
          runs: 1,
          errors: 0,
          interrupts: 0,
          avg_node_ms: 10,
          customer_email: "customer@example.com"
        }
      },
      "Bearer installation-token"
    );
    expect(detailLeak.status).toBe(400);
  });

  it("upserts strict daily aggregate usage without duplicating retries", async () => {
    const tenantData = createInMemoryTenantDataStore({
      tokens: [{ token: "usage-token", tenant_id: "tenant-b" }]
    });
    const api = await startApi({ tenantData });

    const first = await api.post(
      "/api/usage",
      { day: "2026-07-12", channel: "email", quotes: 5, routes: 8 },
      "Bearer usage-token"
    );
    const retry = await api.post(
      "/api/usage",
      { day: "2026-07-12", channel: "email", quotes: 5, routes: 8 },
      "Bearer usage-token"
    );

    expect(first.status).toBe(202);
    expect(retry.status).toBe(202);
    expect(tenantData.usageEvents.get("tenant-b|2026-07-12|email")).toMatchObject({
      quotes: 5,
      routes: 8
    });

    const detailLeak = await api.post(
      "/api/usage",
      {
        day: "2026-07-12",
        channel: "email",
        quotes: 5,
        routes: 8,
        route: { origin: "MTY", destination: "QRO" }
      },
      "Bearer usage-token"
    );
    expect(detailLeak.status).toBe(400);
  });

  it("returns the latest release and only allowlisted heartbeat settings", async () => {
    const tenantData = createInMemoryTenantDataStore({
      tokens: [{ token: "release-token", tenant_id: "tenant-c" }],
      installations: [
        {
          tenant_id: "tenant-c",
          installation_id: "sync-prod-001",
          settings: {
            pricing_model: "profitability",
            pdf_template: "compact-v2",
            customer_detail: { name: "must-not-leak" }
          }
        }
      ],
      releases: [
        { version: "v1.9.0", notes: "Previous" },
        { version: "v1.10.0", notes: "Current" }
      ]
    });
    const api = await startApi({
      tenantData,
      now: () => new Date("2026-07-12T15:00:00.000Z")
    });
    await api.post("/api/admin/clients", {
      client_id: "SYNC",
      legal_name: "Sync Client",
      authorized_email: "ops@sync.example"
    });

    const heartbeat = await api.post("/api/installations/sync-prod-001/heartbeat", {
      client_id: "SYNC",
      ai_key_status: "configured",
      version: "v1.8.0"
    });
    expect(heartbeat.status).toBe(202);
    expect(heartbeat.body).toMatchObject({
      latest_version: "v1.10.0",
      settings: { pricing_model: "profitability", pdf_template: "compact-v2" }
    });
    expect(heartbeat.body.settings).not.toHaveProperty("customer_detail");
    expect(tenantData.installations.get("sync-prod-001")).toMatchObject({
      version: "v1.8.0",
      last_heartbeat_at: "2026-07-12T15:00:00.000Z"
    });

    const latest = await api.get("/api/releases/latest", "Bearer release-token");
    expect(latest.status).toBe(200);
    expect(latest.body).toEqual({ version: "v1.10.0", notes: "Current" });

    const anonymous = await api.get("/api/releases/latest", null);
    expect(anonymous.status).toBe(401);
  });

  it("persists clients and registration tokens in the file store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quoteops-control-plane-store-"));
    tempDirs.push(dir);
    const storePath = join(dir, "store.json");
    const firstStore = createFileControlPlaneStore(storePath);
    const firstApi = await startApi({
      store: firstStore,
      tokenGenerator: () => "file-store-token",
      now: () => new Date("2026-06-25T12:00:00.000Z")
    });

    await firstApi.post("/api/admin/clients", {
      client_id: "FILE",
      legal_name: "File Store Client",
      authorized_email: "ops@file.example"
    });
    await firstApi.post("/api/admin/clients/FILE/install-pack", {});
    const secondStore = createFileControlPlaneStore(storePath);
    const secondApi = await startApi({
      store: secondStore,
      now: () => new Date("2026-06-25T12:01:00.000Z")
    });
    const login = await secondApi.post("/api/onboarding/login", {
      client_id: "FILE",
      email: "ops@file.example"
    });
    const activated = await secondApi.post("/api/onboarding/activate", {
      client_id: "FILE",
      installation_id: "file-prod-001",
      email: "ops@file.example",
      registration_token: "file-store-token"
    });

    expect(login.status).toBe(200);
    expect(activated.status).toBe(200);
  });
});

describe("Supabase control-plane migration", () => {
  it("enables RLS on every table with tenant and vendor-admin policies but no anon policy", async () => {
    const sql = await readFile(
      new URL("../../../supabase/migrations/0001_control_plane.sql", import.meta.url),
      "utf8"
    );
    const tables = [
      "tenants",
      "profiles",
      "installations",
      "registration_tokens",
      "credentials",
      "usage_events",
      "sentinel_reports",
      "releases"
    ];

    for (const table of tables) {
      expect(sql).toContain(`alter table public.${table} enable row level security;`);
      expect(sql).toMatch(new RegExp(`create policy ${table}_[\\s\\S]*?to authenticated`, "i"));
      expect(sql).toMatch(new RegExp(`create policy ${table}_vendor_all`, "i"));
    }
    expect(sql).toContain("where p.user_id = auth.uid() and p.role = 'vendor_admin'");
    expect(sql).toContain("create policy releases_authenticated_select");
    expect(sql).not.toMatch(/\bto\s+anon\b/i);
  });
});

const TEST_ADMIN_TOKEN = "test-admin-token";

async function startApi(options: {
  verifyAdminToken?: ((token: string) => Promise<string | null>) | null;
  keyPair?: ReturnType<typeof generateLicenseKeyPair>;
  now?: () => Date;
  tokenGenerator?: () => string;
  tokenTtlMinutes?: number;
  store?: ControlPlaneStore;
  tenantData?: TenantDataStore | null;
} = {}) {
  const app = createControlPlaneApi({
    controlPlaneUrl: "https://quoteops-control-plane-staging.vercel.app",
    verifyAdminToken: async (token) => (token === TEST_ADMIN_TOKEN ? "ops@e2e.example" : null),
    ...options
  });

  return {
    get(path: string, authorization: string | null = `Bearer ${TEST_ADMIN_TOKEN}`) {
      return directRequest(app, "GET", path, undefined, authorization);
    },
    post(
      path: string,
      body: Record<string, unknown>,
      authorization: string | null = `Bearer ${TEST_ADMIN_TOKEN}`
    ) {
      return directRequest(app, "POST", path, body, authorization);
    },
    async getText(path: string) {
      const response = await directRequest(app, "GET", path, undefined, null);
      return { status: response.status, text: response.text };
    }
  };
}

async function directRequest(
  app: ReturnType<typeof createControlPlaneApi>,
  method: "GET" | "POST",
  path: string,
  body: Record<string, unknown> | undefined,
  authorization: string | null
): Promise<{ status: number; body: Record<string, any>; text: string }> {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const socket = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    }
  });
  const req = new IncomingMessage(socket as never);
  req.method = method;
  req.url = path;
  req.headers = {
    host: "quoteops-control-plane-staging.vercel.app",
    ...(payload
      ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) }
      : {}),
    ...(authorization ? { authorization } : {})
  };

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
  if (payload) req.push(payload);
  req.push(null);
  await finished;

  const text = Buffer.concat(chunks).toString("utf8");
  return {
    status: res.statusCode,
    body: text ? (JSON.parse(text) as Record<string, any>) : {},
    text
  };
}
