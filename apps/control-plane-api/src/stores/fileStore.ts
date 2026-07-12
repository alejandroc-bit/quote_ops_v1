import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeClientId, normalizeEmail, type MinimalClientRecord } from "@quoteops/control-plane";
import type { ControlPlaneStore, RegistrationTokenRecord } from "../index.js";

type FileStoreState = {
  clients: MinimalClientRecord[];
  registration_tokens: RegistrationTokenRecord[];
};

const emptyState: FileStoreState = {
  clients: [],
  registration_tokens: []
};

export function createFileControlPlaneStore(path: string): ControlPlaneStore {
  return new FileControlPlaneStore(path);
}

class FileControlPlaneStore implements ControlPlaneStore {
  constructor(private readonly path: string) {}

  async listClients(): Promise<MinimalClientRecord[]> {
    const state = await this.readState();
    return state.clients.sort((a, b) => a.legal_name.localeCompare(b.legal_name));
  }

  async getClient(clientId: string): Promise<MinimalClientRecord | null> {
    const state = await this.readState();
    const normalizedClientId = normalizeClientId(clientId);
    return state.clients.find((client) => client.client_id === normalizedClientId) ?? null;
  }

  async getClientByInstallation(installationId: string): Promise<MinimalClientRecord | null> {
    const state = await this.readState();
    return (
      state.clients.find(
        (client) => client.installation.installation_id === installationId
      ) ?? null
    );
  }

  async findClientByAuthorizedEmail(email: string): Promise<MinimalClientRecord | null> {
    const state = await this.readState();
    const normalizedEmail = normalizeEmail(email);
    return (
      state.clients.find((client) =>
        client.authorized_users.some((user) => user.email === normalizedEmail)
      ) ?? null
    );
  }

  async upsertClient(client: MinimalClientRecord): Promise<MinimalClientRecord> {
    const state = await this.readState();
    await this.writeState({
      ...state,
      clients: [
        client,
        ...state.clients.filter((current) => current.client_id !== client.client_id)
      ]
    });
    return client;
  }

  async saveRegistrationToken(
    token: RegistrationTokenRecord
  ): Promise<RegistrationTokenRecord> {
    const state = await this.readState();
    await this.writeState({
      ...state,
      registration_tokens: [
        token,
        ...state.registration_tokens.filter((current) => current.token !== token.token)
      ]
    });
    return token;
  }

  async getRegistrationToken(token: string): Promise<RegistrationTokenRecord | null> {
    const state = await this.readState();
    return state.registration_tokens.find((current) => current.token === token) ?? null;
  }

  async updateRegistrationToken(
    token: RegistrationTokenRecord
  ): Promise<RegistrationTokenRecord> {
    return this.saveRegistrationToken(token);
  }

  private async readState(): Promise<FileStoreState> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<FileStoreState>;
      return {
        clients: Array.isArray(parsed.clients) ? parsed.clients : [],
        registration_tokens: Array.isArray(parsed.registration_tokens)
          ? parsed.registration_tokens
          : []
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { ...emptyState };
      }
      throw error;
    }
  }

  private async writeState(state: FileStoreState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.tmp.${process.pid}`;
    await writeFile(tempPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(tempPath, this.path);
  }
}
