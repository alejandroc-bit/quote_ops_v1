import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(new URL("../../../scripts/dev-install-quoteops.sh", import.meta.url));
const tempDirs: string[] = [];

afterEach(async () => {
  tempDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function runScript(args: string[], env: Record<string, string>) {
  return spawnSync("bash", [scriptPath, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf-8",
    timeout: 15000
  });
}

describe("dev-install-quoteops.sh preflight", () => {
  it("prints help and exits 0", () => {
    const result = runScript(["--help"], {});
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("openrouter-key");
  });

  it("refuses to run without required secret files", () => {
    const emptySecrets = mkdtempSync(join(tmpdir(), "quoteops-dev-secrets-empty-XXXXXX"));
    tempDirs.push(emptySecrets);
    const result = runScript([], {
      QUOTEOPS_DEV_SECRETS_DIR: emptySecrets,
      PATH: "/usr/bin:/bin"
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing secret file");
  });

  it("rejects an unknown option", () => {
    const result = runScript(["--bogus"], {});
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown option");
  });
});
