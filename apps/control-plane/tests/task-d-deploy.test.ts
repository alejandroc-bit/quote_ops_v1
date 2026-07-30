import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { parseApplianceRelease } from "@quoteops/shared";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const execFile = promisify(execFileCallback);
const repoDir = new URL("../../../", import.meta.url);

type TarEntry = { name: string; mode: number; content: Buffer };

function readTarEntries(archive: Buffer): TarEntry[] {
  const tar = gunzipSync(archive);
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset < tar.length && !tar.subarray(offset, offset + 512).every((byte) => byte === 0)) {
    const header = tar.subarray(offset, offset + 512);
    const nul = (value: Buffer) => value.subarray(0, value.indexOf(0) === -1 ? value.length : value.indexOf(0)).toString();
    const name = nul(header.subarray(0, 100));
    const mode = Number.parseInt(nul(header.subarray(100, 108)).trim() || "0", 8);
    const size = Number.parseInt(nul(header.subarray(124, 136)).trim() || "0", 8);
    entries.push({ name, mode, content: tar.subarray(offset + 512, offset + 512 + size) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

async function read(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, new URL("../../../", import.meta.url)), "utf8");
}

describe("Task D appliance defaults", () => {
  it("uses the v1 home and exact GHCR image names throughout compose", async () => {
    const body = await read("deploy/appliance/docker-compose.yml");
    const compose = parseYaml(body) as {
      name: string;
      services: Record<string, { image?: string }>;
    };

    expect(compose.name).toBe("${COMPOSE_PROJECT_NAME:-quoteops_v1}");
    expect(compose.services["quoteops-agent"]?.image).toBe(
      "${QUOTEOPS_IMAGE_REGISTRY:-ghcr.io/alejandroc-bit}/quote-ops-agent:${QUOTEOPS_VERSION:-v0.1.0}"
    );
    expect(compose.services["quoteops-api"]?.image).toBe(
      "${QUOTEOPS_IMAGE_REGISTRY:-ghcr.io/alejandroc-bit}/quote-ops-api:${QUOTEOPS_VERSION:-v0.1.0}"
    );
    expect(compose.services["quoteops-web"]?.image).toBe(
      "${QUOTEOPS_IMAGE_REGISTRY:-ghcr.io/alejandroc-bit}/quote-ops-web:${QUOTEOPS_VERSION:-v0.1.0}"
    );
    expect(body).not.toMatch(/\/opt\/quoteops(?!-v1)(?:\/|\b)/);
    for (const service of ["quoteops-agent", "quoteops-api"]) {
      expect(body).toMatch(
        new RegExp(`${service}:[\\s\\S]*?QUOTEOPS_SETTINGS_PATH: /opt/quoteops-v1/settings/runtime-settings\\.json`)
      );
      expect(body).toMatch(
        new RegExp(`${service}:[\\s\\S]*?QUOTEOPS_PDF_TEMPLATE_PATH: /opt/quoteops-v1/settings/pdf-template\\.json`)
      );
      expect(body).toMatch(
        new RegExp(`${service}:[\\s\\S]*?- quoteops_settings:/opt/quoteops-v1/settings`)
      );
    }
    expect(body).toContain("quoteops_settings:");
    expect(body).toContain("device: ${QUOTEOPS_SETTINGS_DIR:-/opt/quoteops-v1/settings}");
  });

  it("uses /opt/quoteops-v1 in every operator lifecycle script", async () => {
    for (const script of ["install.sh", "upgrade.sh", "backup.sh", "restore.sh", "secrets.sh"]) {
      const body = await read(`deploy/appliance/${script}`);
      expect(body, script).toContain('QUOTEOPS_HOME="${QUOTEOPS_HOME:-/opt/quoteops-v1}"');
      expect(body, script).not.toMatch(/\/opt\/quoteops(?!-v1)(?:\/|\b)/);
    }
  });

  it("renders installer env with exact home, project, registry, paths, and v* version contract", async () => {
    const install = await read("deploy/appliance/install.sh");
    expect(install).toContain('QUOTEOPS_HOME="${QUOTEOPS_HOME:-/opt/quoteops-v1}"');
    expect(install).toContain('COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-quoteops_v1}"');
    expect(install).toContain(
      'QUOTEOPS_IMAGE_REGISTRY="${QUOTEOPS_IMAGE_REGISTRY:-ghcr.io/alejandroc-bit}"'
    );
    expect(install).toContain('QUOTEOPS_VERSION="${QUOTEOPS_VERSION:-v0.1.0}"');
    expect(install).toContain('[[ "$QUOTEOPS_VERSION" =~ ^v[0-9]+[.][0-9]+[.][0-9]+$ ]]');
    expect(install).not.toMatch(/QUOTEOPS_VERSION=.*quoteops-v/);
    for (const path of [
      "/opt/quoteops-v1/connectors/agent/agent-config.yaml",
      "/opt/quoteops-v1/connectors/tms-adapter.yaml",
      "/opt/quoteops-v1/connectors/tms/performance.csv",
      "/opt/quoteops-v1/connectors/tms/quote-writebacks.jsonl"
    ]) {
      expect(install).toContain(path);
    }
    expect(install).toContain('write_env_line COMPOSE_PROJECT_NAME "$COMPOSE_PROJECT_NAME"');
    expect(install).toContain('write_env_line QUOTEOPS_IMAGE_REGISTRY "$QUOTEOPS_IMAGE_REGISTRY"');
    expect(install).toContain('write_env_line QUOTEOPS_VERSION "$QUOTEOPS_VERSION"');
    expect(install).toContain('QUOTEOPS_SETTINGS_DIR="${QUOTEOPS_SETTINGS_DIR:-$QUOTEOPS_HOME/settings}"');
    expect(install).toContain('write_env_line QUOTEOPS_SETTINGS_DIR "$QUOTEOPS_SETTINGS_DIR"');
  });

  it("smoke-validates the exact v2.0.0 image tag", async () => {
    const smoke = await read("deploy/appliance/tests/smoke.sh");
    expect(smoke).toContain("QUOTEOPS_VERSION=v2.0.0");
    expect(smoke).not.toMatch(/QUOTEOPS_VERSION=quoteops-[^\s]+/);
    expect(smoke).toContain("quote-ops-agent:v2.0.0");
  });
});

describe("Task D workflows", () => {
  it("builds and runs the full Vitest suite on pull requests and main", async () => {
    const body = await read(".github/workflows/ci.yml");
    const workflow = parseYaml(body) as Record<string, unknown>;
    expect(workflow).toHaveProperty("on.pull_request");
    expect(workflow).toHaveProperty("on.push.branches", ["main"]);
    expect(body).toMatch(/run: npm run build(?:\s|$)/);
    expect(body).toContain("run: npx vitest run");
  });

  it("publishes exact amd64 GHCR images from v* tags", async () => {
    const body = await read(".github/workflows/release.yml");
    expect(body).toContain('- "v*"');
    expect(body).toContain("platforms: linux/amd64");
    for (const image of ["quote-ops-agent", "quote-ops-api", "quote-ops-web"]) {
      expect(body).toContain(`image: ${image}`);
      expect(body).toContain(`ghcr.io/alejandroc-bit/\${{ matrix.image }}`);
    }
    expect(body).toContain("needs: verify");
    expect(body).toContain("verify-anonymous-pulls:");
    expect(body).toContain("docker pull \"$reference\"");
    expect(body).toContain("steps.build.outputs.digest");
    expect(body).not.toContain("tags: ghcr.io/alejandroc-bit/${{ matrix.image }}:latest");
    expect(body).not.toContain("github.repository_owner");
  });
});

describe("appliance release contract", () => {
  it("accepts immutable linux/amd64 releases and rejects mutable image references", () => {
    const release = parseApplianceRelease({
      schema_version: 1,
      version: "v0.2.0",
      git_sha: "0123456789abcdef0123456789abcdef01234567",
      platform: "linux/amd64",
      images: {
        agent:
          "ghcr.io/alejandroc-bit/quote-ops-agent:v0.2.0@sha256:" + "1".repeat(64),
        api: "ghcr.io/alejandroc-bit/quote-ops-api:v0.2.0@sha256:" + "2".repeat(64),
        web: "ghcr.io/alejandroc-bit/quote-ops-web:v0.2.0@sha256:" + "3".repeat(64),
        postgres: "postgres:16-alpine@sha256:" + "4".repeat(64),
        redis: "redis:7-alpine@sha256:" + "5".repeat(64),
        caddy: "caddy:2-alpine@sha256:" + "6".repeat(64),
        cloudflared:
          "cloudflare/cloudflared:2026.7.3@sha256:e39ee8da81ad5e05d77f38d2f51c60ca51bf2a8450ac3abab50c17fdb91d91bf"
      },
      files_sha256: { "docker-compose.yml": "a".repeat(64) },
      created_at: "2026-07-29T18:00:00.000Z"
    });

    expect(release.version).toBe("v0.2.0");
    expect(() =>
      parseApplianceRelease({
        ...release,
        images: { ...release.images, api: "ghcr.io/alejandroc-bit/quote-ops-api:latest" }
      })
    ).toThrow(/digest-pinned|semver tag/i);
    expect(() =>
      parseApplianceRelease({
        ...release,
        images: { ...release.images, postgres: "postgres:latest@sha256:" + "4".repeat(64) }
      })
    ).toThrow(/latest is forbidden/i);
    expect(() =>
      parseApplianceRelease({
        ...release,
        platform: "linux/arm64"
      })
    ).toThrow(/linux\/amd64/i);
    expect(() =>
      parseApplianceRelease({
        ...release,
        images: { ...release.images, cloudflared: "cloudflare/cloudflared:latest" }
      })
    ).toThrow(/digest-pinned/i);
    expect(() =>
      parseApplianceRelease({
        ...release,
        images: {
          ...release.images,
          api: "ghcr.io/alejandroc-bit/quote-ops-api:v0.1.9@sha256:" + "2".repeat(64)
        }
      })
    ).toThrow(/must equal v0\.2\.0/i);
  });
});

describe("immutable appliance bundle", () => {
  const runtimeAssets = [
    "docker-compose.yml",
    "Caddyfile",
    "install.sh",
    "quoteops.sh",
    "verify-install.sh",
    "upgrade.sh",
    "backup.sh",
    "restore.sh",
    "secrets.sh"
  ];
  const requiredAssets = ["release.json", "PAYLOAD_SHA256SUMS", "release.env", ...runtimeAssets];

  async function createFixture(): Promise<{ root: string; assets: string; output: string }> {
    const root = await mkdtemp(join(tmpdir(), "quoteops-appliance-"));
    const assets = join(root, "assets");
    const output = join(root, "output");
    await mkdir(assets);
    await Promise.all(
      runtimeAssets.map(async (name) => {
        const path = join(assets, name);
        await writeFile(path, `fixture for ${name}\n`);
        if (name.endsWith(".sh")) await chmod(path, 0o755);
      })
    );
    await writeFile(join(assets, "bootstrap.sh"), "#!/usr/bin/env bash\necho bootstrap\n");
    await chmod(join(assets, "bootstrap.sh"), 0o755);
    return { root, assets, output };
  }

  async function packageFixture(assets: string, output: string): Promise<void> {
    await execFile(
      "node",
      [
        "scripts/package-appliance-release.mjs",
        "--version", "v0.2.0",
        "--git-sha", "0123456789abcdef0123456789abcdef01234567",
        "--assets-dir", assets,
        "--output-dir", output,
        "--agent-digest", "sha256:" + "1".repeat(64),
        "--api-digest", "sha256:" + "2".repeat(64),
        "--web-digest", "sha256:" + "3".repeat(64),
        "--postgres-image", "postgres:16-alpine@sha256:" + "4".repeat(64),
        "--redis-image", "redis:7-alpine@sha256:" + "5".repeat(64),
        "--caddy-image", "caddy:2-alpine@sha256:" + "6".repeat(64),
        "--cloudflared-image", "cloudflare/cloudflared:2026.7.3@sha256:e39ee8da81ad5e05d77f38d2f51c60ca51bf2a8450ac3abab50c17fdb91d91bf"
      ],
      { cwd: repoDir, env: { ...process.env, SOURCE_DATE_EPOCH: "1785348000" } }
    );
  }

  it("creates a reproducible bundle with only declared runtime assets", async () => {
    const fixture = await createFixture();
    try {
      await packageFixture(fixture.assets, fixture.output);
      const bundle = join(fixture.output, "quoteops-appliance-v0.2.0.tar.gz");
      const first = await readFile(bundle);
      const entries = readTarEntries(first);
      const byName = new Map(entries.map((entry) => [entry.name, entry]));
      const release = JSON.parse(byName.get("release.json")!.content.toString());
      const sums = (await readFile(join(fixture.output, "SHA256SUMS"), "utf8")).trim().split("\n");

      expect(entries.map((entry) => entry.name).sort()).toEqual(requiredAssets.sort());
      expect(Object.keys(release.files_sha256).sort()).toEqual(
        requiredAssets.filter((name) => !["release.json", "PAYLOAD_SHA256SUMS"].includes(name)).sort()
      );
      expect(release.files_sha256["docker-compose.yml"]).toMatch(/^[a-f0-9]{64}$/);
      expect(sums).toHaveLength(3);
      expect(sums.map((line) => line.slice(66))).toEqual([...sums.map((line) => line.slice(66))].sort());
      expect(sums.every((line) => /^[a-f0-9]{64}  (bootstrap\.sh|quoteops-appliance-v0\.2\.0\.tar\.gz|release\.json)$/.test(line))).toBe(true);
      expect(byName.get("install.sh")!.mode).toBe(0o755);
      expect(byName.get("quoteops.sh")!.mode).toBe(0o755);
      expect(byName.get("docker-compose.yml")!.mode).toBe(0o644);
      expect(byName.has("bootstrap.sh")).toBe(false);

      const secondOutput = join(fixture.root, "second-output");
      await packageFixture(fixture.assets, secondOutput);
      expect(await readFile(join(secondOutput, "quoteops-appliance-v0.2.0.tar.gz"))).toEqual(first);

      await rm(join(fixture.assets, "install.sh"));
      await expect(packageFixture(fixture.assets, join(fixture.root, "missing-output"))).rejects.toThrow(/missing/i);
      await writeFile(join(fixture.assets, "install.sh"), "#!/usr/bin/env bash\n");
      await writeFile(join(fixture.assets, "unexpected.txt"), "extra\n");
      await expect(packageFixture(fixture.assets, join(fixture.root, "extra-output"))).rejects.toThrow(/unexpected|extra/i);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
