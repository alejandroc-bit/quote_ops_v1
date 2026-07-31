#!/usr/bin/env node
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, relative, resolve, sep } from "node:path";

const REQUIRED_REPORT_FIELDS = [
  { key: "commit_sha", label: "Commit SHA", pattern: /\b([a-f0-9]{40})\b/i },
  { key: "release_version", label: "Release version", pattern: /\bRelease version:\s*(v\d+\.\d+\.\d+)\b/i },
  { key: "utc_run_id", label: "UTC run ID", pattern: /\bUTC run ID:\s*([0-9A-Za-z]+)\b/i },
  { key: "result", label: "Result", pattern: /\bResult:\s*(pass|fail)\b/i },
  { key: "retention", label: "Retention", pattern: /\bRetention:\s*(retain_until_user_review)\b/i }
];

const REQUIRED_SCREENSHOT_IDS = [
  "01-azure-vm-overview",
  "02-azure-ubuntu-preflight",
  "03-hostinger-supabase-stack",
  "04-tms-seed-counts",
  "05-tms-contract-pass",
  "06-azure-install-version",
  "07-quoteops-onboarding-ready",
  "08-cloudflare-tunnel-healthy",
  "09-cloudflare-access-policy",
  "10-cloudflare-protected-origin",
  "11-quote-request",
  "12-quote-result",
  "13-supabase-writeback",
  "14-post-restart-ready"
];

const SCREENSHOT_SCHEMA_KEYS = new Set([
  "id", "file", "captured_at", "browser", "surface", "assertion", "result", "sensitive_ui_excluded"
]);

const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._-]{8,}/i,
  /TUNNEL_TOKEN[=:]\s*\S+/i,
  /API_KEY[=:]\s*\S+/i,
  /registration_token[=:]\s*\S+/i,
  /CF-Access-Client-Secret[=:]\s*\S+/i,
  /\bToken[=:]\s*\S+/i,
  /\bsk-[A-Za-z0-9-]{8,}/,
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/
];

function fail(dir, message) {
  console.log(`BROWSER E2E EVIDENCE: FAIL\n${dir}\n- ${message}`);
  process.exit(1);
}

function isPng(path) {
  try {
    const fd = readFileSync(path, { flag: "r" });
    return fd.length >= 8 && fd[0] === 0x89 && fd[1] === 0x50 && fd[2] === 0x4e && fd[3] === 0x47;
  } catch {
    return false;
  }
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const evidenceDir = process.argv[2];
if (!evidenceDir) {
  console.log("usage: validate-browser-evidence.mjs <evidence-directory>");
  process.exit(2);
}
const dir = resolve(evidenceDir);
if (!existsSync(dir) || !statSync(dir).isDirectory()) {
  console.log(`BROWSER E2E EVIDENCE: FAIL\n- evidence directory not found: ${dir}`);
  process.exit(1);
}

const reportPath = join(dir, "report.md");
if (!existsSync(reportPath)) fail(dir, "report.md is missing");
const report = readFileSync(reportPath, "utf8");

const screenshotsJsonPath = join(dir, "screenshots.json");
if (!existsSync(screenshotsJsonPath)) fail(dir, "screenshots.json is missing");
let screenshotsJson;
try {
  screenshotsJson = JSON.parse(readFileSync(screenshotsJsonPath, "utf8"));
} catch (e) {
  fail(dir, `screenshots.json is not valid JSON: ${e.message}`);
}
if (!Array.isArray(screenshotsJson)) fail(dir, "screenshots.json must be an array");

const seenIds = new Set();
const referencedFiles = [];
for (const entry of screenshotsJson) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(dir, "screenshots.json entries must be objects");
  for (const key of Object.keys(entry)) {
    if (!SCREENSHOT_SCHEMA_KEYS.has(key)) fail(dir, `unknown screenshots.json field: ${key}`);
  }
  if (typeof entry.id !== "string" || !entry.id) fail(dir, "screenshot entry missing id");
  if (typeof entry.file !== "string" || !entry.file) fail(dir, `screenshot ${entry.id} missing file`);
  seenIds.add(entry.id);
  const file = entry.file;
  if (file.includes("..") || file.startsWith("/") || file.startsWith("\\")) {
    fail(dir, `screenshot path must be relative and bounded: ${file}`);
  }
  const absFile = join(dir, "screenshots", file);
  const relCheck = relative(join(dir, "screenshots"), absFile);
  if (relCheck.startsWith("..") || relCheck.includes(`..${sep}`)) {
    fail(dir, `screenshot path escapes the evidence directory: ${file}`);
  }
  referencedFiles.push(file);
}

for (const id of REQUIRED_SCREENSHOT_IDS) {
  if (!seenIds.has(id)) fail(dir, `required screenshot missing or unreferenced: ${id}`);
}

const shaPath = join(dir, "SHA256SUMS");
if (!existsSync(shaPath)) fail(dir, "SHA256SUMS is missing");
const shaLines = readFileSync(shaPath, "utf8").split(/\r?\n/).filter(Boolean);
const shaMap = new Map();
for (const line of shaLines) {
  const m = /^([a-f0-9]{64})\s+(\S+)$/.exec(line.trim());
  if (!m) fail(dir, `SHA256SUMS line is malformed: ${line}`);
  shaMap.set(m[2], m[1]);
}

for (const file of referencedFiles) {
  const abs = join(dir, "screenshots", file);
  if (!existsSync(abs)) fail(dir, `screenshot file not found: ${file}`);
  if (!isPng(abs)) fail(dir, `screenshot is not a PNG: ${file}`);
  const expected = shaMap.get(`screenshots/${file}`);
  if (!expected) fail(dir, `no SHA256SUMS entry for screenshot: ${file}`);
  const actual = sha256File(abs);
  if (actual !== expected) fail(dir, `SHA256 mismatch for screenshot: ${file}`);
}

for (const { label, pattern } of REQUIRED_REPORT_FIELDS) {
  if (!pattern.test(report)) fail(dir, `report is missing required field: ${label}`);
}

let screenshotAssertionCount = 0;
for (const id of REQUIRED_SCREENSHOT_IDS) {
  if (new RegExp(`${id}\\.png`).test(report)) screenshotAssertionCount++;
}
if (screenshotAssertionCount === 0) {
  fail(dir, "report has no screenshot assertions");
}

for (const pattern of SECRET_PATTERNS) {
  if (pattern.test(report)) fail(dir, "report contains a secret pattern");
  if (pattern.test(readFileSync(screenshotsJsonPath, "utf8"))) fail(dir, "screenshots.json contains a secret pattern");
  if (pattern.test(readFileSync(shaPath, "utf8"))) fail(dir, "SHA256SUMS contains a secret pattern");
}

const strayFiles = readdirSync(dir).filter((f) => !["report.md", "screenshots.json", "SHA256SUMS", "screenshots"].includes(f));
if (strayFiles.length) {
  // non-fatal warning, but report
  console.log(`(warning: extra files in evidence dir: ${strayFiles.join(", ")})`);
}

console.log(`BROWSER E2E EVIDENCE: PASS\n${dir}`);
process.exit(0);
