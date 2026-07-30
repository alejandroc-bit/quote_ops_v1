import { Pool } from "pg";
import {
  normalizeClientId,
  normalizeEmail,
  type AuthorizedUser,
  type MinimalClientRecord,
  type QuoteCounters
} from "@quoteops/control-plane";
import {
  maxSemver,
  validateRegistrationTokenRecord,
  validateReleaseRecord,
  type ControlPlaneData,
  type PortalProfile,
  type RegistrationTokenRecord,
  type ReleaseRecord,
  type TenantToken
} from "./index.js";

export type PostgresControlPlaneDataOptions = { connectionString: string };

export type ControlPlaneClientRow = {
  tenant_id: string;
  client_id: string;
  authorized_email: string;
  legal_name: string;
  created_at: string | Date;
  status: MinimalClientRecord["status"];
  authorized_users: unknown;
  installation_id: string;
  license_status: MinimalClientRecord["installation"]["license_status"];
  onboarding_status: MinimalClientRecord["installation"]["onboarding_status"];
  last_heartbeat_at: string | Date | null;
  ai_key_status: MinimalClientRecord["installation"]["ai_key_status"];
  counters: unknown;
};

const CLIENT_PROJECTION = `
  select
    t.id::text as tenant_id,
    t.client_id,
    t.authorized_email,
    t.name as legal_name,
    t.created_at,
    t.status,
    t.authorized_users,
    i.installation_id,
    i.license_status,
    i.onboarding_status,
    i.last_heartbeat_at,
    i.ai_key_status,
    i.counters
  from tenants t
  inner join installations i on i.tenant_id = t.id
`;

export function projectMinimalClientRecord(row: ControlPlaneClientRow): MinimalClientRecord {
  const createdAt = toIsoString(row.created_at)!;
  return {
    client_id: row.client_id,
    legal_name: row.legal_name,
    status: row.status,
    created_at: createdAt,
    authorized_users: projectAuthorizedUsers(row.authorized_users, row.authorized_email, createdAt),
    installation: {
      installation_id: row.installation_id,
      client_id: row.client_id,
      license_status: row.license_status,
      onboarding_status: row.onboarding_status,
      last_heartbeat_at: toIsoString(row.last_heartbeat_at),
      ai_key_status: row.ai_key_status
    },
    counters: projectCounters(row.counters)
  };
}

export function createPostgresControlPlaneData(
  options: PostgresControlPlaneDataOptions
): ControlPlaneData {
  const pool = new Pool({
    connectionString: options.connectionString,
    ssl: sslConfigFor(options.connectionString),
    allowExitOnIdle: true
  });
  let task2SchemaReady: Promise<void> | null = null;

  function ensureTask2Schema(): Promise<void> {
    task2SchemaReady ??= pool
      .query(`
        alter table registration_tokens add column if not exists release_version text;
        alter table registration_tokens add column if not exists bundle_sha256 text;
        alter table registration_tokens add column if not exists install_pack jsonb;
        alter table registration_tokens add column if not exists pack_sha256 text;
        alter table releases add column if not exists bundle_sha256 text;
        alter table releases add column if not exists manifest jsonb;
        alter table releases add column if not exists manifest_bytes bytea;
        alter table releases add column if not exists archive bytea;
        alter table releases add column if not exists published_at timestamptz default now();
        create unique index if not exists releases_bundle_sha256_unique
          on releases (bundle_sha256) where bundle_sha256 is not null;
      `)
      .then(() => undefined);
    return task2SchemaReady;
  }

  async function queryClients(
    where = "",
    parameters: unknown[] = []
  ): Promise<Array<ControlPlaneClientRow>> {
    // ponytail: the current product permits one installation per tenant. If
    // multi-install tenants arrive, this projection must become explicit.
    const result = await pool.query<ControlPlaneClientRow>(
      `${CLIENT_PROJECTION} ${where}`,
      parameters
    );
    return result.rows;
  }

  return {
    async listClients() {
      return (await queryClients("order by t.name asc")).map(projectMinimalClientRecord);
    },
    async getClient(clientId) {
      const rows = await queryClients("where t.client_id = $1", [normalizeClientId(clientId)]);
      return rows[0] ? projectMinimalClientRecord(rows[0]) : null;
    },
    async getClientByInstallation(installationId) {
      const rows = await queryClients("where i.installation_id = $1", [installationId]);
      return rows[0] ? projectMinimalClientRecord(rows[0]) : null;
    },
    async findClientByAuthorizedEmail(email) {
      const normalized = normalizeEmail(email);
      const rows = await queryClients(
        `where t.authorized_email = $1
           or t.authorized_users @> $2::jsonb
         order by t.name asc
         limit 1`,
        [normalized, JSON.stringify([{ email: normalized }])]
      );
      return rows[0] ? projectMinimalClientRecord(rows[0]) : null;
    },
    async upsertClient(client) {
      const primaryUser = client.authorized_users[0];
      if (!primaryUser) throw new Error("authorized_user_required");
      const authorizedEmail = normalizeEmail(primaryUser.email);
      const db = await pool.connect();
      try {
        await db.query("begin");
        const tenant = await db.query<{ tenant_id: string }>(
          `insert into tenants (
             client_id, name, authorized_email, status, authorized_users, created_at
           ) values ($1, $2, $3, $4, $5::jsonb, $6)
           on conflict (client_id) do update set
             name = excluded.name,
             authorized_email = excluded.authorized_email,
             status = excluded.status,
             authorized_users = excluded.authorized_users
           returning id::text as tenant_id`,
          [
            normalizeClientId(client.client_id),
            client.legal_name,
            authorizedEmail,
            client.status,
            JSON.stringify(
              client.authorized_users.map((user, index) => ({
                ...user,
                email: index === 0 ? authorizedEmail : normalizeEmail(user.email)
              }))
            ),
            client.created_at
          ]
        );
        const tenantId = tenant.rows[0]!.tenant_id;
        const installation = await db.query<{ tenant_id: string }>(
          `insert into installations (
             tenant_id,
             installation_id,
             license_status,
             onboarding_status,
             last_heartbeat_at,
             ai_key_status,
             counters
           ) values ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb)
           on conflict (installation_id) do update set
             license_status = excluded.license_status,
             onboarding_status = excluded.onboarding_status,
             last_heartbeat_at = excluded.last_heartbeat_at,
             ai_key_status = excluded.ai_key_status,
             counters = excluded.counters
           where installations.tenant_id = excluded.tenant_id
           returning tenant_id::text`,
          [
            tenantId,
            client.installation.installation_id,
            client.installation.license_status,
            client.installation.onboarding_status,
            client.installation.last_heartbeat_at,
            client.installation.ai_key_status,
            JSON.stringify(client.counters)
          ]
        );
        if (installation.rows[0]?.tenant_id !== tenantId) {
          throw new Error("installation_tenant_mismatch");
        }
        await db.query("commit");
        return client;
      } catch (error) {
        await db.query("rollback");
        throw error;
      } finally {
        db.release();
      }
    },
    async saveRegistrationToken(token) {
      await ensureTask2Schema();
      const valid = validateRegistrationTokenRecord(token);
      const result = await pool.query<RegistrationTokenRecord>(
        `insert into registration_tokens (
           token, tenant_id, installation_id, expires_at, used_at,
           release_version, bundle_sha256, install_pack, pack_sha256
         )
         select $1, t.id, i.installation_id, $4, $5, $6, $7, $8::jsonb, $9
         from tenants t
         inner join installations i on i.tenant_id = t.id
         where t.client_id = $2 and i.installation_id = $3
         on conflict (token) do update set
           tenant_id = excluded.tenant_id,
            installation_id = excluded.installation_id,
            expires_at = excluded.expires_at,
            used_at = excluded.used_at,
            release_version = excluded.release_version,
            bundle_sha256 = excluded.bundle_sha256,
            install_pack = excluded.install_pack,
            pack_sha256 = excluded.pack_sha256
          returning token, $2::text as client_id, installation_id,
                    expires_at::text, used_at::text, release_version,
                    bundle_sha256, install_pack as install_pack_snapshot,
                    pack_sha256`,
        [
          valid.token,
          normalizeClientId(valid.client_id),
          valid.installation_id,
          valid.expires_at,
          valid.used_at,
          valid.release_version,
          valid.bundle_sha256,
          JSON.stringify(valid.install_pack_snapshot),
          valid.pack_sha256
        ]
      );
      const saved = result.rows[0];
      if (!saved) throw new Error("installation_not_provisioned");
      return validateRegistrationTokenRecord(saved);
    },
    async getRegistrationToken(token) {
      await ensureTask2Schema();
      const result = await pool.query<RegistrationTokenRecord>(
        `select rt.token, t.client_id, rt.installation_id,
                 rt.expires_at::text, rt.used_at::text,
                 rt.release_version, rt.bundle_sha256,
                 rt.install_pack as install_pack_snapshot, rt.pack_sha256
         from registration_tokens rt
         inner join tenants t on t.id = rt.tenant_id
         where rt.token = $1`,
        [token]
      );
      return result.rows[0]
        ? validateRegistrationTokenRecord(result.rows[0])
        : null;
    },
    async markRegistrationTokenUsed(token, usedAt) {
      const result = await pool.query(
        "update registration_tokens set used_at = $2 where token = $1",
        [token, usedAt]
      );
      if (result.rowCount !== 1) throw new Error("registration_token_not_found");
    },
    async resolveTenantByToken(token) {
      await ensureTask2Schema();
      const result = await pool.query<
        RegistrationTokenRecord & TenantToken
      >(
        `select rt.token, rt.tenant_id::text, t.client_id,
                rt.installation_id, rt.expires_at::text, rt.used_at::text,
                rt.release_version, rt.bundle_sha256,
                rt.install_pack as install_pack_snapshot, rt.pack_sha256
          from registration_tokens rt
          inner join tenants t on t.id = rt.tenant_id
          inner join installations i
            on i.tenant_id = rt.tenant_id
          and i.installation_id = rt.installation_id
         where rt.token = $1 and (rt.used_at is not null or rt.expires_at > now())`,
         [token]
      );
      const row = result.rows[0];
      if (!row) return null;
      validateRegistrationTokenRecord(row);
      return {
        tenant_id: row.tenant_id,
        installation_id: row.installation_id
      };
    },
    async claimPortalProfile(input) {
      const existing = await pool.query<PortalProfile>(
        `select user_id::text, tenant_id::text, role, email
         from profiles where user_id = $1::uuid`,
        [input.user_id]
      );
      if (existing.rows[0]) {
        const profile = existing.rows[0];
        const normalizedEmail = normalizeEmail(input.email);
        let stillAuthorized =
          profile.email === normalizedEmail && input.vendor_admin && profile.role === "vendor_admin";
        if (profile.email === normalizedEmail && !input.vendor_admin && profile.role !== "vendor_admin") {
          const tenant = await pool.query<{ tenant_id: string }>(
            "select id::text as tenant_id from tenants where authorized_email = $1",
            [normalizedEmail]
          );
          stillAuthorized = tenant.rows[0]?.tenant_id === profile.tenant_id;
        }
        if (stillAuthorized) return profile;
        await pool.query("delete from profiles where user_id = $1::uuid", [input.user_id]);
        return null;
      }

      const normalizedEmail = normalizeEmail(input.email);
      if (input.vendor_admin) {
        await pool.query(
          `insert into profiles (user_id, tenant_id, role, email)
           values ($1::uuid, null, 'vendor_admin', $2)
           on conflict (user_id) do nothing`,
          [input.user_id, normalizedEmail]
        );
      } else {
        const tenant = await pool.query<{ tenant_id: string }>(
          "select id::text as tenant_id from tenants where authorized_email = $1",
          [normalizedEmail]
        );
        if (!tenant.rows[0]) return null;
        await pool.query(
          `insert into profiles (user_id, tenant_id, role, email)
           values ($1::uuid, $2::uuid, 'owner', $3)
           on conflict (user_id) do nothing`,
          [input.user_id, tenant.rows[0].tenant_id, normalizedEmail]
        );
      }

      const claimed = await pool.query<PortalProfile>(
        `select user_id::text, tenant_id::text, role, email
         from profiles where user_id = $1::uuid`,
        [input.user_id]
      );
      return claimed.rows[0] ?? null;
    },
    async insertSentinelReport(report) {
      await pool.query(
        `insert into sentinel_reports (tenant_id, installation_id, week_start, body_md, stats)
         values ($1::uuid, $2, $3, $4, $5::jsonb)`,
        [report.tenant_id, report.installation_id, report.week_start, report.body_md, JSON.stringify(report.stats)]
      );
    },
    async recordUsage(event) {
      await pool.query(
        `insert into usage_events (tenant_id, day, channel, quotes, routes)
         values ($1::uuid, $2, $3, $4, $5)
         on conflict (tenant_id, day, channel) do update set
           quotes = excluded.quotes,
           routes = excluded.routes`,
        [event.tenant_id, event.day, event.channel, event.quotes, event.routes]
      );
    },
    async latestRelease() {
      await ensureTask2Schema();
      const result = await pool.query<ReleaseRecord>(
        `select version, notes, bundle_sha256, manifest, manifest_bytes,
                archive as archive_bytes, published_at::text
         from releases`
      );
      const version = maxSemver(result.rows.map((release) => release.version));
      const release = result.rows.find((candidate) => candidate.version === version);
      return release ? validateReleaseRecord(release) : null;
    },
    async getRelease(version) {
      await ensureTask2Schema();
      const result = await pool.query<ReleaseRecord>(
        `select version, notes, bundle_sha256, manifest, manifest_bytes,
                archive as archive_bytes, published_at::text
         from releases where version = $1`,
        [version]
      );
      return result.rows[0] ? validateReleaseRecord(result.rows[0]) : null;
    },
    async upsertRelease(release) {
      await ensureTask2Schema();
      const valid = validateReleaseRecord(release);
      try {
        const result = await pool.query<ReleaseRecord>(
          `insert into releases (
             version, notes, bundle_sha256, manifest, manifest_bytes, archive, published_at
           ) values ($1, $2, $3, $4::jsonb, $5, $6, $7)
           on conflict (version) do nothing
           returning version, notes, bundle_sha256, manifest, manifest_bytes,
                     archive as archive_bytes, published_at::text`,
          [
            valid.version,
            valid.notes,
            valid.bundle_sha256,
            JSON.stringify(valid.manifest),
            Buffer.from(valid.manifest_bytes),
            Buffer.from(valid.archive_bytes),
            valid.published_at
          ]
        );
        if (result.rows[0]) return validateReleaseRecord(result.rows[0]);
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new Error("release_bundle_immutable");
        }
        throw error;
      }
      const current = await this.getRelease(valid.version);
      if (!current || current.bundle_sha256 !== valid.bundle_sha256) {
        throw new Error("release_version_immutable");
      }
      return current;
    },
    async getInstallationSettings(installationId) {
      const result = await pool.query<{ settings: Record<string, unknown> }>(
        "select settings from installations where installation_id = $1",
        [installationId]
      );
      return result.rows[0]?.settings ?? {};
    },
    async touchInstallation(installationId, version, at, client) {
      if (client) {
        await pool.query(
          `update installations set
             last_heartbeat_at = $2,
             version = coalesce($3, version),
             license_status = $4,
             onboarding_status = $5,
             ai_key_status = $6,
             counters = $7::jsonb
           where installation_id = $1`,
          [
            installationId,
            at,
            version,
            client.installation.license_status,
            client.installation.onboarding_status,
            client.installation.ai_key_status,
            JSON.stringify(client.counters)
          ]
        );
        return;
      }
      await pool.query(
        `update installations set
           last_heartbeat_at = $2,
           version = coalesce($3, version)
         where installation_id = $1`,
        [installationId, at, version]
      );
    }
  };
}

function projectAuthorizedUsers(
  value: unknown,
  fallbackEmail: string,
  fallbackCreatedAt: string
): AuthorizedUser[] {
  if (!Array.isArray(value)) {
    return [{ email: normalizeEmail(fallbackEmail), role: "owner", created_at: fallbackCreatedAt }];
  }
  const users = value.flatMap((candidate): AuthorizedUser[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const record = candidate as Record<string, unknown>;
    if (typeof record.email !== "string") return [];
    const role = record.role === "operator" ? "operator" : "owner";
    return [{
      email: normalizeEmail(record.email),
      role,
      created_at: typeof record.created_at === "string" ? record.created_at : fallbackCreatedAt
    }];
  });
  return users.length > 0
    ? users
    : [{ email: normalizeEmail(fallbackEmail), role: "owner", created_at: fallbackCreatedAt }];
}

function projectCounters(value: unknown): QuoteCounters {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const counter = (key: keyof QuoteCounters) => {
    const candidate = record[key];
    return typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0
      ? candidate
      : 0;
  };
  return {
    total: counter("total"),
    validated: counter("validated"),
    rejected: counter("rejected"),
    pending: counter("pending"),
    failed: counter("failed")
  };
}

function toIsoString(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function sslConfigFor(connectionString: string): { rejectUnauthorized: boolean } | undefined {
  if (/sslmode=disable/i.test(connectionString)) return undefined;
  if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString)) return undefined;
  return { rejectUnauthorized: false };
}
