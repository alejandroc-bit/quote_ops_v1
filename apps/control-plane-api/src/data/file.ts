import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  normalizeClientId,
  normalizeEmail,
  type MinimalClientRecord
} from "@quoteops/control-plane";
import {
  validateRegistrationTokenRecord,
  validateReleaseRecord,
  type ControlPlaneData,
  type PortalProfile,
  type PortalProfileClaimInput,
  type RegistrationTokenRecord,
  type ReleaseRecord,
  type SentinelReportInput,
  type UsageEventInput
} from "./index.js";

type FileState = {
  clients: MinimalClientRecord[];
  registration_tokens: RegistrationTokenRecord[];
  releases: ReleaseRecord[];
};

type PersistedFileState = {
  clients: MinimalClientRecord[];
  registration_tokens: RegistrationTokenRecord[];
  releases: Array<
    Omit<ReleaseRecord, "manifest_bytes" | "archive_bytes"> & {
      manifest_bytes: string;
      archive_bytes: string;
    }
  >;
};

const emptyState: FileState = { clients: [], registration_tokens: [], releases: [] };

/** Reads and continues writing the pre-unification JSON shape. */
export function createFileControlPlaneData(path: string): ControlPlaneData {
  const profiles = new Map<string, PortalProfile>();

  async function readState(): Promise<FileState> {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<PersistedFileState>;
      return {
        clients: Array.isArray(parsed.clients) ? parsed.clients : [],
        registration_tokens: Array.isArray(parsed.registration_tokens)
          ? parsed.registration_tokens
          : [],
        releases: Array.isArray(parsed.releases)
          ? parsed.releases.map((release) =>
              validateReleaseRecord({
                ...release,
                manifest_bytes: Buffer.from(release.manifest_bytes, "base64"),
                archive_bytes: Buffer.from(release.archive_bytes, "base64")
              })
            )
          : []
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...emptyState };
      throw error;
    }
  }

  async function writeState(state: FileState): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.tmp.${process.pid}`;
    const persisted: PersistedFileState = {
      clients: state.clients,
      registration_tokens: state.registration_tokens.map((token) =>
        hasCompleteReleasePin(token)
          ? validateRegistrationTokenRecord(token)
          : token
      ),
      releases: state.releases.map((release) => {
        const valid = validateReleaseRecord(release);
        return {
          ...valid,
          manifest_bytes: Buffer.from(valid.manifest_bytes).toString("base64"),
          archive_bytes: Buffer.from(valid.archive_bytes).toString("base64")
        };
      })
    };
    await writeFile(tempPath, JSON.stringify(persisted, null, 2), { mode: 0o600 });
    await rename(tempPath, path);
  }

  return {
    async listClients() {
      return (await readState()).clients.sort((a, b) => a.legal_name.localeCompare(b.legal_name));
    },
    async getClient(clientId) {
      const normalized = normalizeClientId(clientId);
      return (await readState()).clients.find((client) => client.client_id === normalized) ?? null;
    },
    async getClientByInstallation(installationId) {
      return (
        (await readState()).clients.find(
          (client) => client.installation.installation_id === installationId
        ) ?? null
      );
    },
    async findClientByAuthorizedEmail(email) {
      const normalized = normalizeEmail(email);
      return (
        (await readState()).clients.find((client) =>
          client.authorized_users.some((user) => user.email === normalized)
        ) ?? null
      );
    },
    async upsertClient(client) {
      const state = await readState();
      await writeState({
        ...state,
        clients: [client, ...state.clients.filter((current) => current.client_id !== client.client_id)]
      });
      return client;
    },
    async saveRegistrationToken(token) {
      const state = await readState();
      const client = state.clients.find((candidate) => candidate.client_id === token.client_id);
      if (!client || client.installation.installation_id !== token.installation_id) {
        throw new Error("installation_not_provisioned");
      }
      const valid = validateRegistrationTokenRecord(token);
      await writeState({
        ...state,
        registration_tokens: [
          valid,
          ...state.registration_tokens.filter((current) => current.token !== valid.token)
        ]
      });
      return valid;
    },
    async getRegistrationToken(token) {
      const current =
        (await readState()).registration_tokens.find(
          (candidate) => candidate.token === token
        ) ?? null;
      return current ? validateRegistrationTokenRecord(current) : null;
    },
    async markRegistrationTokenUsed(token, usedAt) {
      const state = await readState();
      const current = state.registration_tokens.find((candidate) => candidate.token === token);
      if (!current) throw new Error("registration_token_not_found");
      validateRegistrationTokenRecord(current);
      await writeState({
        ...state,
        registration_tokens: [
          { ...current, used_at: usedAt },
          ...state.registration_tokens.filter((candidate) => candidate.token !== token)
        ]
      });
    },
    async resolveTenantByToken(token) {
      const state = await readState();
      const record = state.registration_tokens.find((candidate) => candidate.token === token);
      if (!record || (!record.used_at && Date.parse(record.expires_at) <= Date.now())) return null;
      validateRegistrationTokenRecord(record);
      const client = state.clients.find((candidate) => candidate.client_id === record.client_id);
      if (!client || client.installation.installation_id !== record.installation_id) return null;
      return { tenant_id: record.client_id, installation_id: record.installation_id };
    },
    async claimPortalProfile(input: PortalProfileClaimInput) {
      const normalizedEmail = normalizeEmail(input.email);
      const existing = profiles.get(input.user_id);
      const client = await this.findClientByAuthorizedEmail(normalizedEmail);
      const tenantId = client?.client_id ?? null;
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
    async insertSentinelReport(_report: SentinelReportInput) {
      // Dev file mode intentionally persists only the legacy client/token shape.
    },
    async recordUsage(_event: UsageEventInput) {
      // Dev file mode intentionally persists only the legacy client/token shape.
    },
    async latestRelease() {
      const state = await readState();
      const releases = state.releases
        .filter((release) => /^v\d+\.\d+\.\d+$/.test(release.version))
        .sort((a, b) =>
          a.version.localeCompare(b.version, undefined, { numeric: true })
        );
      return releases.at(-1) ?? null;
    },
    async getRelease(version) {
      return (await readState()).releases.find((release) => release.version === version) ?? null;
    },
    async upsertRelease(release) {
      const state = await readState();
      const valid = validateReleaseRecord(release);
      const current = state.releases.find((candidate) => candidate.version === valid.version);
      if (current && current.bundle_sha256 !== valid.bundle_sha256) {
        throw new Error("release_version_immutable");
      }
      const existingByHash = state.releases.find(
        (candidate) => candidate.bundle_sha256 === valid.bundle_sha256
      );
      if (existingByHash && existingByHash.version !== valid.version) {
        throw new Error("release_bundle_immutable");
      }
      if (!current) {
        await writeState({ ...state, releases: [...state.releases, valid] });
      }
      return current ?? valid;
    },
    async getInstallationSettings(_installationId) {
      return {};
    },
    async touchInstallation(_installationId, _version, _at, client) {
      if (client) await this.upsertClient(client);
    }
  };
}

function hasCompleteReleasePin(
  token: RegistrationTokenRecord
): token is RegistrationTokenRecord {
  return Boolean(
    token &&
      typeof token.release_version === "string" &&
      typeof token.bundle_sha256 === "string" &&
      token.install_pack_snapshot &&
      typeof token.pack_sha256 === "string"
  );
}
