import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const validator = resolve(__dirname, "../../scripts/validate-browser-evidence.mjs");

const REQUIRED_SCREENSHOTS = [
  "01-azure-vm-overview.png",
  "02-azure-ubuntu-preflight.png",
  "03-hostinger-supabase-stack.png",
  "04-tms-seed-counts.png",
  "05-tms-contract-pass.png",
  "06-azure-install-version.png",
  "07-quoteops-onboarding-ready.png",
  "08-cloudflare-tunnel-healthy.png",
  "09-cloudflare-access-policy.png",
  "10-cloudflare-protected-origin.png",
  "11-quote-request.png",
  "12-quote-result.png",
  "13-supabase-writeback.png",
  "14-post-restart-ready.png"
];

function pngBytes(size = 256): Buffer {
  const buf = Buffer.alloc(size);
  buf[0] = 0x89;
  buf[1] = 0x50;
  buf[2] = 0x4e;
  buf[3] = 0x47;
  return buf;
}

function sha256File(path: string): string {
  return execFileSync("shasum", ["-a", "256", path], { encoding: "utf-8" }).split(/\s+/)[0];
}

type Fixture = {
  screenshots: string[];
  pngFor?: Record<string, Buffer>;
  screenshotsJson?: Array<Record<string, unknown>>;
  reportBody?: string;
};

function defaultReportBody(): string {
  return [
    "# Aceptación E2E en Azure, Hostinger y Cloudflare",
    "",
    `Commit SHA: ${"a".repeat(40)}`,
    "Release version: v0.2.0",
    "UTC run ID: 20260730T120000Z",
    "Result: pass",
    "Retention: retain_until_user_review",
    "Screenshot 01-azure-vm-overview.png PASS",
    ""
  ].join("\n");
}

function defaultScreenshotsJson(): Array<Record<string, unknown>> {
  return REQUIRED_SCREENSHOTS.map((s) => ({
    id: s.replace(/\.png$/, ""),
    file: s,
    captured_at: "2026-07-30T12:00:00Z",
    browser: "chrome",
    surface: "quoteops",
    assertion: "placeholder",
    result: "pass",
    sensitive_ui_excluded: true
  }));
}

function writeEvidence(dir: string, fixture: Fixture): void {
  const screenshots = fixture.screenshots ?? REQUIRED_SCREENSHOTS;
  mkdirSync(join(dir, "screenshots"), { recursive: true });
  for (const name of screenshots) {
    const buf = fixture.pngFor?.[name] ?? pngBytes(256);
    writeFileSync(join(dir, "screenshots", name), buf);
  }
  writeFileSync(join(dir, "screenshots.json"), `${JSON.stringify(fixture.screenshotsJson ?? defaultScreenshotsJson(), null, 2)}\n`);
  writeFileSync(join(dir, "report.md"), fixture.reportBody ?? defaultReportBody());
  const sums = screenshots.map((s) => `${sha256File(join(dir, "screenshots", s))}  screenshots/${s}`).join("\n");
  writeFileSync(join(dir, "SHA256SUMS"), `${sums}\n`);
}

function runValidator(dir: string): { status: number; stdout: string; stderr: string } {
  try {
    const out = execFileSync("node", [validator, dir], { encoding: "utf-8" });
    return { status: 0, stdout: out, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

const tempRoots: string[] = [];
afterEach(() => {
  tempRoots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
function mkdtmp(): string {
  const d = mkdtempSync(join(tmpdir(), "browser-evidence-"));
  tempRoots.push(d);
  return d;
}

describe("browser evidence validation", () => {
  it("passes a valid evidence bundle", () => {
    const dir = mkdtmp();
    writeEvidence(dir, { screenshots: REQUIRED_SCREENSHOTS });
    const result = runValidator(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("BROWSER E2E EVIDENCE: PASS");
  });

  it("fails when report.md is absent", () => {
    const dir = mkdtmp();
    writeEvidence(dir, { screenshots: REQUIRED_SCREENSHOTS });
    rmSync(join(dir, "report.md"));
    expect(runValidator(dir).status).not.toBe(0);
  });

  it("fails when a required screenshot is absent", () => {
    const dir = mkdtmp();
    writeEvidence(dir, { screenshots: REQUIRED_SCREENSHOTS.slice(1) });
    expect(runValidator(dir).status).not.toBe(0);
  });

  it("fails when screenshots.json has an unknown field", () => {
    const dir = mkdtmp();
    writeEvidence(dir, {
      screenshots: REQUIRED_SCREENSHOTS,
      screenshotsJson: defaultScreenshotsJson().map((s) => ({ ...s, extra_field: "bad" }))
    });
    expect(runValidator(dir).status).not.toBe(0);
  });

  it("fails when a screenshot path is absolute or escapes the evidence dir", () => {
    const dir = mkdtmp();
    const bad = defaultScreenshotsJson().map((s) =>
      s.id === "01-azure-vm-overview" ? { ...s, file: "/etc/passwd" } : s
    );
    writeEvidence(dir, { screenshots: REQUIRED_SCREENSHOTS, screenshotsJson: bad });
    expect(runValidator(dir).status).not.toBe(0);
  });

  it("fails when SHA256SUMS does not match the PNG bytes", () => {
    const dir = mkdtmp();
    writeEvidence(dir, { screenshots: REQUIRED_SCREENSHOTS });
    writeFileSync(join(dir, "screenshots", "01-azure-vm-overview.png"), pngBytes(999));
    expect(runValidator(dir).status).not.toBe(0);
  });

  it("fails when the report contains a secret pattern", () => {
    const dir = mkdtmp();
    const body = `${defaultReportBody()}Token: sk-leaked-secret-value-here\n`;
    writeEvidence(dir, { screenshots: REQUIRED_SCREENSHOTS, reportBody: body });
    expect(runValidator(dir).status).not.toBe(0);
  });

  it("fails when the report omits a required field (release version)", () => {
    const dir = mkdtmp();
    const body = defaultReportBody().replace("Release version: v0.2.0\n", "");
    writeEvidence(dir, { screenshots: REQUIRED_SCREENSHOTS, reportBody: body });
    expect(runValidator(dir).status).not.toBe(0);
  });
});
