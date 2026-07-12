import { Pool } from "pg";

type MaybePromise<T> = T | Promise<T>;

export type TenantToken = { tenant_id: string; installation_id: string };

export type TenantProvisioningInput = {
  client_id: string;
  legal_name: string;
  authorized_email: string;
  installation_id: string;
};

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

export type TenantRegistrationTokenInput = {
  token: string;
  installation_id: string;
  expires_at: string;
  used_at: string | null;
};

export type TenantRegistrationTokenRecord = TenantRegistrationTokenInput & {
  tenant_id: string;
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

export type ReleaseRecord = { version: string; notes: string | null };

/**
 * Store for the Supabase-backed tenant tables (see
 * supabase/migrations/0001_control_plane.sql). Accessed only from this API
 * with the service-role/direct connection after validating either an appliance
 * credential or a portal session — neither client talks to these tables with
 * elevated credentials.
 */
export type TenantDataStore = {
  resolveTenantByToken(token: string): MaybePromise<TenantToken | null>;
  provisionClient(input: TenantProvisioningInput): MaybePromise<TenantToken>;
  issueRegistrationToken(
    token: TenantRegistrationTokenInput
  ): MaybePromise<TenantRegistrationTokenRecord>;
  markRegistrationTokenUsed(token: string, usedAt: string): MaybePromise<void>;
  claimPortalProfile(input: PortalProfileClaimInput): MaybePromise<PortalProfile | null>;
  insertSentinelReport(report: SentinelReportInput): MaybePromise<void>;
  recordUsage(event: UsageEventInput): MaybePromise<void>;
  latestRelease(): MaybePromise<ReleaseRecord | null>;
  getInstallationSettings(installationId: string): MaybePromise<Record<string, unknown>>;
  touchInstallation(installationId: string, version: string | null, at: string): MaybePromise<void>;
};

export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [pa, pb] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function maxSemver(versions: string[]): string | null {
  return versions.filter((version) => /^v\d+\.\d+\.\d+$/.test(version)).reduce<string | null>(
    (max, v) => (max === null || compareSemver(v, max) > 0 ? v : max),
    null
  );
}

export type InMemoryTenantDataSeed = {
  tokens?: Array<{
    token: string;
    tenant_id: string;
    installation_id: string;
    expires_at?: string;
    used_at?: string | null;
  }>;
  installations?: Array<{
    tenant_id: string;
    installation_id: string;
    version?: string | null;
    settings?: Record<string, unknown>;
  }>;
  releases?: ReleaseRecord[];
};

export function createInMemoryTenantDataStore(seed: InMemoryTenantDataSeed = {}) {
  const tokens = new Map(
    (seed.tokens ?? []).map((t) => [t.token, { used_at: null, expires_at: FAR_FUTURE, ...t }])
  );
  const installations = new Map(
    (seed.installations ?? []).map((i) => [
      i.installation_id,
      { version: null, settings: {}, last_heartbeat_at: null as string | null, ...i }
    ])
  );
  const releases = [...(seed.releases ?? [])];
  const sentinelReports: Array<SentinelReportInput & { status: string }> = [];
  const usageEvents = new Map<string, UsageEventInput>();
  const clientTenants = new Map<string, string>();
  const clientAuthorizedEmails = new Map<string, string>();
  const tenantAuthorizedEmails = new Map<string, string>();
  const profiles = new Map<string, PortalProfile>();

  const store = {
    sentinelReports,
    usageEvents,
    installations,
    profiles,
    resolveTenantByToken(token: string): TenantToken | null {
      const record = tokens.get(token);
      if (!record) return null;
      // ponytail: a used token is the installation's long-lived credential;
      // only unused tokens expire.
      if (!record.used_at && Date.parse(record.expires_at) <= Date.now()) return null;
      const installation = installations.get(record.installation_id);
      if (!installation || installation.tenant_id !== record.tenant_id) return null;
      return { tenant_id: record.tenant_id, installation_id: record.installation_id };
    },
    provisionClient(input: TenantProvisioningInput): TenantToken {
      const tenantId = clientTenants.get(input.client_id) ?? `tenant:${input.client_id}`;
      clientTenants.set(input.client_id, tenantId);
      const authorizedEmail = input.authorized_email.trim().toLowerCase();
      const previousEmail = clientAuthorizedEmails.get(input.client_id);
      if (previousEmail && previousEmail !== authorizedEmail) {
        tenantAuthorizedEmails.delete(previousEmail);
      }
      const emailTenant = tenantAuthorizedEmails.get(authorizedEmail);
      if (emailTenant && emailTenant !== tenantId) throw new Error("authorized_email_already_used");
      clientAuthorizedEmails.set(input.client_id, authorizedEmail);
      tenantAuthorizedEmails.set(authorizedEmail, tenantId);
      const existing = installations.get(input.installation_id);
      if (existing && existing.tenant_id !== tenantId) {
        throw new Error("installation_tenant_mismatch");
      }
      installations.set(input.installation_id, {
        tenant_id: tenantId,
        installation_id: input.installation_id,
        version: existing?.version ?? null,
        settings: existing?.settings ?? {},
        last_heartbeat_at: existing?.last_heartbeat_at ?? null
      });
      return { tenant_id: tenantId, installation_id: input.installation_id };
    },
    claimPortalProfile(input: PortalProfileClaimInput): PortalProfile | null {
      const existing = profiles.get(input.user_id);
      const tenantId = tenantAuthorizedEmails.get(input.email.trim().toLowerCase()) ?? null;
      if (existing) {
        const normalizedEmail = input.email.trim().toLowerCase();
        const sameIdentity = existing.email === normalizedEmail;
        const stillAuthorized = sameIdentity && (existing.role === "vendor_admin"
          ? input.vendor_admin
          : !input.vendor_admin && tenantId === existing.tenant_id);
        if (stillAuthorized) return existing;
        profiles.delete(input.user_id);
        return null;
      }
      const profile: PortalProfile | null = input.vendor_admin
        ? {
            user_id: input.user_id,
            tenant_id: null,
            role: "vendor_admin",
            email: input.email.trim().toLowerCase()
          }
        : tenantId
          ? {
              user_id: input.user_id,
              tenant_id: tenantId,
              role: "owner",
              email: input.email.trim().toLowerCase()
            }
          : null;
      if (profile) profiles.set(input.user_id, profile);
      return profile;
    },
    issueRegistrationToken(
      input: TenantRegistrationTokenInput
    ): TenantRegistrationTokenRecord {
      const installation = installations.get(input.installation_id);
      if (!installation) throw new Error("installation_not_provisioned");
      const record = { ...input, tenant_id: installation.tenant_id };
      tokens.set(input.token, record);
      return record;
    },
    markRegistrationTokenUsed(token: string, usedAt: string): void {
      const record = tokens.get(token);
      if (!record) throw new Error("registration_token_not_found");
      tokens.set(token, { ...record, used_at: usedAt });
    },
    insertSentinelReport(report: SentinelReportInput): void {
      sentinelReports.push({ ...report, status: "new" });
    },
    recordUsage(event: UsageEventInput): void {
      const key = `${event.tenant_id}|${event.day}|${event.channel}`;
      usageEvents.set(key, event);
    },
    latestRelease(): ReleaseRecord | null {
      const version = maxSemver(releases.map((r) => r.version));
      return releases.find((r) => r.version === version) ?? null;
    },
    getInstallationSettings(installationId: string): Record<string, unknown> {
      return installations.get(installationId)?.settings ?? {};
    },
    touchInstallation(installationId: string, version: string | null, at: string): void {
      const installation = installations.get(installationId);
      if (!installation) return;
      installation.last_heartbeat_at = at;
      if (version) installation.version = version;
    }
  } satisfies TenantDataStore & Record<string, unknown>;

  return store;
}

const FAR_FUTURE = "9999-01-01T00:00:00.000Z";

export type PostgresTenantDataStoreOptions = { connectionString: string };

/**
 * Runs against the Supabase database with the service-role/direct connection
 * (bypasses RLS by design). DDL is owned by supabase/migrations.
 */
export function createPostgresTenantDataStore(
  options: PostgresTenantDataStoreOptions
): TenantDataStore {
  const pool = new Pool({
    connectionString: options.connectionString,
    ssl: sslConfigFor(options.connectionString)
  });

  return {
    async resolveTenantByToken(token) {
      const result = await pool.query<TenantToken>(
        `select rt.tenant_id::text, rt.installation_id
         from registration_tokens rt
         inner join installations i
           on i.tenant_id = rt.tenant_id
          and i.installation_id = rt.installation_id
         where rt.token = $1 and (rt.used_at is not null or rt.expires_at > now())`,
        [token]
      );
      return result.rows[0] ?? null;
    },
    async provisionClient(input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const tenant = await client.query<{ tenant_id: string }>(
          `insert into tenants (client_id, name, authorized_email)
           values ($1, $2, $3)
           on conflict (client_id) do update set
             name = excluded.name,
             authorized_email = excluded.authorized_email
           returning id::text as tenant_id`,
          [input.client_id, input.legal_name, input.authorized_email.trim().toLowerCase()]
        );
        const tenantId = tenant.rows[0]!.tenant_id;
        const installation = await client.query<TenantToken>(
          `insert into installations (tenant_id, installation_id)
           values ($1::uuid, $2)
           on conflict (installation_id) do update set installation_id = excluded.installation_id
           returning tenant_id::text, installation_id`,
          [tenantId, input.installation_id]
        );
        if (installation.rows[0]?.tenant_id !== tenantId) {
          throw new Error("installation_tenant_mismatch");
        }
        await client.query("commit");
        return installation.rows[0]!;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async issueRegistrationToken(input) {
      const result = await pool.query<TenantRegistrationTokenRecord>(
        `insert into registration_tokens (
           token, tenant_id, installation_id, expires_at, used_at
         )
         select $1, tenant_id, installation_id, $3, $4
         from installations
         where installation_id = $2
         on conflict (token) do update set
           tenant_id = excluded.tenant_id,
           installation_id = excluded.installation_id,
           expires_at = excluded.expires_at,
           used_at = excluded.used_at
         returning token, tenant_id::text, installation_id,
                   expires_at::text, used_at::text`,
        [input.token, input.installation_id, input.expires_at, input.used_at]
      );
      const record = result.rows[0];
      if (!record) throw new Error("installation_not_provisioned");
      return record;
    },
    async markRegistrationTokenUsed(token, usedAt) {
      const result = await pool.query(
        "update registration_tokens set used_at = $2 where token = $1",
        [token, usedAt]
      );
      if (result.rowCount !== 1) throw new Error("registration_token_not_found");
    },
    async claimPortalProfile(input) {
      const existing = await pool.query<PortalProfile>(
        `select user_id::text, tenant_id::text, role, email
         from profiles where user_id = $1::uuid`,
        [input.user_id]
      );
      if (existing.rows[0]) {
        const profile = existing.rows[0];
        const normalizedEmail = input.email.trim().toLowerCase();
        let stillAuthorized =
          profile.email === normalizedEmail && input.vendor_admin && profile.role === "vendor_admin";
        if (profile.email === normalizedEmail && !input.vendor_admin && profile.role !== "vendor_admin") {
          const tenant = await pool.query<{ tenant_id: string }>(
            "select id::text as tenant_id from tenants where authorized_email = $1",
            [input.email.trim().toLowerCase()]
          );
          stillAuthorized = tenant.rows[0]?.tenant_id === profile.tenant_id;
        }
        if (stillAuthorized) return profile;
        await pool.query("delete from profiles where user_id = $1::uuid", [input.user_id]);
        return null;
      }

      if (input.vendor_admin) {
        await pool.query(
          `insert into profiles (user_id, tenant_id, role, email)
           values ($1::uuid, null, 'vendor_admin', $2)
           on conflict (user_id) do nothing`,
          [input.user_id, input.email.trim().toLowerCase()]
        );
      } else {
        const tenant = await pool.query<{ tenant_id: string }>(
          "select id::text as tenant_id from tenants where authorized_email = $1",
          [input.email.trim().toLowerCase()]
        );
        if (!tenant.rows[0]) return null;
        await pool.query(
          `insert into profiles (user_id, tenant_id, role, email)
           values ($1::uuid, $2::uuid, 'owner', $3)
           on conflict (user_id) do nothing`,
          [input.user_id, tenant.rows[0].tenant_id, input.email.trim().toLowerCase()]
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
         values ($1, $2, $3, $4, $5::jsonb)`,
        [report.tenant_id, report.installation_id, report.week_start, report.body_md, JSON.stringify(report.stats)]
      );
    },
    async recordUsage(event) {
      await pool.query(
        `insert into usage_events (tenant_id, day, channel, quotes, routes)
         values ($1, $2, $3, $4, $5)
         on conflict (tenant_id, day, channel) do update set
           quotes = excluded.quotes,
           routes = excluded.routes`,
        [event.tenant_id, event.day, event.channel, event.quotes, event.routes]
      );
    },
    async latestRelease() {
      const result = await pool.query<ReleaseRecord>("select version, notes from releases");
      const version = maxSemver(result.rows.map((r) => r.version));
      return result.rows.find((r) => r.version === version) ?? null;
    },
    async getInstallationSettings(installationId) {
      const result = await pool.query<{ settings: Record<string, unknown> }>(
        "select settings from installations where installation_id = $1",
        [installationId]
      );
      return result.rows[0]?.settings ?? {};
    },
    async touchInstallation(installationId, version, at) {
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

export function createDefaultTenantDataStore(
  env: NodeJS.ProcessEnv = process.env
): TenantDataStore | null {
  const connectionString =
    env.QUOTEOPS_SUPABASE_DB_URL?.trim() || env.DATABASE_URL?.trim() || null;
  return connectionString ? createPostgresTenantDataStore({ connectionString }) : null;
}

// Same TLS heuristic as stores/postgresStore.ts.
function sslConfigFor(connectionString: string): { rejectUnauthorized: boolean } | undefined {
  if (/sslmode=disable/i.test(connectionString)) return undefined;
  if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString)) return undefined;
  return { rejectUnauthorized: false };
}
