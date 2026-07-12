import { type IncomingMessage, ServerResponse } from "node:http";
import { Duplex, Readable } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createControlPlaneApi,
  createInMemoryControlPlaneStore,
  type ControlPlaneStore
} from "../src/index";
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
import { createMinimalClientRecord } from "@quoteops/control-plane";

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

  it("claims portal profiles from verified session email without client-selected role or tenant", async () => {
    const tenantData = createInMemoryTenantDataStore();
    const sessions = new Map([
      ["owner-session", { user_id: "user-owner", email: "owner@claim.example" }],
      ["vendor-session", { user_id: "user-vendor", email: "vendor@inducta.example" }],
      ["unknown-session", { user_id: "user-unknown", email: "unknown@example.com" }],
      ["escalation-session", { user_id: "user-owner", email: "vendor@inducta.example" }]
    ]);
    const api = await startApi({
      tenantData,
      verifySessionToken: async (token) => sessions.get(token) ?? null,
      isVendorAdminEmail: (email) => email === "vendor@inducta.example"
    });
    await api.post("/api/admin/clients", {
      client_id: "CLAIM",
      legal_name: "Claim Client",
      authorized_email: "Owner@Claim.Example"
    });

    const owner = await api.post("/api/portal/profile/claim", {}, "Bearer owner-session");
    expect(owner.status).toBe(200);
    expect(owner.body.profile).toMatchObject({
      user_id: "user-owner",
      role: "owner"
    });
    expect(owner.body.profile.tenant_id).toBeTruthy();

    const repeated = await api.post("/api/portal/profile/claim", {}, "Bearer owner-session");
    expect(repeated.status).toBe(200);
    expect(repeated.body.profile).toEqual(owner.body.profile);

    const vendor = await api.post("/api/portal/profile/claim", {}, "Bearer vendor-session");
    expect(vendor.status).toBe(200);
    expect(vendor.body.profile).toEqual({
      user_id: "user-vendor",
      tenant_id: null,
      role: "vendor_admin"
    });

    const unknown = await api.post("/api/portal/profile/claim", {}, "Bearer unknown-session");
    expect(unknown.status).toBe(403);
    expect(unknown.body.error).toBe("portal_profile_forbidden");

    const escalation = await api.post(
      "/api/portal/profile/claim",
      { role: "vendor_admin", tenant_id: null },
      "Bearer escalation-session"
    );
    expect(escalation.status).toBe(400);
    const unchanged = await api.post(
      "/api/portal/profile/claim",
      {},
      "Bearer escalation-session"
    );
    expect(unchanged.status).toBe(403);
    expect(tenantData.profiles.has("user-owner")).toBe(false);
  });

  it("revokes stale portal profiles when live email or role authority changes", async () => {
    const tenantData = createInMemoryTenantDataStore();
    const vendorEmails = new Set([
      "vendor@inducta.example",
      "vendor-one@inducta.example",
      "vendor-two@inducta.example",
      "switch@inducta.example"
    ]);
    const sessions = new Map([
      ["vendor-session", { user_id: "vendor-user", email: "vendor@inducta.example" }],
      ["vendor-email-session", { user_id: "vendor-email-user", email: "vendor-one@inducta.example" }],
      ["owner-session", { user_id: "owner-user", email: "owner@revoke.example" }],
      ["email-change-session", { user_id: "email-user", email: "stable@revoke.example" }],
      ["same-tenant-email-session", { user_id: "same-tenant-user", email: "original@same.example" }],
      ["switch-session", { user_id: "switch-user", email: "switch@inducta.example" }]
    ]);
    const api = await startApi({
      tenantData,
      verifySessionToken: async (token) => sessions.get(token) ?? null,
      isVendorAdminEmail: (email) => vendorEmails.has(email)
    });
    for (const client of [
      ["REVOKE", "owner@revoke.example"],
      ["STABLE", "stable@revoke.example"],
      ["SWITCH", "switch-owner@revoke.example"]
      , ["SAME", "original@same.example"]
    ] as const) {
      await api.post("/api/admin/clients", {
        client_id: client[0],
        legal_name: `${client[0]} Client`,
        authorized_email: client[1]
      });
    }

    expect((await api.post("/api/portal/profile/claim", {}, "Bearer vendor-session")).status).toBe(200);
    vendorEmails.delete("vendor@inducta.example");
    expect((await api.post("/api/portal/profile/claim", {}, "Bearer vendor-session")).status).toBe(403);
    expect(tenantData.profiles.has("vendor-user")).toBe(false);

    expect((await api.post("/api/portal/profile/claim", {}, "Bearer vendor-email-session")).status).toBe(200);
    sessions.set("vendor-email-session", {
      user_id: "vendor-email-user",
      email: "vendor-two@inducta.example"
    });
    expect((await api.post("/api/portal/profile/claim", {}, "Bearer vendor-email-session")).status).toBe(403);

    expect((await api.post("/api/portal/profile/claim", {}, "Bearer owner-session")).status).toBe(200);
    await api.post("/api/admin/clients", {
      client_id: "REVOKE",
      legal_name: "REVOKE Client",
      authorized_email: "replacement@revoke.example"
    });
    expect((await api.post("/api/portal/profile/claim", {}, "Bearer owner-session")).status).toBe(403);
    expect(tenantData.profiles.has("owner-user")).toBe(false);

    expect((await api.post("/api/portal/profile/claim", {}, "Bearer email-change-session")).status).toBe(200);
    sessions.set("email-change-session", { user_id: "email-user", email: "changed@example.com" });
    expect((await api.post("/api/portal/profile/claim", {}, "Bearer email-change-session")).status).toBe(403);
    expect(tenantData.profiles.has("email-user")).toBe(false);

    expect((await api.post("/api/portal/profile/claim", {}, "Bearer same-tenant-email-session")).status).toBe(200);
    await api.post("/api/admin/clients", {
      client_id: "SAME",
      legal_name: "SAME Client",
      authorized_email: "replacement@same.example"
    });
    sessions.set("same-tenant-email-session", {
      user_id: "same-tenant-user",
      email: "replacement@same.example"
    });
    expect((await api.post("/api/portal/profile/claim", {}, "Bearer same-tenant-email-session")).status).toBe(403);

    expect((await api.post("/api/portal/profile/claim", {}, "Bearer switch-session")).status).toBe(200);
    vendorEmails.delete("switch@inducta.example");
    sessions.set("switch-session", { user_id: "switch-user", email: "switch-owner@revoke.example" });
    const vendorToOwner = await api.post("/api/portal/profile/claim", {}, "Bearer switch-session");
    expect(vendorToOwner.status).toBe(403);
    expect(tenantData.profiles.has("switch-user")).toBe(false);
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

  it.each(["client_licensed", "tenant_token_used", "legacy_token_used"] as const)(
    "retries activation after a %s persistence failure without reissuing the install pack",
    async (failureBoundary) => {
      const baseStore = createInMemoryControlPlaneStore();
      const baseTenantData = createInMemoryTenantDataStore();
      let failurePending = true;
      const store: ControlPlaneStore = {
        ...baseStore,
        upsertClient(client) {
          if (failurePending && failureBoundary === "client_licensed" && client.status === "active") {
            failurePending = false;
            throw new Error("injected_client_persistence_failure");
          }
          return baseStore.upsertClient(client);
        },
        updateRegistrationToken(token) {
          if (failurePending && failureBoundary === "legacy_token_used") {
            failurePending = false;
            throw new Error("injected_legacy_token_failure");
          }
          return baseStore.updateRegistrationToken(token);
        }
      };
      const tenantData: TenantDataStore = {
        ...baseTenantData,
        markRegistrationTokenUsed(token, usedAt) {
          if (failurePending && failureBoundary === "tenant_token_used") {
            failurePending = false;
            throw new Error("injected_tenant_token_failure");
          }
          return baseTenantData.markRegistrationTokenUsed(token, usedAt);
        }
      };
      const api = await startApi({
        store,
        tenantData,
        tokenGenerator: () => `retry-${failureBoundary}`,
        now: () => new Date("2026-07-12T15:00:00.000Z")
      });
      await api.post("/api/admin/clients", {
        client_id: "RETRY",
        legal_name: "Retry Client",
        authorized_email: "ops@retry.example"
      });
      await api.post("/api/admin/clients/RETRY/install-pack", {});
      const activationBody = {
        client_id: "RETRY",
        installation_id: "retry-prod-001",
        email: "ops@retry.example",
        registration_token: `retry-${failureBoundary}`
      };

      const first = await api.post("/api/onboarding/activate", activationBody);
      const retry = await api.post("/api/onboarding/activate", activationBody);

      expect(first.status).toBe(500);
      expect(retry.status).toBe(200);
      expect(retry.body.activated).toBe(true);
    }
  );

  it("updates heartbeat and aggregate counters without accepting detail fields", async () => {
    const tenantData = createInMemoryTenantDataStore();
    const api = await startApi({
      tenantData,
      tokenGenerator: () => "counters-installation-token",
      now: () => new Date("2026-06-25T12:10:00.000Z")
    });
    await api.post("/api/admin/clients", {
      client_id: "CNT",
      legal_name: "Counters Client",
      authorized_email: "ops@cnt.example"
    });
    await api.post("/api/admin/clients/CNT/install-pack", {});
    await api.post("/api/onboarding/activate", {
      client_id: "CNT",
      installation_id: "cnt-prod-001",
      email: "ops@cnt.example",
      registration_token: "counters-installation-token"
    });

    const heartbeat = await api.post(
      "/api/installations/cnt-prod-001/heartbeat",
      {
        client_id: "CNT",
        ai_key_status: "configured",
        onboarding_status: "waiting_local_secrets"
      },
      "Bearer counters-installation-token"
    );
    expect(heartbeat.status).toBe(202);
    expect(heartbeat.body.client.installation.last_heartbeat_at).toBe("2026-06-25T12:10:00.000Z");
    expect(heartbeat.body.client.installation.ai_key_status).toBe("configured");

    const counters = await api.post(
      "/api/installations/cnt-prod-001/counters",
      {
        client_id: "CNT",
        total: 5,
        validated: 3,
        rejected: 1,
        pending: 1,
        failed: 0
      },
      "Bearer counters-installation-token"
    );
    expect(counters.status).toBe(202);
    expect(counters.body.client.counters).toEqual({
      total: 5,
      validated: 3,
      rejected: 1,
      pending: 1,
      failed: 0
    });

    const secretLeak = await api.post(
      "/api/installations/cnt-prod-001/heartbeat",
      {
        client_id: "CNT",
        ai_key_status: "configured",
        ai_api_key: "sk-test"
      },
      "Bearer counters-installation-token"
    );
    expect(secretLeak.status).toBe(400);

    const rfqLeak = await api.post(
      "/api/installations/cnt-prod-001/counters",
      {
        client_id: "CNT",
        total: 5,
        validated: 3,
        rejected: 1,
        pending: 1,
        failed: 0,
        raw_rfq: { requester_email: "cliente@example.com" }
      },
      "Bearer counters-installation-token"
    );
    expect(rfqLeak.status).toBe(400);

    const anonymous = await api.post("/api/installations/cnt-prod-001/heartbeat", {
      client_id: "CNT",
      ai_key_status: "configured"
    }, null);
    expect(anonymous.status).toBe(401);

    const wrongToken = await api.post("/api/installations/cnt-prod-001/counters", {
      client_id: "CNT",
      total: 5,
      validated: 3,
      rejected: 1,
      pending: 1,
      failed: 0
    }, "Bearer wrong-token");
    expect(wrongToken.status).toBe(401);

    const wrongInstallation = await api.post("/api/installations/other-prod-001/heartbeat", {
      client_id: "CNT",
      ai_key_status: "configured"
    }, "Bearer counters-installation-token");
    expect(wrongInstallation.status).toBe(403);
  });

  it("uses the activated install-pack token as the bound credential for every ingest endpoint", async () => {
    const tenantData = createInMemoryTenantDataStore({
      releases: [{ version: "v1.2.0", notes: "Stable" }]
    });
    const api = await startApi({
      tenantData,
      tokenGenerator: () => "issued-appliance-token",
      now: () => new Date("2026-07-12T15:00:00.000Z")
    });

    await api.post("/api/admin/clients", {
      client_id: "AUTH",
      legal_name: "Authenticated Appliance",
      authorized_email: "ops@auth.example"
    });
    await api.post("/api/admin/clients/AUTH/install-pack", {});
    const activated = await api.post("/api/onboarding/activate", {
      client_id: "AUTH",
      installation_id: "auth-prod-001",
      email: "ops@auth.example",
      registration_token: "issued-appliance-token"
    });
    expect(activated.status).toBe(200);

    const authorization = "Bearer issued-appliance-token";
    const heartbeat = await api.post("/api/installations/auth-prod-001/heartbeat", {
      client_id: "AUTH",
      ai_key_status: "configured",
      version: "v1.1.0"
    }, authorization);
    const counters = await api.post("/api/installations/auth-prod-001/counters", {
      client_id: "AUTH",
      total: 1,
      validated: 1,
      rejected: 0,
      pending: 0,
      failed: 0
    }, authorization);
    const sentinel = await api.post("/api/sentinel/reports", {
      installation_id: "auth-prod-001",
      week_start: "2026-07-06",
      body_md: "# Estado estable",
      stats: { runs: 1, errors: 0, interrupts: 0, avg_node_ms: 20 }
    }, authorization);
    const usage = await api.post("/api/usage", {
      day: "2026-07-12",
      channel: "email",
      quotes: 1,
      routes: 1
    }, authorization);
    const release = await api.get("/api/releases/latest", authorization);

    expect([heartbeat.status, counters.status, sentinel.status, usage.status, release.status])
      .toEqual([202, 202, 201, 202, 200]);
    expect(heartbeat.body.latest_version).toBe("v1.2.0");

    const wrongInstallation = await api.post("/api/sentinel/reports", {
      installation_id: "other-prod-001",
      week_start: "2026-07-06",
      body_md: "# Estado estable",
      stats: { runs: 1, errors: 0, interrupts: 0, avg_node_ms: 20 }
    }, authorization);
    expect(wrongInstallation.status).toBe(403);
  });

  it("keeps legacy file/in-memory auth working while tenant-table ingests fail explicitly", async () => {
    const api = await startApi({
      tenantData: null,
      tokenGenerator: () => "legacy-appliance-token",
      now: () => new Date("2026-07-12T15:00:00.000Z")
    });
    await api.post("/api/admin/clients", {
      client_id: "LEGACY",
      legal_name: "Legacy Store Client",
      authorized_email: "ops@legacy.example"
    });
    await api.post("/api/admin/clients/LEGACY/install-pack", {});

    const heartbeat = await api.post(
      "/api/installations/legacy-prod-001/heartbeat",
      { client_id: "LEGACY", ai_key_status: "configured", version: "v1.0.0" },
      "Bearer legacy-appliance-token"
    );
    const sentinel = await api.post(
      "/api/sentinel/reports",
      {
        installation_id: "legacy-prod-001",
        week_start: "2026-07-06",
        body_md: "# Sin tenant tables",
        stats: { runs: 1, errors: 0, interrupts: 0, avg_node_ms: 5 }
      },
      "Bearer legacy-appliance-token"
    );

    expect(heartbeat.status).toBe(202);
    expect(sentinel.status).toBe(503);
    expect(sentinel.body.error).toBe("tenant_data_unavailable");
  });

  it("rejects a token whose tenant and installation pair is internally inconsistent", async () => {
    const client = createMinimalClientRecord({
      client_id: "MISMATCH",
      legal_name: "Mismatch Client",
      authorized_email: "ops@mismatch.example",
      created_at: "2026-07-12T00:00:00.000Z",
      status: "active"
    });
    const store = createInMemoryControlPlaneStore([client]);
    const tenantData = createInMemoryTenantDataStore({
      tokens: [{
        token: "mismatched-token",
        tenant_id: "tenant-a",
        installation_id: "mismatch-prod-001",
        used_at: "2026-07-12T00:00:00.000Z"
      }],
      installations: [{
        tenant_id: "tenant-b",
        installation_id: "mismatch-prod-001"
      }]
    });
    const api = await startApi({ store, tenantData });

    const heartbeat = await api.post(
      "/api/installations/mismatch-prod-001/heartbeat",
      { client_id: "MISMATCH", ai_key_status: "configured", version: "v1.0.0" },
      "Bearer mismatched-token"
    );

    expect(heartbeat.status).toBe(401);
    expect(heartbeat.body.error).toBe("unauthorized_installation");
  });

  it("ingests a strict aggregate sentinel report for the token tenant", async () => {
    const tenantData = createInMemoryTenantDataStore({
      tokens: [{ token: "installation-token", tenant_id: "tenant-a", installation_id: "tenant-a-prod-001" }],
      installations: [{ tenant_id: "tenant-a", installation_id: "tenant-a-prod-001" }]
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

    const missingBearerScheme = await api.post(
      "/api/sentinel/reports",
      {
        installation_id: "tenant-a-prod-001",
        week_start: "2026-07-06",
        body_md: "# Weekly sentinel",
        stats: { runs: 1, errors: 0, interrupts: 0, avg_node_ms: 10 }
      },
      "installation-token"
    );
    expect(missingBearerScheme.status).toBe(401);

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
      tokens: [{ token: "usage-token", tenant_id: "tenant-b", installation_id: "tenant-b-prod-001" }],
      installations: [{ tenant_id: "tenant-b", installation_id: "tenant-b-prod-001" }]
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

    const invalidCounts = await api.post(
      "/api/usage",
      { day: "12-07-2026", channel: "email", quotes: -1, routes: 1.5 },
      "Bearer usage-token"
    );
    expect(invalidCounts.status).toBe(400);

    const impossibleDate = await api.post(
      "/api/usage",
      { day: "2026-02-31", channel: "email", quotes: 1, routes: 1 },
      "Bearer usage-token"
    );
    expect(impossibleDate.status).toBe(400);
  });

  it("returns the latest release and only allowlisted heartbeat settings", async () => {
    const tenantData = createInMemoryTenantDataStore({
      tokens: [{ token: "release-token", tenant_id: "tenant:SYNC", installation_id: "sync-prod-001" }],
      installations: [
        {
          tenant_id: "tenant:SYNC",
          installation_id: "sync-prod-001",
          settings: {
            pricing_model: "profitability",
            pdf_template: { layout: "compact-v2" },
            customer_detail: { name: "must-not-leak" }
          }
        }
      ],
      releases: [
        { version: "v1.9.0", notes: "Previous" },
        { version: "v1.10.0", notes: "Current" },
        { version: "v9.0.0-rc.1", notes: "Must not enter stable channel" }
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

    const heartbeat = await api.post(
      "/api/installations/sync-prod-001/heartbeat",
      {
        client_id: "SYNC",
        ai_key_status: "configured",
        version: "v1.8.0"
      },
      "Bearer release-token"
    );
    expect(heartbeat.status).toBe(202);
    expect(heartbeat.body).toMatchObject({
      latest_version: "v1.10.0",
      settings: { pricing_model: "profitability", pdf_template: { layout: "compact-v2" } }
    });
    expect(heartbeat.body.settings).not.toHaveProperty("customer_detail");
    expect(tenantData.installations.get("sync-prod-001")).toMatchObject({
      version: "v1.8.0",
      last_heartbeat_at: "2026-07-12T15:00:00.000Z"
    });

    const prereleaseHeartbeat = await api.post(
      "/api/installations/sync-prod-001/heartbeat",
      { client_id: "SYNC", ai_key_status: "configured", version: "v1.11.0-rc.1" },
      "Bearer release-token"
    );
    expect(prereleaseHeartbeat.status).toBe(400);

    const installation = tenantData.installations.get("sync-prod-001");
    expect(installation).toBeDefined();
    installation!.settings = { pdf_template: "  legacy-compact-template  " };
    const legacyTemplateHeartbeat = await api.post(
      "/api/installations/sync-prod-001/heartbeat",
      { client_id: "SYNC", ai_key_status: "configured", version: "v1.8.0" },
      "Bearer release-token"
    );
    expect(legacyTemplateHeartbeat.status).toBe(202);
    expect(legacyTemplateHeartbeat.body.settings).toEqual({
      pdf_template: "  legacy-compact-template  "
    });

    installation!.settings = { pdf_template: 42 };
    const invalidTemplateHeartbeat = await api.post(
      "/api/installations/sync-prod-001/heartbeat",
      { client_id: "SYNC", ai_key_status: "configured", version: "v1.8.0" },
      "Bearer release-token"
    );
    expect(invalidTemplateHeartbeat.status).toBe(202);
    expect(invalidTemplateHeartbeat.body.settings).not.toHaveProperty("pdf_template");

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
      expect(sql).toContain(`revoke all on table public.${table} from anon;`);
    }
    expect(sql).toContain("where p.user_id = auth.uid() and p.role = 'vendor_admin'");
    expect(sql).toMatch(/client_id text not null unique/i);
    expect(sql).toMatch(/authorized_email text not null unique/i);
    expect(sql).toContain("check (role = 'vendor_admin' or tenant_id is not null)");
    expect(sql).toContain("check (version ~ '^v[0-9]+\\.[0-9]+\\.[0-9]+$')");
    expect(sql).toContain("create policy releases_authenticated_select");
    expect(sql).not.toMatch(/create policy registration_tokens_tenant_/i);
    expect(sql).toMatch(
      /foreign key \(tenant_id, installation_id\)[\s\S]*?references public\.installations \(tenant_id, installation_id\)/i
    );
    expect(sql).not.toMatch(/create policy[^;]+\bto\s+anon\b/i);
    expect(sql).toContain("constraint sentinel_reports_stats_aggregate_only check");
    expect(sql).toContain("jsonb_object_length(stats) = 4");
    expect(sql).toContain(
      "stats ?& array['runs', 'errors', 'interrupts', 'avg_node_ms']::text[]"
    );
    expect(sql).toContain("(stats ->> 'runs') ~ '^[0-9]+$'");
    expect(sql).toContain("(stats ->> 'errors') ~ '^[0-9]+$'");
    expect(sql).toContain("(stats ->> 'interrupts') ~ '^[0-9]+$'");
    expect(sql).toContain("jsonb_typeof(stats -> 'avg_node_ms') = 'number'");
    expect(sql).toContain("(stats ->> 'avg_node_ms')::numeric >= 0");
    expect(sql).toContain(
      "lower(stats ->> 'avg_node_ms') not in ('nan', 'infinity', '-infinity')"
    );
    expect(sql).not.toMatch(/create policy sentinel_reports_tenant_(insert|update)/i);
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
  verifySessionToken?: (token: string) => Promise<{ user_id: string; email: string } | null>;
  isVendorAdminEmail?: (email: string) => boolean;
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
      host: "quoteops-control-plane-staging.vercel.app",
      ...(payload
        ? {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(payload))
          }
        : {}),
      ...(authorization ? { authorization } : {})
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
