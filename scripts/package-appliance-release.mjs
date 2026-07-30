import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import tar from "tar-stream";

const root = resolve(new URL("..", import.meta.url).pathname);
const platform = "linux/amd64";
const applicationRegistry = "ghcr.io/alejandroc-bit";
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
const executableAssets = new Set(runtimeAssets.filter((name) => name.endsWith(".sh")));
const deploymentAsset = "bootstrap.sh";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || Object.hasOwn(options, key)) {
      fail("arguments must be unique --name value pairs");
    }
    options[key] = value;
  }
  const allowed = new Set([
    "--version", "--git-sha", "--assets-dir", "--output-dir", "--agent-digest", "--api-digest",
    "--web-digest", "--postgres-image", "--redis-image", "--caddy-image", "--cloudflared-image"
  ]);
  for (const key of Object.keys(options)) if (!allowed.has(key)) fail(`unknown option ${key}`);
  for (const key of ["--version", "--git-sha", "--agent-digest", "--api-digest", "--web-digest", "--postgres-image", "--redis-image", "--caddy-image", "--cloudflared-image"]) {
    if (!options[key]) fail(`missing required ${key}`);
  }
  if (!/^v\d+\.\d+\.\d+$/.test(options["--version"])) fail("--version must match ^v\\d+\\.\\d+\\.\\d+$");
  if (!/^[a-f0-9]{40}$/.test(options["--git-sha"])) fail("--git-sha must be a 40-character lowercase SHA");
  for (const key of ["--agent-digest", "--api-digest", "--web-digest"]) {
    if (!/^sha256:[a-f0-9]{64}$/.test(options[key])) fail(`${key} must be a sha256 digest`);
  }
  for (const key of ["--postgres-image", "--redis-image", "--caddy-image", "--cloudflared-image"]) {
    if (!/^[^@\s]+@sha256:[a-f0-9]{64}$/.test(options[key]) || /:latest@sha256:/i.test(options[key])) {
      fail(`${key} must be a digest-pinned image and must not use latest`);
    }
  }
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (!/^[0-9]+$/.test(epoch ?? "")) fail("SOURCE_DATE_EPOCH must be an integer Unix timestamp");
  return {
    version: options["--version"], gitSha: options["--git-sha"], epoch: Number(epoch),
    assetsDir: resolve(root, options["--assets-dir"] ?? "deploy/appliance"),
    outputDir: resolve(root, options["--output-dir"] ?? join("dist", "appliance", options["--version"])),
    images: {
      agent: `${applicationRegistry}/quote-ops-agent:${options["--version"]}@${options["--agent-digest"]}`,
      api: `${applicationRegistry}/quote-ops-api:${options["--version"]}@${options["--api-digest"]}`,
      web: `${applicationRegistry}/quote-ops-web:${options["--version"]}@${options["--web-digest"]}`,
      postgres: options["--postgres-image"], redis: options["--redis-image"], caddy: options["--caddy-image"], cloudflared: options["--cloudflared-image"]
    }
  };
}

async function stageAssets(options) {
  const names = (await readdir(options.assetsDir)).sort();
  const expected = [...runtimeAssets, deploymentAsset].sort();
  const missing = expected.filter((name) => !names.includes(name));
  const extra = names.filter((name) => !expected.includes(name));
  if (missing.length) fail(`missing declared assets: ${missing.join(", ")}`);
  if (extra.length) fail(`unexpected assets: ${extra.join(", ")}`);
  const staging = await mkdtemp(join(tmpdir(), "quoteops-appliance-stage-"));
  for (const name of runtimeAssets) {
    const destination = join(staging, name);
    await copyFile(join(options.assetsDir, name), destination);
    await chmod(destination, executableAssets.has(name) ? 0o755 : 0o644);
  }
  const releaseEnv = [
    `QUOTEOPS_VERSION=${options.version}`,
    `QUOTEOPS_PLATFORM=${platform}`,
    `QUOTEOPS_AGENT_IMAGE=${options.images.agent}`,
    `QUOTEOPS_API_IMAGE=${options.images.api}`,
    `QUOTEOPS_WEB_IMAGE=${options.images.web}`,
    `QUOTEOPS_POSTGRES_IMAGE=${options.images.postgres}`,
    `QUOTEOPS_REDIS_IMAGE=${options.images.redis}`,
    `QUOTEOPS_CADDY_IMAGE=${options.images.caddy}`,
    `QUOTEOPS_CLOUDFLARED_IMAGE=${options.images.cloudflared}`,
    ""
  ].join("\n");
  await writeFile(join(staging, "release.env"), releaseEnv, { mode: 0o644 });
  await chmod(join(staging, "release.env"), 0o644);
  const fileNames = [...runtimeAssets, "release.env"].sort();
  const filesSha256 = {};
  for (const name of fileNames) filesSha256[name] = sha256(await readFile(join(staging, name)));
  const release = {
    schema_version: 1,
    version: options.version,
    git_sha: options.gitSha,
    platform,
    images: options.images,
    files_sha256: filesSha256,
    created_at: new Date(options.epoch * 1000).toISOString()
  };
  await writeFile(join(staging, "release.json"), `${JSON.stringify(release, null, 2)}\n`, { mode: 0o644 });
  await chmod(join(staging, "release.json"), 0o644);
  const archivedNames = [...fileNames, "release.json"].sort();
  const payloadSums = (await Promise.all(archivedNames.map(async (name) => `${sha256(await readFile(join(staging, name)))}  ${name}`))).join("\n") + "\n";
  await writeFile(join(staging, "PAYLOAD_SHA256SUMS"), payloadSums, { mode: 0o644 });
  await chmod(join(staging, "PAYLOAD_SHA256SUMS"), 0o644);
  return staging;
}

async function append(pack, name, content, mode, mtime) {
  await new Promise((resolveEntry, rejectEntry) => {
    pack.entry({ name, mode, uid: 0, gid: 0, mtime }, content, (error) => error ? rejectEntry(error) : resolveEntry());
  });
}

async function writeArchive(staging, destination, epoch) {
  const pack = tar.pack();
  const mtime = new Date(epoch * 1000);
  const archivePromise = pipeline(pack, createGzip({ mtime: 0 }), createWriteStream(destination));
  for (const name of (await readdir(staging)).sort()) {
    await append(pack, name, await readFile(join(staging, name)), executableAssets.has(name) ? 0o755 : 0o644, mtime);
  }
  pack.finalize();
  await archivePromise;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const staging = await stageAssets(options);
  try {
    await mkdir(options.outputDir, { recursive: true });
    const archiveName = `quoteops-appliance-${options.version}.tar.gz`;
    const archive = join(options.outputDir, archiveName);
    const manifest = join(options.outputDir, "release.json");
    const bootstrap = join(options.outputDir, deploymentAsset);
    await writeArchive(staging, archive, options.epoch);
    await copyFile(join(staging, "release.json"), manifest);
    await copyFile(join(options.assetsDir, deploymentAsset), bootstrap);
    await chmod(bootstrap, 0o755);
    const sums = [archiveName, "bootstrap.sh", "release.json"].sort().map(async (name) => `${sha256(await readFile(join(options.outputDir, name)))}  ${name}`);
    await writeFile(join(options.outputDir, "SHA256SUMS"), `${(await Promise.all(sums)).join("\n")}\n`, { mode: 0o644 });
    console.log(archive);
    console.log(manifest);
    console.log(bootstrap);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
