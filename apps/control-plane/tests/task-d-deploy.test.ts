import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

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
    expect(body).not.toContain("github.repository_owner");
  });
});
