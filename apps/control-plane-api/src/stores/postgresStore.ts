import { Pool } from "pg";
import { normalizeClientId, normalizeEmail, type MinimalClientRecord } from "@quoteops/control-plane";
import type { ControlPlaneStore, RegistrationTokenRecord } from "../index.js";

export type PostgresControlPlaneStoreOptions = {
  connectionString: string;
};

export function createPostgresControlPlaneStore(
  options: PostgresControlPlaneStoreOptions
): ControlPlaneStore {
  return new PostgresControlPlaneStore(options);
}

// Managed Postgres (Supabase pooler, RDS, etc.) requires TLS, and node-postgres
// does not enable it from a bare connection string. Local/dev DBs opt out with
// sslmode=disable or a localhost host.
function sslConfigFor(connectionString: string): { rejectUnauthorized: boolean } | undefined {
  if (/sslmode=disable/i.test(connectionString)) return undefined;
  if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString)) return undefined;
  return { rejectUnauthorized: false };
}

class PostgresControlPlaneStore implements ControlPlaneStore {
  private readonly pool: Pool;
  private schemaReady: Promise<void> | null = null;

  constructor(options: PostgresControlPlaneStoreOptions) {
    this.pool = new Pool({
      connectionString: options.connectionString,
      ssl: sslConfigFor(options.connectionString)
    });
  }

  async listClients(): Promise<MinimalClientRecord[]> {
    await this.ensureSchema();
    const result = await this.pool.query<{ record: MinimalClientRecord }>(
      "select record from control_plane_clients order by legal_name asc"
    );
    return result.rows.map((row) => row.record);
  }

  async getClient(clientId: string): Promise<MinimalClientRecord | null> {
    await this.ensureSchema();
    const result = await this.pool.query<{ record: MinimalClientRecord }>(
      "select record from control_plane_clients where client_id = $1",
      [normalizeClientId(clientId)]
    );
    return result.rows[0]?.record ?? null;
  }

  async getClientByInstallation(installationId: string): Promise<MinimalClientRecord | null> {
    await this.ensureSchema();
    const result = await this.pool.query<{ record: MinimalClientRecord }>(
      "select record from control_plane_clients where installation_id = $1",
      [installationId]
    );
    return result.rows[0]?.record ?? null;
  }

  async findClientByAuthorizedEmail(email: string): Promise<MinimalClientRecord | null> {
    await this.ensureSchema();
    const result = await this.pool.query<{ record: MinimalClientRecord }>(
      "select record from control_plane_clients where authorized_user_emails @> $1::jsonb limit 1",
      [JSON.stringify([normalizeEmail(email)])]
    );
    return result.rows[0]?.record ?? null;
  }

  async upsertClient(client: MinimalClientRecord): Promise<MinimalClientRecord> {
    await this.ensureSchema();
    await this.pool.query(
      `insert into control_plane_clients (
        client_id,
        legal_name,
        installation_id,
        authorized_user_emails,
        record,
        updated_at
      )
      values ($1, $2, $3, $4::jsonb, $5::jsonb, now())
      on conflict (client_id) do update set
        legal_name = excluded.legal_name,
        installation_id = excluded.installation_id,
        authorized_user_emails = excluded.authorized_user_emails,
        record = excluded.record,
        updated_at = now()`,
      [
        client.client_id,
        client.legal_name,
        client.installation.installation_id,
        JSON.stringify(client.authorized_users.map((user) => user.email)),
        JSON.stringify(client)
      ]
    );
    return client;
  }

  async saveRegistrationToken(
    token: RegistrationTokenRecord
  ): Promise<RegistrationTokenRecord> {
    await this.ensureSchema();
    await this.pool.query(
      `insert into control_plane_install_tokens (
        token,
        client_id,
        installation_id,
        expires_at,
        used_at,
        record,
        updated_at
      )
      values ($1, $2, $3, $4, $5, $6::jsonb, now())
      on conflict (token) do update set
        client_id = excluded.client_id,
        installation_id = excluded.installation_id,
        expires_at = excluded.expires_at,
        used_at = excluded.used_at,
        record = excluded.record,
        updated_at = now()`,
      [
        token.token,
        token.client_id,
        token.installation_id,
        token.expires_at,
        token.used_at,
        JSON.stringify(token)
      ]
    );
    return token;
  }

  async getRegistrationToken(token: string): Promise<RegistrationTokenRecord | null> {
    await this.ensureSchema();
    const result = await this.pool.query<{ record: RegistrationTokenRecord }>(
      "select record from control_plane_install_tokens where token = $1",
      [token]
    );
    return result.rows[0]?.record ?? null;
  }

  async updateRegistrationToken(
    token: RegistrationTokenRecord
  ): Promise<RegistrationTokenRecord> {
    return this.saveRegistrationToken(token);
  }

  private async ensureSchema(): Promise<void> {
    this.schemaReady ??= this.pool.query(`
      create table if not exists control_plane_clients (
        client_id text primary key,
        legal_name text not null,
        installation_id text not null unique,
        authorized_user_emails jsonb not null,
        record jsonb not null,
        updated_at timestamptz not null default now()
      );

      create index if not exists control_plane_clients_authorized_user_emails_idx
        on control_plane_clients using gin (authorized_user_emails);

      create table if not exists control_plane_install_tokens (
        token text primary key,
        client_id text not null references control_plane_clients(client_id) on delete cascade,
        installation_id text not null,
        expires_at timestamptz not null,
        used_at timestamptz,
        record jsonb not null,
        updated_at timestamptz not null default now()
      );

      create index if not exists control_plane_install_tokens_client_idx
        on control_plane_install_tokens (client_id, installation_id);
    `).then(() => undefined);

    return this.schemaReady;
  }
}
