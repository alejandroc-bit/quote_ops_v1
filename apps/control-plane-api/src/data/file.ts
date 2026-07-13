import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  normalizeClientId,
  normalizeEmail,
  type MinimalClientRecord
} from "@quoteops/control-plane";
import type {
  ControlPlaneData,
  PortalProfile,
  PortalProfileClaimInput,
  RegistrationTokenRecord,
  SentinelReportInput,
  UsageEventInput
} from "./index.js";

type LegacyFileState = {
  clients: MinimalClientRecord[];
  registration_tokens: RegistrationTokenRecord[];
};

const emptyState: LegacyFileState = { clients: [], registration_tokens: [] };

/** Reads and continues writing the pre-unification JSON shape. */
export function createFileControlPlaneData(path: string): ControlPlaneData {
  const profiles = new Map<string, PortalProfile>();

  async function readState(): Promise<LegacyFileState> {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<LegacyFileState>;
      return {
        clients: Array.isArray(parsed.clients) ? parsed.clients : [],
        registration_tokens: Array.isArray(parsed.registration_tokens)
          ? parsed.registration_tokens
          : []
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...emptyState };
      throw error;
    }
  }

  async function writeState(state: LegacyFileState): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.tmp.${process.pid}`;
    await writeFile(tempPath, JSON.stringify(state, null, 2), { mode: 0o600 });
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
      await writeState({
        ...state,
        registration_tokens: [
          token,
          ...state.registration_tokens.filter((current) => current.token !== token.token)
        ]
      });
      return token;
    },
    async getRegistrationToken(token) {
      return (await readState()).registration_tokens.find((current) => current.token === token) ?? null;
    },
    async markRegistrationTokenUsed(token, usedAt) {
      const state = await readState();
      const current = state.registration_tokens.find((candidate) => candidate.token === token);
      if (!current) throw new Error("registration_token_not_found");
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
      return null;
    },
    async getInstallationSettings(_installationId) {
      return {};
    },
    async touchInstallation(_installationId, _version, _at, client) {
      if (client) await this.upsertClient(client);
    }
  };
}
