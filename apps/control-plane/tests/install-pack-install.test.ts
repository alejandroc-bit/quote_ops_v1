import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { PublishedApplianceRelease } from "@quoteops/shared";
import {
  createInstallPack,
  createMinimalClientRecord
} from "../src/index";

const tempDirs: string[] = [];
const repoDir = fileURLToPath(new URL("../../../", import.meta.url));
const release: PublishedApplianceRelease = {
  manifest: {
    schema_version: 1,
    version: "v0.2.0",
    git_sha: "b".repeat(40),
    platform: "linux/amd64",
    images: {
      agent: `quoteops-agent:v0.2.0@sha256:${"1".repeat(64)}`,
      api: `quoteops-api:v0.2.0@sha256:${"2".repeat(64)}`,
      web: `quoteops-web:v0.2.0@sha256:${"3".repeat(64)}`,
      postgres: `postgres:16@sha256:${"4".repeat(64)}`,
      redis: `redis:7@sha256:${"5".repeat(64)}`,
      caddy: `caddy:2@sha256:${"6".repeat(64)}`,
      cloudflared: `cloudflare/cloudflared:2025.7.0@sha256:${"7".repeat(64)}`
    },
    files_sha256: {
      "install.sh": "8".repeat(64)
    },
    created_at: "2026-06-25T12:00:00.000Z"
  },
  bundle_sha256: "a".repeat(64)
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("generated install pack", () => {
  it("materializes into a connector pack that deploy/appliance/install.sh accepts", async () => {
    const client = createMinimalClientRecord({
      client_id: "PILOT25",
      legal_name: "Piloto 25 Logistics",
      authorized_email: "ops@piloto25.example",
      installation_id: "piloto25-prod-001",
      created_at: "2026-06-25T12:00:00.000Z"
    });
    const pack = createInstallPack({
      client,
      control_plane_url: "https://quoteops-control-plane.vercel.app/",
      registration_token: "registration-token-install-test",
      expires_at: "2026-06-25T13:00:00.000Z",
      release
    });
    const workDir = await mkdtemp(join(tmpdir(), "quoteops-generated-pack-"));
    tempDirs.push(workDir);
    const packDir = join(workDir, "pack");
    const homeDir = join(workDir, "home");

    expect(pack.files["connectors/knowledge/README.md"]).toContain(
      "documentos de conocimiento"
    );
    expect(pack.files["connectors/knowledge/README.md"]).toContain(
      "consentimiento"
    );
    expect(pack.files["connectors/tms-http-v1.openapi.yaml"]).toBe(
      await readFile(
        join(repoDir, "docs/integrations/tms-http-v1.openapi.yaml"),
        "utf8"
      )
    );
    expect(pack.files["connectors/tms-http-v1.md"]).toBe(
      await readFile(
        join(repoDir, "docs/integrations/tms-http-v1.md"),
        "utf8"
      )
    );
    await materializeFiles(packDir, pack.files);
    const result = spawnSync(
      "bash",
      [
        join(repoDir, "deploy/appliance/install.sh"),
        "--client",
        pack.client_id,
        "--manifest",
        "client-manifest.yaml",
        "--connectors",
        "connectors",
        "--control-plane-url",
        "https://quoteops-control-plane.vercel.app",
        "--registration-token",
        pack.registration_token,
        "--installation-id",
        pack.installation_id,
        "--home",
        homeDir,
        "--skip-start",
        "--postgres-password",
        "test-password"
      ],
      {
        cwd: packDir,
        encoding: "utf8"
      }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const envFile = await readFile(join(homeDir, ".env"), "utf8");
    const secretsFile = await readFile(join(homeDir, "secrets/client.env"), "utf8");
    const installedAgentConfig = await readFile(
      join(homeDir, "connectors/agent/agent-config.yaml"),
      "utf8"
    );
    const installedTmsAdapter = await readFile(join(homeDir, "connectors/tms-adapter.yaml"), "utf8");
    const installedRfqs = await readFile(join(homeDir, "connectors/tms/rfqs.csv"), "utf8");

    expect(envFile).toContain(
      'QUOTEOPS_CONTROL_PLANE_URL="https://quoteops-control-plane.vercel.app"'
    );
    expect(envFile).toContain('QUOTEOPS_INSTALLATION_ID="piloto25-prod-001"');
    expect(envFile).not.toContain("registration-token-install-test");
    expect(secretsFile).toContain('QUOTEOPS_REGISTRATION_TOKEN="registration-token-install-test"');
    expect(installedAgentConfig).toContain("api_key_env: OPENROUTER_API_KEY");
    expect(installedTmsAdapter).toContain("provider: file_import");
    expect(installedRfqs).toContain("rfq_id,lane_id");
    expect(pack.release).toEqual({
      version: "v0.2.0",
      bundle_sha256: "a".repeat(64)
    });
    expect(pack.install_command).toContain(
      'curl --proto "=https" --proto-redir "=https" --tlsv1.2'
    );
    expect(pack.install_command).toContain(
      `${pack.control_plane_url}/install/quoteops`
    );
    expect(pack.install_command).toContain("sudo bash");
    expect(pack.install_command).not.toContain("|");
    expect(pack.install_command).not.toContain(pack.registration_token);

    // 10-jul E2E regression: the pack shipped without the unit CSVs and
    // sync-units died with "env var is missing: QUOTEOPS_TMS_UNITS_PATH".
    // Lock the pack contents and the pack↔compose env contract.
    for (const [file, header] of [
      ["units.csv", "unit_id,current_lat,current_lng,status,next_destination_city"],
      ["performance.csv", "unit_type,kpl_yield,real_cost_per_km"],
      ["availability-zones.csv", "zone_id,city,state,country,available_units"]
    ]) {
      expect(pack.files[`connectors/tms/${file}`], `pack ships ${file}`).toContain(header);
      const installed = await readFile(join(homeDir, `connectors/tms/${file}`), "utf8");
      expect(installed, `install.sh materializes ${file}`).toContain(header);
    }

    const adapterEnvNames = Object.entries(
      parseYaml(installedTmsAdapter) as Record<string, string>
    )
      .filter(([key]) => key.endsWith("_path_env"))
      .map(([, envName]) => envName);
    for (const envName of [
      "QUOTEOPS_TMS_UNITS_PATH",
      "QUOTEOPS_TMS_PERFORMANCE_PATH",
      "QUOTEOPS_TMS_AVAILABILITY_ZONES_PATH"
    ]) {
      expect(adapterEnvNames, "adapter yaml uses the current schema").toContain(envName);
    }

    // every env var the adapter yaml names must be defined in each compose
    // service that constructs the adapter, or that container dies at startup
    // with "TMS adapter config env var is missing: <env>"
    const compose = parseYaml(
      await readFile(join(repoDir, "deploy/appliance/docker-compose.yml"), "utf8")
    ) as { services: Record<string, { environment?: Record<string, string> }> };
    for (const service of ["quoteops-agent", "quoteops-api", "quoteops-onboard"]) {
      for (const envName of adapterEnvNames) {
        expect(
          compose.services[service]?.environment ?? {},
          `${service} must define ${envName}`
        ).toHaveProperty(envName);
      }
    }
  });
});

async function materializeFiles(rootDir: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = join(rootDir, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
}
