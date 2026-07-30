import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  createInstallPack,
  createMinimalClientRecord,
  type MinimalClientRecord
} from "@quoteops/control-plane";
import { parsePublishedApplianceRelease } from "@quoteops/shared";
import {
  canonicalizeInstallPack,
  createDefaultControlPlaneData,
  type ControlPlaneData,
  type RegistrationTokenRecord
} from "./data/index.js";

export type AdminCliDependencies = {
  data?: ControlPlaneData;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  tokenGenerator?: () => string;
  writeLine?: (line: string) => void;
};

type ParsedArguments = {
  command: string;
  positionals: string[];
  controlPlaneUrl: string | null;
  ttlMinutes: number;
};

export async function runAdminCli(
  argv: string[],
  dependencies: AdminCliDependencies = {}
): Promise<void> {
  const parsed = parseArguments(argv);
  const writeLine = dependencies.writeLine ?? console.log;
  if (parsed.command === "help") {
    writeLine(usage());
    return;
  }

  const env = dependencies.env ?? process.env;
  const data = dependencies.data ?? createDatabaseData(env);
  const now = dependencies.now ?? (() => new Date());
  const tokenGenerator =
    dependencies.tokenGenerator ?? (() => crypto.randomBytes(24).toString("base64url"));

  if (parsed.command === "create-client") {
    if (parsed.positionals.length !== 3) throw new Error(usage());
    const [clientId, legalName, authorizedEmail] = parsed.positionals as [string, string, string];
    const client = createMinimalClientRecord({
      client_id: clientId,
      legal_name: legalName,
      authorized_email: authorizedEmail,
      created_at: now().toISOString(),
      status: "onboarding"
    });
    await data.upsertClient(client);
    writeLine(
      `Created ${client.client_id} | ${client.legal_name} | ${client.installation.installation_id}`
    );
    return;
  }

  if (parsed.command === "install-pack") {
    if (parsed.positionals.length !== 1) throw new Error(usage());
    const controlPlaneUrl = parsed.controlPlaneUrl ?? env.QUOTEOPS_CONTROL_PLANE_URL?.trim();
    if (!controlPlaneUrl) {
      throw new Error("QUOTEOPS_CONTROL_PLANE_URL or --url is required for install-pack");
    }
    const client = await data.getClient(parsed.positionals[0]!);
    if (!client) throw new Error(`Client not found: ${parsed.positionals[0]}`);
    ensureClientCanReceiveInstallPack(client);
    const release = await data.latestRelease();
    if (!release) throw new Error("No verified appliance release is available");
    const publishedRelease = parsePublishedApplianceRelease({
      manifest: release.manifest,
      bundle_sha256: release.bundle_sha256
    });

    const issuedAt = now();
    const registrationToken = tokenGenerator();
    const expiresAt = new Date(
      issuedAt.getTime() + parsed.ttlMinutes * 60 * 1000
    ).toISOString();
    const pack = createInstallPack({
      client,
      control_plane_url: controlPlaneUrl,
      registration_token: registrationToken,
      expires_at: expiresAt,
      release: publishedRelease
    });
    const {
      registration_token: _registrationToken,
      ...installPackSnapshot
    } = pack;
    const token: RegistrationTokenRecord = {
      token: crypto.createHash("sha256").update(registrationToken).digest("hex"),
      client_id: client.client_id,
      installation_id: client.installation.installation_id,
      expires_at: expiresAt,
      used_at: null,
      release_version: publishedRelease.manifest.version,
      bundle_sha256: publishedRelease.bundle_sha256,
      install_pack_snapshot: installPackSnapshot,
      pack_sha256: crypto
        .createHash("sha256")
        .update(canonicalizeInstallPack(installPackSnapshot))
        .digest("hex")
    };
    await data.saveRegistrationToken(token);

    writeLine(`Registration token: ${pack.registration_token}`);
    writeLine(`Expires at: ${pack.expires_at}`);
    writeLine(pack.install_command);
    return;
  }

  if (parsed.command === "list") {
    if (parsed.positionals.length !== 0) throw new Error(usage());
    const clients = await data.listClients();
    if (clients.length === 0) {
      writeLine("No clients.");
      return;
    }
    for (const client of clients) {
      writeLine([
        client.client_id,
        client.status,
        client.installation.installation_id,
        client.installation.license_status,
        client.authorized_users[0]?.email ?? "-",
        client.legal_name
      ].join(" | "));
    }
    return;
  }

  throw new Error(`Unknown command: ${parsed.command}\n\n${usage()}`);
}

function createDatabaseData(env: NodeJS.ProcessEnv): ControlPlaneData {
  if (!env.QUOTEOPS_SUPABASE_DB_URL?.trim() && !env.DATABASE_URL?.trim()) {
    throw new Error("DATABASE_URL or QUOTEOPS_SUPABASE_DB_URL is required");
  }
  return createDefaultControlPlaneData(env);
}

function ensureClientCanReceiveInstallPack(client: MinimalClientRecord): void {
  if (
    client.status === "suspended" ||
    client.status === "blocked" ||
    client.installation.license_status === "suspended" ||
    client.installation.onboarding_status === "blocked"
  ) {
    throw new Error(`Client is not eligible for an install pack: ${client.client_id}`);
  }
}

function parseArguments(argv: string[]): ParsedArguments {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return { command: "help", positionals: [], controlPlaneUrl: null, ttlMinutes: 60 };
  }

  const command = argv[0]!;
  const positionals: string[] = [];
  let controlPlaneUrl: string | null = null;
  let ttlMinutes = 60;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--url") {
      controlPlaneUrl = requiredFlagValue(argv, ++index, "--url");
      continue;
    }
    if (argument === "--ttl-minutes") {
      const raw = requiredFlagValue(argv, ++index, "--ttl-minutes");
      ttlMinutes = Number.parseInt(raw, 10);
      if (!/^\d+$/.test(raw) || ttlMinutes <= 0) {
        throw new Error("--ttl-minutes must be a positive integer");
      }
      continue;
    }
    if (argument.startsWith("--")) throw new Error(`Unknown option: ${argument}`);
    positionals.push(argument);
  }
  return { command, positionals, controlPlaneUrl, ttlMinutes };
}

function requiredFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function usage(): string {
  return [
    "Usage:",
    "  npm run admin -- create-client CLIENT_ID \"Legal name\" owner@example.com",
    "  npm run admin -- install-pack CLIENT_ID [--ttl-minutes 60] [--url https://control-plane.example]",
    "  npm run admin -- list"
  ].join("\n");
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  runAdminCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
