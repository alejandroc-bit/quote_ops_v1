import { createHash } from "node:crypto";
import {
  normalizeClientId,
  normalizeEmail,
  parseInstallPack,
  type InstallPack,
  type MinimalClientRecord
} from "@quoteops/control-plane";
import {
  parseApplianceRelease,
  type ApplianceRelease
} from "@quoteops/shared";
import { createFileControlPlaneData } from "./file.js";
import { createPostgresControlPlaneData } from "./postgres.js";

export type MaybePromise<T> = T | Promise<T>;

export type RegistrationTokenRecord = {
  token: string;
  client_id: string;
  installation_id: string;
  expires_at: string;
  used_at: string | null;
  release_version: string;
  bundle_sha256: string;
  install_pack_snapshot: InstallPack;
  pack_sha256: string;
};

export type TenantToken = { tenant_id: string; installation_id: string };

export type PortalProfile = {
  user_id: string;
  tenant_id: string | null;
  role: "owner" | "member" | "vendor_admin";
  email: string;
};

export type PortalProfileClaimInput = {
  user_id: string;
  email: string;
  vendor_admin: boolean;
};

export type SentinelReportInput = {
  tenant_id: string;
  installation_id: string;
  week_start: string;
  body_md: string;
  stats: Record<string, unknown>;
};

export type UsageEventInput = {
  tenant_id: string;
  day: string;
  channel: string;
  quotes: number;
  routes: number;
};

export type ReleaseRecord = {
  version: string;
  notes: string | null;
  bundle_sha256: string;
  manifest: ApplianceRelease;
  manifest_bytes: Uint8Array;
  archive_bytes: Uint8Array;
  published_at: string;
};

/**
 * The single control-plane persistence boundary. Client records are projected
 * from tenants joined to their installation; no full client JSON blob is
 * stored in Postgres.
 */
export type ControlPlaneData = {
  listClients(): MaybePromise<MinimalClientRecord[]>;
  getClient(clientId: string): MaybePromise<MinimalClientRecord | null>;
  getClientByInstallation(installationId: string): MaybePromise<MinimalClientRecord | null>;
  findClientByAuthorizedEmail(email: string): MaybePromise<MinimalClientRecord | null>;
  upsertClient(client: MinimalClientRecord): MaybePromise<MinimalClientRecord>;
  saveRegistrationToken(token: RegistrationTokenRecord): MaybePromise<RegistrationTokenRecord>;
  getRegistrationToken(token: string): MaybePromise<RegistrationTokenRecord | null>;
  markRegistrationTokenUsed(token: string, usedAt: string): MaybePromise<void>;
  resolveTenantByToken(token: string): MaybePromise<TenantToken | null>;
  claimPortalProfile(input: PortalProfileClaimInput): MaybePromise<PortalProfile | null>;
  insertSentinelReport(report: SentinelReportInput): MaybePromise<void>;
  recordUsage(event: UsageEventInput): MaybePromise<void>;
  latestRelease(): MaybePromise<ReleaseRecord | null>;
  getRelease(version: string): MaybePromise<ReleaseRecord | null>;
  upsertRelease(release: ReleaseRecord): MaybePromise<ReleaseRecord>;
  getInstallationSettings(installationId: string): MaybePromise<Record<string, unknown>>;
  touchInstallation(
    installationId: string,
    version: string | null,
    at: string,
    client?: MinimalClientRecord
  ): MaybePromise<void>;
};

export type InMemoryControlPlaneDataSeed = {
  clients?: MinimalClientRecord[];
  tokens?: Array<RegistrationTokenRecord & { tenant_id?: string }>;
  installations?: Array<{
    tenant_id: string;
    installation_id: string;
    version?: string | null;
    settings?: Record<string, unknown>;
    last_heartbeat_at?: string | null;
  }>;
  releases?: ReleaseRecord[];
};

type MemoryInstallation = {
  tenant_id: string;
  installation_id: string;
  version: string | null;
  settings: Record<string, unknown>;
  last_heartbeat_at: string | null;
};

type StoredToken = RegistrationTokenRecord & { tenant_id: string };

const FAR_FUTURE = "9999-01-01T00:00:00.000Z";

export function createInMemoryControlPlaneData(seed: InMemoryControlPlaneDataSeed = {}) {
  const clients = new Map<string, MinimalClientRecord>();
  const clientTenants = new Map<string, string>();
  const primaryEmailTenants = new Map<string, string>();
  const installations = new Map<string, MemoryInstallation>(
    (seed.installations ?? []).map((installation) => [
      installation.installation_id,
      {
        version: null,
        settings: {},
        last_heartbeat_at: null,
        ...installation
      }
    ])
  );
  const tokens = new Map<string, StoredToken>();
  const releases = new Map<string, ReleaseRecord>();
  for (const release of seed.releases ?? []) {
    const valid = validateReleaseRecord(release);
    const existingByHash = [...releases.values()].find(
      (candidate) => candidate.bundle_sha256 === valid.bundle_sha256
    );
    if (existingByHash && existingByHash.version !== valid.version) {
      throw new Error("release_bundle_immutable");
    }
    releases.set(valid.version, valid);
  }
  const sentinelReports: Array<SentinelReportInput & { status: "new" }> = [];
  const usageEvents = new Map<string, UsageEventInput>();
  const profiles = new Map<string, PortalProfile>();

  function tenantIdForClient(clientId: string): string {
    return clientTenants.get(clientId) ?? `tenant:${clientId}`;
  }

  function writeClient(client: MinimalClientRecord): MinimalClientRecord {
    const clientId = normalizeClientId(client.client_id);
    const tenantId = tenantIdForClient(clientId);
    const primaryUser = client.authorized_users[0];
    if (!primaryUser) throw new Error("authorized_user_required");
    const primaryEmail = normalizeEmail(primaryUser.email);
    const previous = clients.get(clientId)?.authorized_users[0]?.email;
    const emailTenant = primaryEmailTenants.get(primaryEmail);
    if (emailTenant && emailTenant !== tenantId) throw new Error("authorized_email_already_used");

    if (previous && previous !== primaryEmail) primaryEmailTenants.delete(previous);
    clientTenants.set(clientId, tenantId);
    primaryEmailTenants.set(primaryEmail, tenantId);

    const normalized: MinimalClientRecord = {
      ...client,
      client_id: clientId,
      authorized_users: client.authorized_users.map((user, index) => ({
        ...user,
        email: index === 0 ? primaryEmail : normalizeEmail(user.email)
      })),
      installation: {
        ...client.installation,
        client_id: clientId
      }
    };
    const existingInstallation = installations.get(normalized.installation.installation_id);
    if (existingInstallation && existingInstallation.tenant_id !== tenantId) {
      throw new Error("installation_tenant_mismatch");
    }
    if (existingInstallation) {
      existingInstallation.last_heartbeat_at = normalized.installation.last_heartbeat_at;
    } else {
      installations.set(normalized.installation.installation_id, {
        tenant_id: tenantId,
        installation_id: normalized.installation.installation_id,
        version: null,
        settings: {},
        last_heartbeat_at: normalized.installation.last_heartbeat_at
      });
    }
    clients.set(clientId, normalized);
    return normalized;
  }

  for (const client of seed.clients ?? []) writeClient(client);
  for (const token of seed.tokens ?? []) {
    tokens.set(token.token, {
      ...token,
      expires_at: token.expires_at ?? FAR_FUTURE,
      used_at: token.used_at ?? null,
      tenant_id: token.tenant_id ?? tenantIdForClient(token.client_id)
    });
  }

  const data = {
    clients,
    tokens,
    sentinelReports,
    usageEvents,
    installations,
    profiles,
    listClients(): MinimalClientRecord[] {
      return [...clients.values()].sort((a, b) => a.legal_name.localeCompare(b.legal_name));
    },
    getClient(clientId: string): MinimalClientRecord | null {
      return clients.get(normalizeClientId(clientId)) ?? null;
    },
    getClientByInstallation(installationId: string): MinimalClientRecord | null {
      return (
        [...clients.values()].find(
          (client) => client.installation.installation_id === installationId
        ) ?? null
      );
    },
    findClientByAuthorizedEmail(email: string): MinimalClientRecord | null {
      const normalizedEmail = normalizeEmail(email);
      return (
        [...clients.values()].find((client) =>
          client.authorized_users.some((user) => user.email === normalizedEmail)
        ) ?? null
      );
    },
    upsertClient(client: MinimalClientRecord): MinimalClientRecord {
      return writeClient(client);
    },
    saveRegistrationToken(token: RegistrationTokenRecord): RegistrationTokenRecord {
      const client = clients.get(normalizeClientId(token.client_id));
      const installation = installations.get(token.installation_id);
      if (
        !client ||
        !installation ||
        client.installation.installation_id !== token.installation_id ||
        installation.tenant_id !== tenantIdForClient(client.client_id)
      ) {
        throw new Error("installation_not_provisioned");
      }
      const valid = validateRegistrationTokenRecord(token);
      tokens.set(valid.token, { ...cloneToken(valid), tenant_id: installation.tenant_id });
      return cloneToken(valid);
    },
    getRegistrationToken(token: string): RegistrationTokenRecord | null {
      const record = tokens.get(token);
      if (!record) return null;
      const { tenant_id: _tenantId, ...publicRecord } = record;
      return validateRegistrationTokenRecord(publicRecord);
    },
    markRegistrationTokenUsed(token: string, usedAt: string): void {
      const record = tokens.get(token);
      if (!record) throw new Error("registration_token_not_found");
      tokens.set(token, { ...record, used_at: usedAt });
    },
    resolveTenantByToken(token: string): TenantToken | null {
      const record = tokens.get(token);
      if (!record) return null;
      validateRegistrationTokenRecord(record);
      // ponytail: after activation the used token is the installation's
      // long-lived credential; only unused tokens expire.
      if (!record.used_at && Date.parse(record.expires_at) <= Date.now()) return null;
      const installation = installations.get(record.installation_id);
      if (!installation || installation.tenant_id !== record.tenant_id) return null;
      return { tenant_id: record.tenant_id, installation_id: record.installation_id };
    },
    claimPortalProfile(input: PortalProfileClaimInput): PortalProfile | null {
      const existing = profiles.get(input.user_id);
      const normalizedEmail = normalizeEmail(input.email);
      const tenantId = primaryEmailTenants.get(normalizedEmail) ?? null;
      if (existing) {
        const stillAuthorized =
          existing.email === normalizedEmail &&
          (existing.role === "vendor_admin"
            ? input.vendor_admin
            : !input.vendor_admin && tenantId === existing.tenant_id);
        if (stillAuthorized) return existing;
        profiles.delete(input.user_id);
        return null;
      }
      const profile: PortalProfile | null = input.vendor_admin
        ? { user_id: input.user_id, tenant_id: null, role: "vendor_admin", email: normalizedEmail }
        : tenantId
          ? { user_id: input.user_id, tenant_id: tenantId, role: "owner", email: normalizedEmail }
          : null;
      if (profile) profiles.set(input.user_id, profile);
      return profile;
    },
    insertSentinelReport(report: SentinelReportInput): void {
      sentinelReports.push({ ...report, status: "new" });
    },
    recordUsage(event: UsageEventInput): void {
      usageEvents.set(`${event.tenant_id}|${event.day}|${event.channel}`, event);
    },
    latestRelease(): ReleaseRecord | null {
      const version = maxSemver([...releases.keys()]);
      const release = version ? releases.get(version) : null;
      return release ? validateReleaseRecord(release) : null;
    },
    getRelease(version: string): ReleaseRecord | null {
      const release = releases.get(version);
      return release ? validateReleaseRecord(release) : null;
    },
    upsertRelease(release: ReleaseRecord): ReleaseRecord {
      const valid = validateReleaseRecord(release);
      const current = releases.get(valid.version);
      if (current && current.bundle_sha256 !== valid.bundle_sha256) {
        throw new Error("release_version_immutable");
      }
      const existingByHash = [...releases.values()].find(
        (candidate) => candidate.bundle_sha256 === valid.bundle_sha256
      );
      if (existingByHash && existingByHash.version !== valid.version) {
        throw new Error("release_bundle_immutable");
      }
      if (!current) releases.set(valid.version, valid);
      return validateReleaseRecord(current ?? valid);
    },
    getInstallationSettings(installationId: string): Record<string, unknown> {
      return installations.get(installationId)?.settings ?? {};
    },
    touchInstallation(
      installationId: string,
      version: string | null,
      at: string,
      client?: MinimalClientRecord
    ): void {
      if (client) writeClient(client);
      const installation = installations.get(installationId);
      if (!installation) return;
      installation.last_heartbeat_at = at;
      if (version) installation.version = version;
    }
  } satisfies ControlPlaneData & Record<string, unknown>;

  return data;
}

export const MAX_RELEASE_ARCHIVE_BYTES = 2 * 1024 * 1024;

export function canonicalizeInstallPack(value: unknown): string {
  return canonicalizeJson(parseInstallPack(value));
}

export function canonicalizeJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical_json_non_finite_number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("canonical_json_non_plain_object");
    }
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("canonical_json_unsupported_value");
}

export function validateRegistrationTokenRecord(
  record: RegistrationTokenRecord
): RegistrationTokenRecord {
  if (
    !record ||
    typeof record.release_version !== "string" ||
    typeof record.bundle_sha256 !== "string" ||
    !record.install_pack_snapshot ||
    typeof record.pack_sha256 !== "string"
  ) {
    throw new Error("registration_token_reissue_required");
  }
  const snapshot = parseInstallPack(record.install_pack_snapshot);
  const canonical = canonicalizeInstallPack(snapshot);
  const packSha256 = sha256(canonical);
  if (!/^[a-f0-9]{64}$/.test(record.pack_sha256) || packSha256 !== record.pack_sha256) {
    throw new Error("install_pack_hash_mismatch");
  }
  if (
    snapshot.client_id !== record.client_id ||
    snapshot.installation_id !== record.installation_id ||
    snapshot.expires_at !== record.expires_at ||
    snapshot.release.version !== record.release_version ||
    snapshot.release.bundle_sha256 !== record.bundle_sha256
  ) {
    throw new Error("install_pack_token_mismatch");
  }
  if (
    !/^v\d+\.\d+\.\d+$/.test(record.release_version) ||
    !/^[a-f0-9]{64}$/.test(record.bundle_sha256)
  ) {
    throw new Error("registration_token_release_pin_invalid");
  }
  if (record.token && canonical.includes(record.token)) {
    throw new Error("install_pack_contains_registration_token");
  }
  return {
    ...record,
    install_pack_snapshot: parseInstallPack(
      JSON.parse(JSON.stringify(snapshot)) as unknown
    )
  };
}

export function validateReleaseRecord(record: ReleaseRecord): ReleaseRecord {
  if (
    !record ||
    !(record.manifest_bytes instanceof Uint8Array) ||
    !(record.archive_bytes instanceof Uint8Array)
  ) {
    throw new Error("release_bytes_required");
  }
  if (record.archive_bytes.byteLength > MAX_RELEASE_ARCHIVE_BYTES) {
    throw new Error("release_archive_too_large");
  }
  if (
    !/^[a-f0-9]{64}$/.test(record.bundle_sha256) ||
    sha256(record.archive_bytes) !== record.bundle_sha256
  ) {
    throw new Error("release_bundle_hash_mismatch");
  }
  let parsedManifestBytes: unknown;
  try {
    parsedManifestBytes = JSON.parse(
      Buffer.from(record.manifest_bytes).toString("utf8")
    ) as unknown;
  } catch {
    throw new Error("release_manifest_bytes_invalid");
  }
  const manifestFromBytes = parseApplianceRelease(parsedManifestBytes);
  const manifest = parseApplianceRelease(record.manifest);
  if (
    canonicalizeJson(manifestFromBytes) !== canonicalizeJson(manifest) ||
    manifest.version !== record.version
  ) {
    throw new Error("release_manifest_mismatch");
  }
  if (!Number.isFinite(Date.parse(record.published_at))) {
    throw new Error("release_published_at_invalid");
  }
  return {
    ...record,
    manifest,
    manifest_bytes: Uint8Array.from(record.manifest_bytes),
    archive_bytes: Uint8Array.from(record.archive_bytes)
  };
}

function cloneToken(record: RegistrationTokenRecord): RegistrationTokenRecord {
  return validateRegistrationTokenRecord(record);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function compareSemver(a: string, b: string): number {
  const parse = (version: string) =>
    version.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [partsA, partsB] = [parse(a), parse(b)];
  for (let index = 0; index < Math.max(partsA.length, partsB.length); index += 1) {
    const difference = (partsA[index] ?? 0) - (partsB[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function maxSemver(versions: string[]): string | null {
  return versions
    .filter((version) => /^v\d+\.\d+\.\d+$/.test(version))
    .reduce<string | null>(
      (maximum, version) =>
        maximum === null || compareSemver(version, maximum) > 0 ? version : maximum,
      null
    );
}

export function createDefaultControlPlaneData(
  env: NodeJS.ProcessEnv = process.env
): ControlPlaneData {
  const connectionString =
    env.QUOTEOPS_SUPABASE_DB_URL?.trim() || env.DATABASE_URL?.trim() || null;
  if (connectionString) return createPostgresControlPlaneData({ connectionString });

  const filePath = env.QUOTEOPS_CONTROL_PLANE_STORE_PATH?.trim();
  if (filePath) return createFileControlPlaneData(filePath);

  return createInMemoryControlPlaneData();
}

export { createFileControlPlaneData } from "./file.js";
export { createPostgresControlPlaneData } from "./postgres.js";
