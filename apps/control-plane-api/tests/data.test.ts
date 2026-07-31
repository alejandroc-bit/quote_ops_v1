import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMinimalClientRecord } from "@quoteops/control-plane";
import {
  canonicalizeInstallPack,
  createDefaultControlPlaneData,
  createFileControlPlaneData,
  createInMemoryControlPlaneData,
  type RegistrationTokenRecord,
  type ReleaseRecord
} from "../src/data/index";
import { projectMinimalClientRecord } from "../src/data/postgres";
import { runAdminCli } from "../src/adminCli";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("unified control-plane data", () => {
  it("round-trips the client projection and synchronizes the primary authorized email", async () => {
    const data = createInMemoryControlPlaneData();
    const client = createMinimalClientRecord({
      client_id: "DATA",
      legal_name: "Data Client",
      authorized_email: "owner@data.example",
      created_at: "2026-07-13T12:00:00.000Z"
    });
    await data.upsertClient(client);

    expect(await data.getClient("DATA")).toEqual(client);
    expect(await data.getClientByInstallation("data-prod-001")).toEqual(client);
    expect(await data.findClientByAuthorizedEmail("OWNER@DATA.EXAMPLE")).toEqual(client);

    const updated = {
      ...client,
      authorized_users: [
        { ...client.authorized_users[0]!, email: "replacement@data.example" }
      ]
    };
    await data.upsertClient(updated);

    expect(await data.findClientByAuthorizedEmail("owner@data.example")).toBeNull();
    expect(await data.findClientByAuthorizedEmail("replacement@data.example")).toEqual(updated);
  });

  it("saves, resolves and consumes registration tokens in the unified store", async () => {
    const client = createMinimalClientRecord({
      client_id: "TOKEN",
      legal_name: "Token Client",
      authorized_email: "owner@token.example",
      created_at: "2026-07-13T12:00:00.000Z"
    });
    const data = createInMemoryControlPlaneData({ clients: [client] });
    const release = createTestRelease();
    await data.upsertRelease(release);
    await data.saveRegistrationToken(
      createTestToken(
        "unified-token",
        "TOKEN",
        "token-prod-001",
        "2000-01-01T00:00:00.000Z",
        release
      )
    );

    expect(await data.resolveTenantByToken("unified-token")).toBeNull();
    await data.markRegistrationTokenUsed("unified-token", "2026-07-13T12:01:00.000Z");
    expect(await data.getRegistrationToken("unified-token")).toMatchObject({
      client_id: "TOKEN",
      used_at: "2026-07-13T12:01:00.000Z"
    });
    expect(await data.resolveTenantByToken("unified-token")).toEqual({
      tenant_id: "tenant:TOKEN",
      installation_id: "token-prod-001"
    });
  });

  it("projects joined Postgres rows into the existing endpoint client shape", () => {
    const projected = projectMinimalClientRecord({
      tenant_id: "tenant-uuid",
      client_id: "ROW",
      authorized_email: "owner@row.example",
      legal_name: "Row Client",
      created_at: new Date("2026-07-13T12:00:00.000Z"),
      status: "active",
      authorized_users: [{ email: "owner@row.example", role: "owner" }],
      installation_id: "row-prod-001",
      license_status: "active",
      onboarding_status: "ready",
      last_heartbeat_at: new Date("2026-07-13T12:05:00.000Z"),
      ai_key_status: "configured",
      counters: { total: 5, validated: 3, rejected: 1, pending: 1, failed: 0 }
    });

    expect(projected).toMatchObject({
      client_id: "ROW",
      legal_name: "Row Client",
      status: "active",
      authorized_users: [{ email: "owner@row.example", role: "owner" }],
      installation: {
        installation_id: "row-prod-001",
        client_id: "ROW",
        last_heartbeat_at: "2026-07-13T12:05:00.000Z"
      },
      counters: { total: 5, validated: 3, rejected: 1, pending: 1, failed: 0 }
    });
  });

  it("reads and preserves the legacy file-store JSON shape", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quoteops-unified-data-"));
    tempDirectories.push(directory);
    const path = join(directory, "store.json");
    const client = createMinimalClientRecord({
      client_id: "FILE",
      legal_name: "File Client",
      authorized_email: "owner@file.example",
      created_at: "2026-07-13T12:00:00.000Z"
    });
    await writeFile(path, JSON.stringify({ clients: [client], registration_tokens: [] }));

    const data = createFileControlPlaneData(path);
    expect(await data.getClient("FILE")).toEqual(client);
    await data.saveRegistrationToken(
      createTestToken(
        "file-token",
        "FILE",
        "file-prod-001",
        "2026-07-13T13:00:00.000Z",
        createTestRelease()
      )
    );

    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      clients: [client],
      registration_tokens: [
        {
          token: "file-token",
          client_id: "FILE",
          installation_id: "file-prod-001",
          expires_at: "2026-07-13T13:00:00.000Z",
          used_at: null,
          release_version: "v0.2.0"
        }
      ],
      releases: []
    });
    expect(await data.latestRelease()).toBeNull();
    expect(await data.getInstallationSettings("file-prod-001")).toEqual({});
  });

  it("preserves incomplete legacy token rows during unrelated file-store writes and requires reissue on access", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "quoteops-legacy-token-preservation-")
    );
    tempDirectories.push(directory);
    const path = join(directory, "store.json");
    const client = createMinimalClientRecord({
      client_id: "LEGACY",
      legal_name: "Legacy Client",
      authorized_email: "owner@legacy.example",
      created_at: "2026-07-13T12:00:00.000Z"
    });
    const legacyToken = {
      token: "legacy-token-hash",
      client_id: "LEGACY",
      installation_id: "legacy-prod-001",
      expires_at: "2026-07-13T13:00:00.000Z",
      used_at: null
    };
    await writeFile(
      path,
      JSON.stringify({
        clients: [client],
        registration_tokens: [legacyToken],
        releases: []
      })
    );

    const data = createFileControlPlaneData(path);
    await data.upsertClient({
      ...client,
      legal_name: "Legacy Client Updated"
    });

    const persisted = JSON.parse(await readFile(path, "utf8")) as {
      registration_tokens: unknown[];
    };
    expect(persisted.registration_tokens).toEqual([legacyToken]);
    await expect(
      data.getRegistrationToken("legacy-token-hash")
    ).rejects.toThrow("registration_token_reissue_required");
  });

  it("selects the legacy-compatible file implementation from the default factory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quoteops-default-data-"));
    tempDirectories.push(directory);
    const path = join(directory, "store.json");
    const data = createDefaultControlPlaneData({
      QUOTEOPS_CONTROL_PLANE_STORE_PATH: path
    });
    expect(await data.listClients()).toEqual([]);
  });

  it("runs the admin CLI against the file store without Postgres", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quoteops-admin-file-"));
    tempDirectories.push(directory);
    const storePath = join(directory, "store.json");
    const fileData = createFileControlPlaneData(storePath);
    await fileData.upsertRelease(createTestRelease());
    const output: string[] = [];
    const dependencies = {
      env: { QUOTEOPS_CONTROL_PLANE_STORE_PATH: storePath },
      now: () => new Date("2026-07-13T12:00:00.000Z"),
      tokenGenerator: () => "file-store-token",
      writeLine: (line: string) => output.push(line)
    };

    await runAdminCli(
      ["create-client", "FILECLI", "Razón Social", "ops@cliente.mx"],
      dependencies
    );
    await runAdminCli(["list"], dependencies);

    expect(output).toContain("Created FILECLI | Razón Social | filecli-prod-001");
    expect(output).toContain(
      "FILECLI | onboarding | filecli-prod-001 | pending | ops@cliente.mx | Razón Social"
    );
  });

  it("runs the vendor create-client, list and install-pack workflow", async () => {
    const data = createInMemoryControlPlaneData();
    await data.upsertRelease(createTestRelease());
    const output: string[] = [];
    const dependencies = {
      data,
      env: { QUOTEOPS_CONTROL_PLANE_URL: "https://control.quoteops.example" },
      now: () => new Date("2026-07-13T12:00:00.000Z"),
      tokenGenerator: () => "admin-cli-token",
      writeLine: (line: string) => output.push(line)
    };

    await runAdminCli(
      ["create-client", "PILOTO", "Razón Social", "ops@cliente.mx"],
      dependencies
    );
    await runAdminCli(["list"], dependencies);
    await runAdminCli(
      ["install-pack", "PILOTO", "--ttl-minutes", "90"],
      dependencies
    );

    expect(output).toContain("Created PILOTO | Razón Social | piloto-prod-001");
    expect(output).toContain(
      "PILOTO | onboarding | piloto-prod-001 | pending | ops@cliente.mx | Razón Social"
    );
    expect(output).toContain("Registration token: admin-cli-token");
    expect(output).toContain("Expires at: 2026-07-13T13:30:00.000Z");
    expect(output.at(-1)).toContain(
      'curl --proto "=https" --proto-redir "=https" --tlsv1.2'
    );
    expect(await data.getRegistrationToken(sha256("admin-cli-token"))).toMatchObject({
      client_id: "PILOTO",
      installation_id: "piloto-prod-001",
      used_at: null
    });
  });
});

function createTestRelease(): ReleaseRecord {
  const archiveBytes = Buffer.from("test-release-archive");
  const image = (name: string, digit: string) =>
    `${name}@sha256:${digit.repeat(64)}`;
  const manifest = {
    schema_version: 1 as const,
    version: "v0.2.0",
    git_sha: "b".repeat(40),
    platform: "linux/amd64" as const,
    images: {
      agent: `agent:v0.2.0@sha256:${"1".repeat(64)}`,
      api: `api:v0.2.0@sha256:${"2".repeat(64)}`,
      web: `web:v0.2.0@sha256:${"3".repeat(64)}`,
      postgres: image("postgres:16", "4"),
      redis: image("redis:7", "5"),
      caddy: image("caddy:2", "6"),
      cloudflared: image("cloudflared:2025.7.0", "7")
    },
    files_sha256: { "install.sh": "8".repeat(64) },
    created_at: "2026-07-13T12:00:00.000Z"
  };
  return {
    version: manifest.version,
    notes: "test",
    bundle_sha256: sha256(archiveBytes),
    manifest,
    manifest_bytes: Buffer.from(`${JSON.stringify(manifest)}\n`),
    archive_bytes: archiveBytes,
    published_at: "2026-07-13T12:00:00.000Z"
  };
}

function createTestToken(
  token: string,
  clientId: string,
  installationId: string,
  expiresAt: string,
  release: ReleaseRecord
): RegistrationTokenRecord {
  const snapshot = {
    client_id: clientId,
    installation_id: installationId,
    expires_at: expiresAt,
    control_plane_url: "https://control.quoteops.example",
    install_command: "sudo bash quoteops-bootstrap.sh",
    release: {
      version: release.version,
      bundle_sha256: release.bundle_sha256
    },
    files: {}
  };
  return {
    token,
    client_id: clientId,
    installation_id: installationId,
    expires_at: expiresAt,
    used_at: null,
    release_version: release.version,
    bundle_sha256: release.bundle_sha256,
    install_pack_snapshot: snapshot,
    pack_sha256: sha256(canonicalizeInstallPack(snapshot))
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
import { createHash } from "node:crypto";
