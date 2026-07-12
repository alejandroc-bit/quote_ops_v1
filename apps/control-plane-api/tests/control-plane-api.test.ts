import { type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createControlPlaneApi, type ControlPlaneStore } from "../src/index";
import { createFileControlPlaneStore } from "../src/stores/fileStore";
import {
  generateLicenseKeyPair,
  verifyInstallationLicense,
  type InstallationLicense
} from "@quoteops/shared";

let server: Server | null = null;
const tempDirs: string[] = [];

afterEach(async () => {
  await closeActiveServer();
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
    const unauthorized = await fetch(`${api.baseUrl}/api/admin/clients`);
    expect(unauthorized.status).toBe(401);

    await closeActiveServer();
    const disabledApi = await startApi({ verifyAdminToken: null });
    const disabled = await fetch(`${disabledApi.baseUrl}/api/admin/clients`, {
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` }
    });
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
    await closeActiveServer();

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

const TEST_ADMIN_TOKEN = "test-admin-token";

async function startApi(options: {
  verifyAdminToken?: ((token: string) => Promise<string | null>) | null;
  keyPair?: ReturnType<typeof generateLicenseKeyPair>;
  now?: () => Date;
  tokenGenerator?: () => string;
  tokenTtlMinutes?: number;
  store?: ControlPlaneStore;
} = {}) {
  const app = createControlPlaneApi({
    controlPlaneUrl: "https://quoteops-control-plane-staging.vercel.app",
    verifyAdminToken: async (token) => (token === TEST_ADMIN_TOKEN ? "ops@e2e.example" : null),
    ...options
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server?.once("listening", resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    get(path: string) {
      return jsonRequest(baseUrl, path);
    },
    post(path: string, body: Record<string, unknown>) {
      return jsonRequest(baseUrl, path, body);
    },
    async getText(path: string) {
      const response = await fetch(`${baseUrl}${path}`);
      return { status: response.status, text: await response.text() };
    }
  };
}

async function closeActiveServer(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server?.close((error) => (error ? reject(error) : resolve()));
  });
  server = null;
}

async function jsonRequest(
  baseUrl: string,
  path: string,
  body?: Record<string, unknown>
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TEST_ADMIN_TOKEN}`
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>
  };
}
