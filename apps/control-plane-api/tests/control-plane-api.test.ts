import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { type IncomingMessage, ServerResponse } from "node:http";
import { Duplex, Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import tar from "tar-stream";
import { createControlPlaneApi } from "../src/index";
import {
  canonicalizeInstallPack,
  createFileControlPlaneData,
  createInMemoryControlPlaneData,
  MAX_RELEASE_ARCHIVE_BYTES,
  type ControlPlaneData,
  type RegistrationTokenRecord,
  type ReleaseRecord
} from "../src/data/index";
import {
  MAX_INSTALLER_RESPONSE_BYTES,
  renderInstallerScript,
  validateReleaseArchive
} from "../src/installerScript";
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
    const data = createInMemoryControlPlaneData();
    const sessions = new Map([
      ["owner-session", { user_id: "user-owner", email: "owner@claim.example" }],
      ["vendor-session", { user_id: "user-vendor", email: "vendor@inducta.example" }],
      ["unknown-session", { user_id: "user-unknown", email: "unknown@example.com" }],
      ["escalation-session", { user_id: "user-owner", email: "vendor@inducta.example" }]
    ]);
    const api = await startApi({
      data,
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
    expect(data.profiles.has("user-owner")).toBe(false);
  });

  it("revokes stale portal profiles when live email or role authority changes", async () => {
    const data = createInMemoryControlPlaneData();
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
      data,
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
    expect(data.profiles.has("vendor-user")).toBe(false);

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
    expect(data.profiles.has("owner-user")).toBe(false);

    expect((await api.post("/api/portal/profile/claim", {}, "Bearer email-change-session")).status).toBe(200);
    sessions.set("email-change-session", { user_id: "email-user", email: "changed@example.com" });
    expect((await api.post("/api/portal/profile/claim", {}, "Bearer email-change-session")).status).toBe(403);
    expect(data.profiles.has("email-user")).toBe(false);

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
    expect(data.profiles.has("switch-user")).toBe(false);
  });

  it("pins and serves an immutable install pack through Bearer authentication", async () => {
    const data = createInMemoryControlPlaneData();
    const release = await createTestRelease("v0.2.0", "fixture-a");
    await data.upsertRelease(release);
    const api = await startApi({
      data,
      tokenGenerator: () => "installer-token-1",
      now: () => new Date("2026-06-25T12:00:00.000Z")
    });

    await api.post("/api/admin/clients", {
      client_id: "NMX",
      legal_name: "Autolineas NuevoMex",
      authorized_email: "ops@nmx.example"
    });
    const issued = await api.post("/api/admin/clients/NMX/install-pack", {});
    expect(issued.status).toBe(201);
    const { registration_token: registrationToken, ...issuedPackWithoutToken } =
      issued.body.install_pack;
    const savedToken = await data.getRegistrationToken(sha256(registrationToken));
    expect(savedToken).not.toBeNull();
    expect(savedToken!.release_version).toBe("v0.2.0");
    expect(savedToken!.bundle_sha256).toBe(release.bundle_sha256);
    expect(savedToken!.install_pack_snapshot).toEqual(issuedPackWithoutToken);
    expect(savedToken!.pack_sha256).toBe(
      sha256(canonicalizeInstallPack(issuedPackWithoutToken))
    );
    expect(JSON.stringify(savedToken!.install_pack_snapshot)).not.toContain(
      registrationToken
    );

    const anonymous = await api.getText("/api/install");
    expect(anonymous.status).toBe(401);
    const missing = await api.getText("/api/install", "Bearer unknown-token");
    expect(missing.status).toBe(404);
    const legacyPath = await api.getText(`/api/install/${registrationToken}`);
    expect(legacyPath.status).toBe(404);

    const installer = await api.getText(
      "/api/install",
      `Bearer ${registrationToken}`
    );
    expect(installer.status).toBe(200);
    expect(installer.headers["cache-control"]).toBe("no-store");
    expect(installer.headers["referrer-policy"]).toBe("no-referrer");
    expect(installer.text.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(installer.text).toContain("--client 'NMX'");
    expect(installer.text).toContain("--installation-id 'nmx-prod-001'");
    expect(installer.text).toContain("--version 'v0.2.0'");
    // the token authorizes the download but is never embedded in the script
    expect(installer.text).not.toContain(registrationToken);

    await api.post("/api/onboarding/activate", {
      client_id: "NMX",
      installation_id: "nmx-prod-001",
      email: "ops@nmx.example",
      registration_token: registrationToken
    });
    const used = await api.getText("/api/install", `Bearer ${registrationToken}`);
    expect(used.status).toBe(403);
  });

  it("keeps an old token byte-pinned across release and overlay drift", async () => {
    const data = createInMemoryControlPlaneData();
    const releaseA = await createTestRelease("v0.2.0", "runtime-fixture-a");
    await data.upsertRelease(releaseA);
    const generatedTokens = ["drift-token-a", "drift-token-b"];
    const api = await startApi({
      data,
      tokenGenerator: () => generatedTokens.shift()!,
      now: () => new Date("2026-06-25T12:00:00.000Z")
    });
    await api.post("/api/admin/clients", {
      client_id: "DRIFT",
      legal_name: "Overlay Fixture A",
      authorized_email: "ops@drift.example"
    });
    const issuedA = await api.post("/api/admin/clients/DRIFT/install-pack", {});
    const snapshotA = { ...issuedA.body.install_pack };
    delete snapshotA.registration_token;

    const releaseB = await createTestRelease("v0.2.1", "runtime-fixture-b");
    await data.upsertRelease(releaseB);
    const client = await data.getClient("DRIFT");
    await data.upsertClient({ ...client!, legal_name: "Overlay Fixture B" });
    const issuedB = await api.post("/api/admin/clients/DRIFT/install-pack", {});
    expect(issuedB.body.install_pack.release.version).toBe("v0.2.1");

    const oldInstaller = await api.getText(
      "/api/install",
      "Bearer drift-token-a"
    );
    expect(oldInstaller.status).toBe(200);
    expect(oldInstaller.text).toContain(
      Buffer.from(releaseA.archive_bytes).toString("base64")
    );
    expect(oldInstaller.text).not.toContain(
      Buffer.from(releaseB.archive_bytes).toString("base64")
    );
    expect(oldInstaller.text).toContain(
      Buffer.from(snapshotA.files["client-manifest.yaml"], "utf8").toString(
        "base64"
      )
    );
    expect(oldInstaller.text).not.toContain(
      Buffer.from(
        issuedB.body.install_pack.files["client-manifest.yaml"],
        "utf8"
      ).toString("base64")
    );
    expect(oldInstaller.text).toContain("--version 'v0.2.0'");
    expect(oldInstaller.text).not.toContain("v0.2.1");
  });

  it.each([
    "snapshot",
    "pack_hash",
    "release_version",
    "bundle_hash"
  ] as const)("fails closed when the stored %s is tampered", async (field) => {
    const data = createInMemoryControlPlaneData();
    await data.upsertRelease(await createTestRelease("v0.2.0", "tamper"));
    const api = await startApi({
      data,
      tokenGenerator: () => "tamper-token",
      now: () => new Date("2026-06-25T12:00:00.000Z")
    });
    await api.post("/api/admin/clients", {
      client_id: "TAMPER",
      legal_name: "Tamper Client",
      authorized_email: "ops@tamper.example"
    });
    await api.post("/api/admin/clients/TAMPER/install-pack", {});
    const stored = data.tokens.get(sha256("tamper-token"))!;
    if (field === "snapshot") {
      stored.install_pack_snapshot.install_command += " changed";
    } else if (field === "pack_hash") {
      stored.pack_sha256 = "0".repeat(64);
    } else if (field === "release_version") {
      stored.release_version = "v0.2.1";
    } else {
      stored.bundle_sha256 = "0".repeat(64);
    }

    const response = await api.getText(
      "/api/install",
      "Bearer tamper-token"
    );
    expect(response.status).toBe(403);
    expect(response.text).not.toContain("#!/usr/bin/env bash");
  });

  it.each(["../escape", "/tmp/escape", "install.sh"])(
    "rejects client overlay path %s before rendering",
    async (path) => {
      const data = createInMemoryControlPlaneData();
      await data.upsertRelease(await createTestRelease("v0.2.0", "overlay"));
      const api = await startApi({
        data,
        tokenGenerator: () => "overlay-token",
        now: () => new Date("2026-06-25T12:00:00.000Z")
      });
      await api.post("/api/admin/clients", {
        client_id: "OVERLAY",
        legal_name: "Overlay Client",
        authorized_email: "ops@overlay.example"
      });
      await api.post("/api/admin/clients/OVERLAY/install-pack", {});
      const stored = data.tokens.get(sha256("overlay-token"))!;
      stored.install_pack_snapshot.files[path] = "malicious";
      stored.pack_sha256 = sha256(
        canonicalizeInstallPack(stored.install_pack_snapshot)
      );

      const response = await api.getText(
        "/api/install",
        "Bearer overlay-token"
      );
      expect(response.status).toBe(503);
      expect(response.text).not.toContain("#!/usr/bin/env bash");
    }
  );

  it("stops on a corrupted embedded archive before invoking install.sh", async () => {
    const data = createInMemoryControlPlaneData();
    await data.upsertRelease(await createTestRelease("v0.2.0", "must-not-run"));
    const api = await startApi({
      data,
      tokenGenerator: () => "corruption-token",
      now: () => new Date("2026-06-25T12:00:00.000Z")
    });
    await api.post("/api/admin/clients", {
      client_id: "CORRUPT",
      legal_name: "Corruption Client",
      authorized_email: "ops@corrupt.example"
    });
    await api.post("/api/admin/clients/CORRUPT/install-pack", {});
    const installer = await api.getText(
      "/api/install",
      "Bearer corruption-token"
    );
    const match = installer.text.match(
      /printf '%s' '([A-Za-z0-9+/=]+)' \| decode_base64 > "\$archive_file"/
    );
    expect(match?.[1]).toBeTruthy();
    const encoded = match![1]!;
    const tampered =
      installer.text.replace(
        encoded,
        `${encoded[0] === "A" ? "B" : "A"}${encoded.slice(1)}`
      );
    const dir = await mkdtemp(join(tmpdir(), "quoteops-corrupt-installer-"));
    tempDirs.push(dir);
    const tokenFile = join(dir, "registration-token");
    await writeFile(tokenFile, "corruption-token\n", { mode: 0o600 });
    const result = spawnSync("bash", ["-c", tampered], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        TMPDIR: dir,
        QUOTEOPS_REGISTRATION_TOKEN_FILE: tokenFile
      }
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("must-not-run");
    await expect(readFile(join(dir, "current"))).rejects.toMatchObject({
      code: "ENOENT"
    });
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

  it.each(["", "http://quoteops.example/path"])(
    "fails install-pack issuance closed for control-plane origin %j",
    async (controlPlaneUrl) => {
      const api = await startApi({ controlPlaneUrl });
      await api.post("/api/admin/clients", {
        client_id: "ORIGIN",
        legal_name: "Origin Client",
        authorized_email: "ops@origin.example"
      });
      const response = await api.post(
        "/api/admin/clients/ORIGIN/install-pack",
        {}
      );
      expect(response.status).toBe(503);
      expect(response.body.error).toBe("control_plane_origin_missing");
    }
  );

  it("requires reissue for a legacy token without a complete release pin", async () => {
    const release = await createTestRelease("v0.2.0", "legacy-token");
    const data = createInMemoryControlPlaneData({
      tokens: [
        {
          token: sha256("legacy-token"),
          client_id: "LEGACY",
          tenant_id: "tenant:LEGACY",
          installation_id: "legacy-prod-001",
          expires_at: "9999-01-01T00:00:00.000Z",
          used_at: null
        } as unknown as RegistrationTokenRecord & { tenant_id: string }
      ],
      releases: [release]
    });
    const api = await startApi({ data });
    const response = await api.getText(
      "/api/install",
      "Bearer legacy-token"
    );
    expect(response.status).toBe(403);
    expect(JSON.parse(response.text)).toMatchObject({
      error: "registration_token_reissue_required"
    });
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

  it.each(["client_licensed", "token_used"] as const)(
    "retries activation after a %s persistence failure without reissuing the install pack",
    async (failureBoundary) => {
      const baseData = createInMemoryControlPlaneData();
      let failurePending = true;
      const data: ControlPlaneData = {
        ...baseData,
        upsertClient(client) {
          if (failurePending && failureBoundary === "client_licensed" && client.status === "active") {
            failurePending = false;
            throw new Error("injected_client_persistence_failure");
          }
          return baseData.upsertClient(client);
        },
        markRegistrationTokenUsed(token, usedAt) {
          if (failurePending && failureBoundary === "token_used") {
            failurePending = false;
            throw new Error("injected_token_failure");
          }
          return baseData.markRegistrationTokenUsed(token, usedAt);
        }
      };
      const api = await startApi({
        data,
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
    const data = createInMemoryControlPlaneData();
    const api = await startApi({
      data,
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
    const data = createInMemoryControlPlaneData({
      releases: [await createTestRelease("v1.2.0", "Stable")]
    });
    const api = await startApi({
      data,
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

  it("serves tenant ingests from the default in-memory unified data store", async () => {
    const api = await startApi({
      tokenGenerator: () => "legacy-appliance-token",
      now: () => new Date("2026-07-12T15:00:00.000Z")
    });
    await api.post("/api/admin/clients", {
      client_id: "LEGACY",
      legal_name: "Legacy Store Client",
      authorized_email: "ops@legacy.example"
    });
    await api.post("/api/admin/clients/LEGACY/install-pack", {});
    await api.post("/api/onboarding/activate", {
      client_id: "LEGACY",
      installation_id: "legacy-prod-001",
      email: "ops@legacy.example",
      registration_token: "legacy-appliance-token"
    });

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
    expect(sentinel.status).toBe(201);
    expect(sentinel.body).toEqual({ accepted: true });
  });

  it("rejects a token whose tenant and installation pair is internally inconsistent", async () => {
    const client = createMinimalClientRecord({
      client_id: "MISMATCH",
      legal_name: "Mismatch Client",
      authorized_email: "ops@mismatch.example",
      created_at: "2026-07-12T00:00:00.000Z",
      status: "active"
    });
    const release = await createTestRelease("v0.2.0", "mismatch-release");
    const data = createInMemoryControlPlaneData({
      clients: [client],
      tokens: [{
        ...createTestTokenRecord(
          "mismatched-token",
          "MISMATCH",
          "mismatch-prod-001",
          release
        ),
        tenant_id: "tenant-a",
        used_at: "2026-07-12T00:00:00.000Z"
      }],
      installations: [{
        tenant_id: "tenant:MISMATCH",
        installation_id: "mismatch-prod-001"
      }],
      releases: [release]
    });
    const api = await startApi({ data });

    const heartbeat = await api.post(
      "/api/installations/mismatch-prod-001/heartbeat",
      { client_id: "MISMATCH", ai_key_status: "configured", version: "v1.0.0" },
      "Bearer mismatched-token"
    );

    expect(heartbeat.status).toBe(401);
    expect(heartbeat.body.error).toBe("unauthorized_installation");
  });

  it("ingests a strict aggregate sentinel report for the token tenant", async () => {
    const release = await createTestRelease("v0.2.0", "sentinel-release");
    const data = createInMemoryControlPlaneData({
      tokens: [{
        ...createTestTokenRecord(
          "installation-token",
          "TENANT-A",
          "tenant-a-prod-001",
          release
        ),
        tenant_id: "tenant-a",
      }],
      installations: [{ tenant_id: "tenant-a", installation_id: "tenant-a-prod-001" }],
      releases: [release]
    });
    const api = await startApi({ data });

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
    expect(data.sentinelReports).toEqual([
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
    const release = await createTestRelease("v0.2.0", "usage-release");
    const data = createInMemoryControlPlaneData({
      tokens: [{
        ...createTestTokenRecord(
          "usage-token",
          "TENANT-B",
          "tenant-b-prod-001",
          release
        ),
        tenant_id: "tenant-b",
      }],
      installations: [{ tenant_id: "tenant-b", installation_id: "tenant-b-prod-001" }],
      releases: [release]
    });
    const api = await startApi({ data });

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
    expect(data.usageEvents.get("tenant-b|2026-07-12|email")).toMatchObject({
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
    const previousRelease = await createTestRelease("v1.9.0", "Previous");
    const currentRelease = await createTestRelease("v1.10.0", "Current");
    const data = createInMemoryControlPlaneData({
      tokens: [{
        ...createTestTokenRecord(
          "release-token",
          "SYNC",
          "sync-prod-001",
          currentRelease
        ),
        tenant_id: "tenant:SYNC",
      }],
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
        previousRelease,
        currentRelease
      ]
    });
    const api = await startApi({
      data,
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
    expect(data.installations.get("sync-prod-001")).toMatchObject({
      version: "v1.8.0",
      last_heartbeat_at: "2026-07-12T15:00:00.000Z"
    });

    const prereleaseHeartbeat = await api.post(
      "/api/installations/sync-prod-001/heartbeat",
      { client_id: "SYNC", ai_key_status: "configured", version: "v1.11.0-rc.1" },
      "Bearer release-token"
    );
    expect(prereleaseHeartbeat.status).toBe(400);

    const installation = data.installations.get("sync-prod-001");
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
    const firstData = createFileControlPlaneData(storePath);
    const firstApi = await startApi({
      data: firstData,
      tokenGenerator: () => "file-store-token",
      now: () => new Date("2026-06-25T12:00:00.000Z")
    });

    await firstApi.post("/api/admin/clients", {
      client_id: "FILE",
      legal_name: "File Store Client",
      authorized_email: "ops@file.example"
    });
    await firstApi.post("/api/admin/clients/FILE/install-pack", {});
    const secondData = createFileControlPlaneData(storePath);
    const secondApi = await startApi({
      data: secondData,
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

  it.each([
    {
      label: "absolute path",
      entries: [{ name: "/escape", contents: "x" }]
    },
    {
      label: "parent traversal",
      entries: [{ name: "../escape", contents: "x" }]
    },
    {
      label: "symlink",
      entries: [
        { name: "install.sh", contents: "", type: "symlink" as const, linkname: "../escape" }
      ]
    },
    {
      label: "hardlink",
      entries: [
        { name: "install.sh", contents: "", type: "link" as const, linkname: "release.env" }
      ]
    },
    {
      label: "directory",
      entries: [{ name: "install.sh", contents: "", type: "directory" as const }]
    },
    {
      label: "duplicate",
      entries: [
        { name: "install.sh", contents: "a" },
        { name: "install.sh", contents: "b" }
      ]
    }
  ])("rejects a release archive containing a $label", async ({ entries }) => {
    const release = await createTestRelease("v0.2.0", "archive-security");
    const archiveBytes = await createTarGzip(entries);
    expect(() =>
      validateReleaseArchive({
        archiveBytes,
        bundleSha256: sha256(archiveBytes),
        manifest: release.manifest
      })
    ).toThrow();
  });

  it("enforces the raw release and rendered installer size caps", async () => {
    const exactData = createInMemoryControlPlaneData();
    const exact = await createTestRelease("v0.2.0", "exact-cap");
    exact.archive_bytes = Buffer.alloc(MAX_RELEASE_ARCHIVE_BYTES);
    exact.bundle_sha256 = sha256(exact.archive_bytes);
    expect(exactData.upsertRelease(exact)).toMatchObject({
      version: "v0.2.0"
    });

    const oversizedData = createInMemoryControlPlaneData();
    const oversized = await createTestRelease("v0.2.0", "oversized");
    oversized.archive_bytes = Buffer.alloc(MAX_RELEASE_ARCHIVE_BYTES + 1);
    oversized.bundle_sha256 = sha256(oversized.archive_bytes);
    expect(() => oversizedData.upsertRelease(oversized)).toThrow(
      "release_archive_too_large"
    );

    const release = await createTestRelease("v0.2.0", "response-cap");
    const basePack = {
      client_id: "CAP",
      installation_id: "cap-prod-001",
      expires_at: "2026-06-25T13:00:00.000Z",
      control_plane_url: "https://quoteops-control-plane-staging.vercel.app",
      install_command: "sudo bash quoteops-bootstrap.sh",
      release: {
        version: release.version,
        bundle_sha256: release.bundle_sha256
      },
      files: {
        "client-manifest.yaml": "x".repeat(2_900_000)
      }
    };
    const withinLimit = renderInstallerScript({
      pack: basePack,
      archiveBytes: Buffer.from(release.archive_bytes),
      bundleSha256: release.bundle_sha256,
      manifest: release.manifest
    });
    expect(Buffer.byteLength(withinLimit, "utf8")).toBeLessThanOrEqual(
      MAX_INSTALLER_RESPONSE_BYTES
    );
    expect(() =>
      renderInstallerScript({
        pack: {
          ...basePack,
          files: {
            "client-manifest.yaml": "x".repeat(3_100_000)
          }
        },
        archiveBytes: Buffer.from(release.archive_bytes),
        bundleSha256: release.bundle_sha256,
        manifest: release.manifest
      })
    ).toThrow("installer_response_too_large");
  });
});

describe("Supabase control-plane migration", () => {
  it("enables RLS on every table with tenant and vendor-admin policies but no anon policy", async () => {
    const sql = await readFile(
      new URL("../../../supabase/migrations/0001_control_plane.sql", import.meta.url),
      "utf8"
    );
    const unifiedStoreSql = await readFile(
      new URL("../../../supabase/migrations/0002_unify_client_store.sql", import.meta.url),
      "utf8"
    );
    const pinnedInstallerSql = await readFile(
      new URL(
        "../../../supabase/migrations/0003_pin_install_packs_to_releases.sql",
        import.meta.url
      ),
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
    expect(sql).toContain(
      "(stats - 'runs' - 'errors' - 'interrupts' - 'avg_node_ms') = '{}'::jsonb"
    );
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

    expect(unifiedStoreSql).toMatch(
      /add column status text not null default 'onboarding'/i
    );
    expect(unifiedStoreSql).toContain(
      "check (status in ('active', 'onboarding', 'blocked', 'suspended'))"
    );
    expect(unifiedStoreSql).toMatch(
      /add column authorized_users jsonb not null default '\[\]'::jsonb/i
    );
    expect(unifiedStoreSql).toMatch(
      /add column license_status text not null default 'pending'/i
    );
    expect(unifiedStoreSql).toMatch(
      /add column onboarding_status text not null default 'not_started'/i
    );
    expect(unifiedStoreSql).toMatch(
      /add column ai_key_status text not null default 'missing'/i
    );
    expect(unifiedStoreSql).toContain(
      "'{\"total\":0,\"validated\":0,\"rejected\":0,\"pending\":0,\"failed\":0}'::jsonb"
    );
    expect(unifiedStoreSql).toContain(
      "if to_regclass('public.control_plane_clients') is not null then"
    );
    expect(unifiedStoreSql).toMatch(/on conflict \(client_id\) do update set/i);
    expect(unifiedStoreSql).toMatch(/on conflict \(installation_id\) do update set/i);
    expect(unifiedStoreSql).not.toMatch(
      /on conflict \(client_id\) do update set[\s\S]*?\b(name|authorized_email)\s*=/i
    );
    expect(unifiedStoreSql).toContain(
      "drop table if exists public.control_plane_install_tokens;"
    );
    expect(unifiedStoreSql).toContain(
      "drop table if exists public.control_plane_clients;"
    );
    expect(unifiedStoreSql).toContain("where authorized_users = '[]'::jsonb;");
    expect(unifiedStoreSql).toContain(
      "if exists (select 1 from pg_roles where rolname = 'quoteops_cp') then"
    );
    expect(unifiedStoreSql).toMatch(
      /grant select, insert, update, delete on table[\s\S]*?to quoteops_cp;/i
    );
    for (const column of [
      "release_version",
      "bundle_sha256",
      "install_pack",
      "pack_sha256",
      "manifest",
      "manifest_bytes",
      "archive"
    ]) {
      expect(pinnedInstallerSql).toContain(`add column if not exists ${column}`);
    }
    expect(pinnedInstallerSql).toContain(
      "registration_token_reissue_required"
    );
  });
});

const TEST_ADMIN_TOKEN = "test-admin-token";

async function startApi(options: {
  verifyAdminToken?: ((token: string) => Promise<string | null>) | null;
  keyPair?: ReturnType<typeof generateLicenseKeyPair>;
  now?: () => Date;
  tokenGenerator?: () => string;
  tokenTtlMinutes?: number;
  controlPlaneUrl?: string;
  data?: ControlPlaneData;
  verifySessionToken?: (token: string) => Promise<{ user_id: string; email: string } | null>;
  isVendorAdminEmail?: (email: string) => boolean;
} = {}) {
  const data = options.data ?? createInMemoryControlPlaneData();
  if (!(await data.latestRelease())) {
    await data.upsertRelease(await createTestRelease("v0.2.0", "default-test-release"));
  }
  const controlPlaneUrl =
    options.controlPlaneUrl === undefined
      ? "https://quoteops-control-plane-staging.vercel.app"
      : options.controlPlaneUrl;
  const app = createControlPlaneApi({
    controlPlaneUrl,
    verifyAdminToken: async (token) => (token === TEST_ADMIN_TOKEN ? "ops@e2e.example" : null),
    data,
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
    async getText(path: string, authorization: string | null = null) {
      const response = await directRequest(app, "GET", path, undefined, authorization);
      return {
        status: response.status,
        text: response.text,
        headers: response.headers
      };
    }
  };
}

async function createTestRelease(
  version: string,
  marker: string
): Promise<ReleaseRecord> {
  const imageDigest = (digit: string) => digit.repeat(64);
  const releaseEnv = [
    `QUOTEOPS_VERSION=${version}`,
    "QUOTEOPS_PLATFORM=linux/amd64",
    `QUOTEOPS_AGENT_IMAGE=quoteops-agent:${version}@sha256:${imageDigest("1")}`,
    `QUOTEOPS_API_IMAGE=quoteops-api:${version}@sha256:${imageDigest("2")}`,
    `QUOTEOPS_WEB_IMAGE=quoteops-web:${version}@sha256:${imageDigest("3")}`,
    `QUOTEOPS_POSTGRES_IMAGE=postgres:16@sha256:${imageDigest("4")}`,
    `QUOTEOPS_REDIS_IMAGE=redis:7@sha256:${imageDigest("5")}`,
    `QUOTEOPS_CADDY_IMAGE=caddy:2@sha256:${imageDigest("6")}`,
    `QUOTEOPS_CLOUDFLARED_IMAGE=cloudflare/cloudflared:2025.7.0@sha256:${imageDigest("7")}`,
    ""
  ].join("\n");
  const files = {
    "Caddyfile": `# ${marker}\n`,
    "docker-compose.yml": `# ${marker}\nservices: {}\n`,
    "install.sh": `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' '${marker}'\n`,
    "release.env": releaseEnv
  };
  const manifest = {
    schema_version: 1 as const,
    version,
    git_sha: "b".repeat(40),
    platform: "linux/amd64" as const,
    images: {
      agent: `quoteops-agent:${version}@sha256:${imageDigest("1")}`,
      api: `quoteops-api:${version}@sha256:${imageDigest("2")}`,
      web: `quoteops-web:${version}@sha256:${imageDigest("3")}`,
      postgres: `postgres:16@sha256:${imageDigest("4")}`,
      redis: `redis:7@sha256:${imageDigest("5")}`,
      caddy: `caddy:2@sha256:${imageDigest("6")}`,
      cloudflared: `cloudflare/cloudflared:2025.7.0@sha256:${imageDigest("7")}`
    },
    files_sha256: Object.fromEntries(
      Object.entries(files).map(([name, contents]) => [name, sha256(contents)])
    ),
    created_at: "2026-06-25T12:00:00.000Z"
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const payloadEntries = {
    ...files,
    "release.json": manifestBytes
  };
  const payloadSums =
    Object.entries(payloadEntries)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, contents]) => `${sha256(contents)}  ${name}`)
      .join("\n") + "\n";
  const archiveEntries = {
    ...payloadEntries,
    PAYLOAD_SHA256SUMS: payloadSums
  };
  const archiveBytes = await createTarGzip(
    Object.entries(archiveEntries)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, contents]) => ({ name, contents }))
  );
  return {
    version,
    notes: marker,
    bundle_sha256: sha256(archiveBytes),
    manifest,
    manifest_bytes: manifestBytes,
    archive_bytes: archiveBytes,
    published_at: "2026-06-25T12:00:00.000Z"
  };
}

type TestTarEntry = {
  name: string;
  contents: string | Uint8Array;
  type?: "file" | "directory" | "symlink" | "link";
  linkname?: string;
};

async function createTarGzip(entries: TestTarEntry[]): Promise<Buffer> {
  const pack = tar.pack();
  const archivePromise = collectStream(pack);
  for (const entry of entries) {
    await new Promise<void>((resolve, reject) => {
      pack.entry(
        {
          name: entry.name,
          mode: entry.name.endsWith(".sh") ? 0o755 : 0o644,
          uid: 0,
          gid: 0,
          ...(entry.type ? { type: entry.type } : {}),
          ...(entry.linkname ? { linkname: entry.linkname } : {})
        },
        entry.contents,
        (error) => (error ? reject(error) : resolve())
      );
    });
  }
  pack.finalize();
  return gzipSync(await archivePromise);
}

function createTestTokenRecord(
  token: string,
  clientId: string,
  installationId: string,
  release: ReleaseRecord
): RegistrationTokenRecord {
  const expiresAt = "9999-01-01T00:00:00.000Z";
  const installPackSnapshot = {
    client_id: clientId,
    installation_id: installationId,
    expires_at: expiresAt,
    control_plane_url: "https://quoteops-control-plane-staging.vercel.app",
    install_command: "sudo bash quoteops-bootstrap.sh",
    release: {
      version: release.version,
      bundle_sha256: release.bundle_sha256
    },
    files: {}
  };
  return {
    token: sha256(token),
    client_id: clientId,
    installation_id: installationId,
    expires_at: expiresAt,
    used_at: null,
    release_version: release.version,
    bundle_sha256: release.bundle_sha256,
    install_pack_snapshot: installPackSnapshot,
    pack_sha256: sha256(canonicalizeInstallPack(installPackSnapshot))
  };
}

async function collectStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function directRequest(
  app: ReturnType<typeof createControlPlaneApi>,
  method: "GET" | "POST",
  path: string,
  body: Record<string, unknown> | undefined,
  authorization: string | null
): Promise<{
  status: number;
  body: Record<string, any>;
  text: string;
  headers: ReturnType<ServerResponse["getHeaders"]>;
}> {
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
    text,
    headers: res.getHeaders()
  };
}
