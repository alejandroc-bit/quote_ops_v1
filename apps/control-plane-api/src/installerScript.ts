import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import type { InstallPack } from "@quoteops/control-plane";
import {
  parseApplianceRelease,
  type ApplianceRelease
} from "@quoteops/shared";

export const MAX_INSTALLER_RESPONSE_BYTES = 4_000_000;
const BOOTSTRAP_PLACEHOLDER = "__QUOTEOPS_CONTROL_PLANE_URL__";

export async function loadBootstrapScript({
  applianceReleaseRoot,
  applianceReleaseVersion,
  controlPlaneUrl
}: {
  applianceReleaseRoot: string;
  applianceReleaseVersion: string;
  controlPlaneUrl: string;
}): Promise<string> {
  if (!/^v\d+\.\d+\.\d+$/.test(applianceReleaseVersion)) {
    throw new Error("invalid_appliance_release_version");
  }
  const physicalRoot = resolve(applianceReleaseRoot);
  const releaseDirectory = join(physicalRoot, applianceReleaseVersion);
  const [bootstrapBytes, checksumBytes] = await Promise.all([
    readFile(join(releaseDirectory, "bootstrap.sh")),
    readFile(join(releaseDirectory, "SHA256SUMS"), "utf8")
  ]);
  const bootstrapEntries = checksumBytes
    .split("\n")
    .map((line) => /^([a-f0-9]{64})  bootstrap\.sh$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null);
  if (
    bootstrapEntries.length !== 1 ||
    sha256(bootstrapBytes) !== bootstrapEntries[0]![1]
  ) {
    throw new Error("bootstrap_checksum_mismatch");
  }
  const template = bootstrapBytes.toString("utf8");
  if (template.split(BOOTSTRAP_PLACEHOLDER).length !== 2) {
    throw new Error("bootstrap_placeholder_invalid");
  }
  return template.replace(
    BOOTSTRAP_PLACEHOLDER,
    escapeShellDoubleQuoted(controlPlaneUrl)
  );
}

const CLIENT_OVERLAY_FILES = new Set([
  "client-manifest.yaml",
  "criteria-template.yaml",
  "connectors/agent/agent-config.yaml",
  "connectors/knowledge/README.md",
  "connectors/tms-adapter.yaml",
  "connectors/tms/rfqs.csv",
  "connectors/tms/historical-quotes.csv",
  "connectors/tms/historical-shipments.csv",
  "connectors/tms/customers.csv",
  "connectors/tms/agreements.csv",
  "connectors/tms/unit-positions.csv",
  "connectors/tms/units.csv",
  "connectors/tms/performance.csv",
  "connectors/tms/availability-zones.csv",
  "connectors/tms/quote-writebacks.jsonl",
  "connectors/tms/status-writebacks.jsonl",
  "connectors/tms-http-contract.md",
  "connectors/tms-sql-contract.md"
]);

type ArchiveEntry = {
  name: string;
  bytes: Buffer;
};

export function validateReleaseArchive({
  archiveBytes,
  bundleSha256,
  manifest,
  manifestBytes
}: {
  archiveBytes: Buffer;
  bundleSha256: string;
  manifest: ApplianceRelease;
  manifestBytes?: Uint8Array;
}): Map<string, Buffer> {
  const parsedManifest = parseApplianceRelease(manifest);
  if (
    !/^[a-f0-9]{64}$/.test(bundleSha256) ||
    sha256(archiveBytes) !== bundleSha256
  ) {
    throw new Error("release_bundle_hash_mismatch");
  }
  const entries = parseTarGzip(archiveBytes);
  const byName = new Map(entries.map((entry) => [entry.name, entry.bytes]));
  const expected = new Set([
    ...Object.keys(parsedManifest.files_sha256),
    "release.json",
    "PAYLOAD_SHA256SUMS"
  ]);
  for (const name of expected) {
    if (!byName.has(name)) throw new Error(`release_archive_missing:${name}`);
  }
  for (const requiredName of ["install.sh", "release.env"]) {
    if (!Object.hasOwn(parsedManifest.files_sha256, requiredName)) {
      throw new Error(`release_manifest_missing:${requiredName}`);
    }
  }
  for (const name of byName.keys()) {
    if (!expected.has(name)) throw new Error(`release_archive_extra:${name}`);
  }
  const releaseJson = byName.get("release.json")!;
  if (
    manifestBytes &&
    !releaseJson.equals(Buffer.from(manifestBytes))
  ) {
    throw new Error("release_manifest_bytes_mismatch");
  }
  let archiveManifest: ApplianceRelease;
  try {
    archiveManifest = parseApplianceRelease(
      JSON.parse(releaseJson.toString("utf8")) as unknown
    );
  } catch {
    throw new Error("release_archive_manifest_invalid");
  }
  if (
    archiveManifest.version !== parsedManifest.version ||
    canonicalJson(archiveManifest) !== canonicalJson(parsedManifest)
  ) {
    throw new Error("release_archive_manifest_mismatch");
  }
  for (const [name, expectedSha256] of Object.entries(
    parsedManifest.files_sha256
  )) {
    if (sha256(byName.get(name)!) !== expectedSha256) {
      throw new Error(`release_payload_hash_mismatch:${name}`);
    }
  }
  const expectedReleaseEnv = [
    `QUOTEOPS_VERSION=${parsedManifest.version}`,
    `QUOTEOPS_PLATFORM=${parsedManifest.platform}`,
    `QUOTEOPS_AGENT_IMAGE=${parsedManifest.images.agent}`,
    `QUOTEOPS_API_IMAGE=${parsedManifest.images.api}`,
    `QUOTEOPS_WEB_IMAGE=${parsedManifest.images.web}`,
    `QUOTEOPS_POSTGRES_IMAGE=${parsedManifest.images.postgres}`,
    `QUOTEOPS_REDIS_IMAGE=${parsedManifest.images.redis}`,
    `QUOTEOPS_CADDY_IMAGE=${parsedManifest.images.caddy}`,
    `QUOTEOPS_CLOUDFLARED_IMAGE=${parsedManifest.images.cloudflared}`,
    ""
  ].join("\n");
  if (byName.get("release.env")!.toString("utf8") !== expectedReleaseEnv) {
    throw new Error("release_env_manifest_mismatch");
  }
  const expectedPayloadSums =
    [...Object.keys(parsedManifest.files_sha256), "release.json"]
      .sort()
      .map((name) => `${sha256(byName.get(name)!)}  ${name}`)
      .join("\n") + "\n";
  if (
    byName.get("PAYLOAD_SHA256SUMS")!.toString("utf8") !==
    expectedPayloadSums
  ) {
    throw new Error("release_payload_sums_mismatch");
  }
  return byName;
}

export function renderInstallerScript({
  pack,
  archiveBytes,
  bundleSha256,
  manifest
}: {
  pack: InstallPack;
  archiveBytes: Buffer;
  bundleSha256: string;
  manifest: ApplianceRelease;
}): string {
  if (
    pack.release.version !== manifest.version ||
    pack.release.bundle_sha256 !== bundleSha256
  ) {
    throw new Error("install_pack_release_mismatch");
  }
  const archive = validateReleaseArchive({
    archiveBytes,
    bundleSha256,
    manifest
  });
  validateOverlayFiles(pack.files, new Set(archive.keys()));
  const archiveNames = [...archive.keys()].sort();
  const overlayWrites = Object.entries(pack.files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, content]) => {
      const encoded = Buffer.from(content, "utf8").toString("base64");
      const directory = path.includes("/")
        ? path.slice(0, path.lastIndexOf("/"))
        : ".";
      return [
        `install -d -m 0755 -- "$extract_dir/${shellSingleQuote(directory)}"`,
        `printf '%s' '${encoded}' | decode_base64 > "$extract_dir/${shellSingleQuote(path)}"`,
        `chmod 0644 -- "$extract_dir/${shellSingleQuote(path)}"`
      ].join("\n");
    })
    .join("\n");
  const hashChecks = Object.entries(manifest.files_sha256)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([name, expected]) =>
        `[ "$(sha256_file "$extract_dir/${shellSingleQuote(name)}")" = '${expected}' ] || fail 'release payload hash mismatch'`
    )
    .join("\n");
  const expectedNames = archiveNames
    .map((name) => shellSingleQuote(name))
    .join("\n");
  const archiveBase64 = archiveBytes.toString("base64");
  const releaseJsonBase64 = archive.get("release.json")!.toString("base64");

  const script = `#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf '%s\\n' "$1" >&2
  exit 1
}
decode_base64() {
  if base64 --help 2>&1 | grep -q -- '--decode'; then base64 --decode; else base64 -D; fi
}
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}

tmp_root="\${TMPDIR:-/tmp}"
tmp_root="\${tmp_root%/}"
extract_prefix="$tmp_root/quoteops-installer."
extract_dir="$(mktemp -d "$extract_prefixXXXXXX")"
cleanup() {
  status=$?
  trap - EXIT INT TERM
  cd /
  case "$extract_dir" in
    "$extract_prefix"*) rm -rf -- "$extract_dir" ;;
    *) printf '%s\\n' 'refusing unsafe installer cleanup path' >&2 ;;
  esac
  exit "$status"
}
trap cleanup EXIT INT TERM

archive_file="$extract_dir/release.tar.gz"
printf '%s' '${archiveBase64}' | decode_base64 > "$archive_file"
[ "$(sha256_file "$archive_file")" = '${bundleSha256}' ] || fail 'release bundle hash mismatch'

expected_names="$extract_dir/expected-names"
actual_names="$extract_dir/actual-names"
cat > "$expected_names" <<'QUOTEOPS_EXPECTED_NAMES'
${expectedNames}
QUOTEOPS_EXPECTED_NAMES
tar -tzf "$archive_file" > "$actual_names"
[ "$(wc -l < "$actual_names" | tr -d ' ')" = "$(sort -u "$actual_names" | wc -l | tr -d ' ')" ] || fail 'duplicate archive entry'
while IFS= read -r entry; do
  case "$entry" in
    /*|../*|*/../*|*/..|..|*\\\\*) fail 'unsafe archive path' ;;
  esac
done < "$actual_names"
LC_ALL=C sort "$actual_names" -o "$actual_names"
LC_ALL=C sort "$expected_names" -o "$expected_names"
cmp -s "$actual_names" "$expected_names" || fail 'archive entry set mismatch'
tar -tvzf "$archive_file" | awk 'substr($0,1,1) != "-" { exit 1 }' || fail 'non-regular archive entry'
tar -xzf "$archive_file" --no-same-owner --no-same-permissions -C "$extract_dir"
rm -f -- "$archive_file" "$actual_names" "$expected_names"

expected_release="$extract_dir/.expected-release.json"
printf '%s' '${releaseJsonBase64}' | decode_base64 > "$expected_release"
cmp -s "$expected_release" "$extract_dir/release.json" || fail 'release manifest bytes mismatch'
rm -f -- "$expected_release"
${hashChecks}
${overlayWrites}

[ -f "$extract_dir/release.env" ] || fail 'release.env missing'
grep -Eq '^QUOTEOPS_VERSION=${escapeEgrep(manifest.version)}$' "$extract_dir/release.env" || fail 'release.env version mismatch'
: "\${QUOTEOPS_REGISTRATION_TOKEN_FILE:?QUOTEOPS_REGISTRATION_TOKEN_FILE is required}"
[ -f "$QUOTEOPS_REGISTRATION_TOKEN_FILE" ] || fail 'registration token file is missing'

cd "$extract_dir"
set +e
bash install.sh \\
  --client '${shellSingleQuote(pack.client_id)}' \\
  --manifest client-manifest.yaml \\
  --connectors connectors \\
  --compose-file docker-compose.yml \\
  --control-plane-url '${shellSingleQuote(pack.control_plane_url)}' \\
  --registration-token-file "$QUOTEOPS_REGISTRATION_TOKEN_FILE" \\
  --installation-id '${shellSingleQuote(pack.installation_id)}' \\
  --version '${shellSingleQuote(pack.release.version)}' \\
  --guided \\
  "$@"
child_status=$?
set -e
exit "$child_status"
`;
  if (Buffer.byteLength(script, "utf8") > MAX_INSTALLER_RESPONSE_BYTES) {
    throw new Error("installer_response_too_large");
  }
  return script;
}

function validateOverlayFiles(
  files: Record<string, string>,
  archiveNames: ReadonlySet<string>
): void {
  const seen = new Set<string>();
  for (const [name, contents] of Object.entries(files)) {
    validateArchivePath(name);
    if (!CLIENT_OVERLAY_FILES.has(name)) {
      throw new Error(`install_pack_file_not_allowed:${name}`);
    }
    if (archiveNames.has(name)) {
      throw new Error(`install_pack_runtime_collision:${name}`);
    }
    if (seen.has(name)) throw new Error(`install_pack_file_duplicate:${name}`);
    if (typeof contents !== "string") {
      throw new Error(`install_pack_file_not_utf8:${name}`);
    }
    seen.add(name);
  }
}

function parseTarGzip(archiveBytes: Buffer): ArchiveEntry[] {
  let tarBytes: Buffer;
  try {
    tarBytes = gunzipSync(archiveBytes);
  } catch {
    throw new Error("release_archive_gzip_invalid");
  }
  const entries: ArchiveEntry[] = [];
  const names = new Set<string>();
  let offset = 0;
  let zeroBlocks = 0;
  while (offset + 512 <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      if (zeroBlocks >= 2) break;
      continue;
    }
    if (zeroBlocks) throw new Error("release_archive_invalid_trailer");
    validateTarChecksum(header);
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    validateArchivePath(fullName);
    if (names.has(fullName)) {
      throw new Error(`release_archive_duplicate:${fullName}`);
    }
    names.add(fullName);
    const type = header[156];
    if (type !== 0 && type !== 48) {
      throw new Error(`release_archive_non_regular:${fullName}`);
    }
    const size = readTarOctal(header, 124, 12);
    if (offset + size > tarBytes.length) {
      throw new Error("release_archive_truncated");
    }
    entries.push({
      name: fullName,
      bytes: Buffer.from(tarBytes.subarray(offset, offset + size))
    });
    offset += Math.ceil(size / 512) * 512;
  }
  if (zeroBlocks < 2) throw new Error("release_archive_missing_trailer");
  if (
    tarBytes.subarray(offset).some((byte) => byte !== 0)
  ) {
    throw new Error("release_archive_trailing_data");
  }
  return entries;
}

function validateTarChecksum(header: Buffer): void {
  const expected = readTarOctal(header, 148, 8);
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : header[index]!;
  }
  if (actual !== expected) throw new Error("release_archive_header_checksum");
}

function readTarString(
  bytes: Buffer,
  offset: number,
  length: number
): string {
  const raw = bytes.subarray(offset, offset + length);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul === -1 ? raw.length : nul).toString("utf8");
}

function readTarOctal(
  bytes: Buffer,
  offset: number,
  length: number
): number {
  const value = readTarString(bytes, offset, length).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error("release_archive_octal_invalid");
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("release_archive_size_invalid");
  }
  return parsed;
}

function validateArchivePath(name: string): void {
  if (
    !name ||
    /[\x00-\x1f\x7f]/.test(name) ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`unsafe_archive_path:${name}`);
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function shellSingleQuote(value: string): string {
  return value.replace(/'/g, "'\\''");
}

function escapeShellDoubleQuoted(value: string): string {
  return value.replace(/[\\"$`]/g, "\\$&");
}

function escapeEgrep(value: string): string {
  return value.replace(/[.[\]{}()*+?^$|\\]/g, "\\$&");
}
