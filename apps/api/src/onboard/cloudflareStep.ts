import { isIP } from "node:net";
import { resolve4, resolve6 } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  OnboardingError,
  type OnboardingContext,
  type OnboardingPhase,
  type SecretFileRef
} from "./onboardingFlow.js";
import {
  atomicWriteJson,
  readEnvFileValues,
  readSingleLineSecret,
  updateAllowedEnv
} from "./onboardConfig.js";
import { matchesCloudflarePublicReceipt } from "./cloudflarePublicReceipt.js";

export type CloudflareTunnelConfig = {
  provider: "cloudflare";
  public_hostname: string;
  origin_url: "http://caddy:80";
};

export type ConfigureCloudflareTunnelInput = {
  public_hostname: string;
  tunnel_token: string | SecretFileRef;
  access_client_id: string | SecretFileRef;
  access_client_secret: string | SecretFileRef;
};

export async function validatePublicHostname(
  input: string,
  resolver: (hostname: string) => Promise<string[]> = resolvePublicAddresses
): Promise<string> {
  if (
    !input ||
    input.length > 253 ||
    input !== input.toLowerCase() ||
    !/^[\x00-\x7f]+$/.test(input) ||
    input.includes("://") ||
    input.includes("/") ||
    input.includes(":") ||
    input.endsWith(".") ||
    isIP(input) !== 0
  ) {
    throw new OnboardingError("cloudflare_hostname_invalid");
  }
  const labels = input.split(".");
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        label.length < 1 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    ) ||
    input === "localhost" ||
    [".local", ".internal", ".home", ".arpa"].some((suffix) =>
      input.endsWith(suffix)
    )
  ) {
    throw new OnboardingError("cloudflare_hostname_invalid");
  }

  let addresses: string[];
  try {
    addresses = await resolver(input);
  } catch {
    throw new OnboardingError("cloudflare_hostname_unsafe");
  }
  if (
    addresses.length === 0 ||
    addresses.some(
      (address) => isIP(address) === 0 || !isPublicInternetAddress(address)
    )
  ) {
    throw new OnboardingError("cloudflare_hostname_unsafe");
  }
  return input;
}

export async function configureCloudflareTunnel(
  input: ConfigureCloudflareTunnelInput,
  context: OnboardingContext
): Promise<CloudflareTunnelConfig> {
  const publicHostname = await validatePublicHostname(
    input.public_hostname,
    context.resolveHostname ?? resolvePublicAddresses
  );
  const [tunnelToken, accessClientId, accessClientSecret] = await Promise.all([
    readSingleLineSecret(input.tunnel_token, context),
    readSingleLineSecret(input.access_client_id, context),
    readSingleLineSecret(input.access_client_secret, context)
  ]);
  if (
    !/^[A-Za-z0-9._~-]+$/.test(accessClientId) ||
    !/^[A-Za-z0-9._~-]+$/.test(accessClientSecret)
  ) {
    throw new OnboardingError("cloudflare_access_credential_invalid");
  }
  const accessFile = cloudflareAccessValidationFile(context);

  await updateAllowedEnv(
    context.paths.cloudflareSecretsFile,
    { TUNNEL_TOKEN: tunnelToken },
    ["TUNNEL_TOKEN"],
    () => context.afterAtomicRename?.("cloudflare_tunnel_env")
  );
  // Reconcile legacy installs: the tunnel token has exactly one permitted home.
  await updateAllowedEnv(
    context.paths.clientSecretsFile,
    { TUNNEL_TOKEN: null },
    ["TUNNEL_TOKEN"],
    () => context.afterAtomicRename?.("cloudflare_client_env_cleanup")
  );
  await updateAllowedEnv(
    accessFile,
    {
      CF_ACCESS_CLIENT_ID: accessClientId,
      CF_ACCESS_CLIENT_SECRET: accessClientSecret
    },
    ["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"],
    () => context.afterAtomicRename?.("cloudflare_access_env")
  );

  const config: CloudflareTunnelConfig = {
    provider: "cloudflare",
    public_hostname: publicHostname,
    origin_url: "http://caddy:80"
  };
  await atomicWriteJson(join(context.paths.settingsDir, "cloudflare.json"), config, {
    mode: 0o600,
    afterRename: () => context.afterAtomicRename?.("cloudflare_config")
  });
  return config;
}

export const cloudflarePhase: OnboardingPhase = {
  id: "cloudflare",
  async isComplete(context) {
    const config = await readCloudflareConfig(context);
    if (!config) return false;
    const tunnel = await readEnvFileValues(context.paths.cloudflareSecretsFile);
    if (!tunnel.get("TUNNEL_TOKEN")) return false;
    const access = await readEnvFileValues(cloudflareAccessValidationFile(context));
    if (
      access.get("CF_ACCESS_CLIENT_ID") &&
      access.get("CF_ACCESS_CLIENT_SECRET")
    ) {
      return true;
    }
    return hasMatchingPublicReceipt(context, config.public_hostname);
  },
  async run(context) {
    if (context.answers?.cloudflare) {
      await configureCloudflareTunnel(context.answers.cloudflare, context);
      return;
    }
    if (!context.guided) {
      throw new OnboardingError("onboarding_pending", {
        phase: "cloudflare"
      });
    }
    const publicHostname = await context.io.ask(
      "Hostname público (sin esquema ni ruta)"
    );
    const tunnelToken = await context.io.askMasked("Cloudflare Tunnel token");
    const accessClientId = await context.io.askMasked(
      "Cloudflare Access client ID"
    );
    const accessClientSecret = await context.io.askMasked(
      "Cloudflare Access client secret"
    );
    await configureCloudflareTunnel(
      {
        public_hostname: publicHostname,
        tunnel_token: tunnelToken,
        access_client_id: accessClientId,
        access_client_secret: accessClientSecret
      },
      context
    );
  }
};

export async function readCloudflareConfig(
  context: OnboardingContext
): Promise<CloudflareTunnelConfig | null> {
  try {
    const parsed = JSON.parse(
      await readFile(join(context.paths.settingsDir, "cloudflare.json"), "utf8")
    ) as Partial<CloudflareTunnelConfig>;
    if (
      parsed.provider !== "cloudflare" ||
      parsed.origin_url !== "http://caddy:80" ||
      typeof parsed.public_hostname !== "string"
    ) {
      return null;
    }
    await validatePublicHostname(
      parsed.public_hostname,
      context.resolveHostname ?? resolvePublicAddresses
    );
    return parsed as CloudflareTunnelConfig;
  } catch (error) {
    if (
      error instanceof OnboardingError &&
      (error.code === "cloudflare_hostname_invalid" ||
        error.code === "cloudflare_hostname_unsafe")
    ) {
      return null;
    }
    return null;
  }
}

async function resolvePublicAddresses(hostname: string): Promise<string[]> {
  const [v4, v6] = await Promise.all([
    resolve4(hostname).catch(() => []),
    resolve6(hostname).catch(() => [])
  ]);
  return [...v4, ...v6];
}

function cloudflareAccessValidationFile(context: OnboardingContext): string {
  return join(
    dirname(context.paths.settingsDir),
    "secrets/cloudflare-access-validation.env"
  );
}

async function hasMatchingPublicReceipt(
  context: OnboardingContext,
  hostname: string
): Promise<boolean> {
  try {
    const receipt = JSON.parse(
      await readFile(
        join(context.paths.settingsDir, "cloudflare-public-validation.json"),
        "utf8"
      )
    ) as unknown;
    return matchesCloudflarePublicReceipt(receipt, {
      public_hostname: hostname,
      version: context.env.QUOTEOPS_VERSION ?? "",
      client_id: context.env.QUOTEOPS_CLIENT_ID ?? "",
      installation_id: context.env.QUOTEOPS_INSTALLATION_ID ?? ""
    });
  } catch {
    return false;
  }
}

export function isPublicInternetAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const octets = address.split(".").map(Number);
    const value =
      ((octets[0]! << 24) >>> 0) +
      (octets[1]! << 16) +
      (octets[2]! << 8) +
      octets[3]!;
    return !IPV4_BLOCKS.some(([network, bits]) =>
      isIpv4InCidr(value, network, bits)
    );
  }
  const bytes = parseIpv6(address);
  if (!bytes) return false;
  return !IPV6_BLOCKS.some(([prefix, bits]) =>
    isBytesInCidr(bytes, prefix, bits)
  );
}

const IPV4_BLOCKS: Array<[number, number]> = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0000200, 24],
  [0xc0586300, 24],
  [0xc0a80000, 16],
  [0xc6120000, 15],
  [0xc6336400, 24],
  [0xcb007100, 24],
  [0xe0000000, 4],
  [0xf0000000, 4]
];

const IPV6_BLOCKS: Array<[Uint8Array, number]> = [
  [ipv6Prefix("::"), 128],
  [ipv6Prefix("::1"), 128],
  [ipv6Prefix("::ffff:0:0"), 96],
  [ipv6Prefix("64:ff9b:1::"), 48],
  [ipv6Prefix("100::"), 64],
  [ipv6Prefix("2001:2::"), 48],
  [ipv6Prefix("2001:db8::"), 32],
  [ipv6Prefix("fc00::"), 7],
  [ipv6Prefix("fe80::"), 10],
  [ipv6Prefix("ff00::"), 8]
];

function isIpv4InCidr(
  value: number,
  network: number,
  bits: number
): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) >>> 0 === (network & mask) >>> 0;
}

function ipv6Prefix(value: string): Uint8Array {
  return parseIpv6(value) ?? new Uint8Array(16);
}

function parseIpv6(input: string): Uint8Array | null {
  if (isIP(input) !== 6) return null;
  const lower = input.toLowerCase();
  const [leftRaw, rightRaw] = lower.split("::");
  if (lower.split("::").length > 2) return null;
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  const expandEmbeddedV4 = (parts: string[]): string[] => {
    const last = parts.at(-1);
    if (!last || !last.includes(".")) return parts;
    const octets = last.split(".").map(Number);
    return [
      ...parts.slice(0, -1),
      ((octets[0]! << 8) | octets[1]!).toString(16),
      ((octets[2]! << 8) | octets[3]!).toString(16)
    ];
  };
  const expandedLeft = expandEmbeddedV4(left);
  const expandedRight = expandEmbeddedV4(right);
  const missing =
    lower.includes("::")
      ? 8 - expandedLeft.length - expandedRight.length
      : 0;
  const groups = [
    ...expandedLeft,
    ...Array.from({ length: missing }, () => "0"),
    ...expandedRight
  ];
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    const value = Number.parseInt(group || "0", 16);
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 0xff;
  });
  return bytes;
}

function isBytesInCidr(
  value: Uint8Array,
  network: Uint8Array,
  bits: number
): boolean {
  const fullBytes = Math.floor(bits / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (value[index] !== network[index]) return false;
  }
  const remaining = bits % 8;
  if (!remaining) return true;
  const mask = 0xff << (8 - remaining);
  return (value[fullBytes]! & mask) === (network[fullBytes]! & mask);
}
