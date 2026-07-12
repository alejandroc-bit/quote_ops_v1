import { Pool } from "pg";

type MaybePromise<T> = T | Promise<T>;

export type TenantToken = { tenant_id: string };

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
 * with the service-role/direct connection after validating the installation
 * registration token — appliances never talk to Supabase directly.
 */
export type TenantDataStore = {
  resolveTenantByToken(token: string): MaybePromise<TenantToken | null>;
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
  return versions.reduce<string | null>(
    (max, v) => (max === null || compareSemver(v, max) > 0 ? v : max),
    null
  );
}

export type InMemoryTenantDataSeed = {
  tokens?: Array<{ token: string; tenant_id: string; expires_at?: string; used_at?: string | null }>;
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

  const store = {
    sentinelReports,
    usageEvents,
    installations,
    resolveTenantByToken(token: string): TenantToken | null {
      const record = tokens.get(token);
      if (!record) return null;
      // ponytail: a used token is the installation's long-lived credential;
      // only unused tokens expire.
      if (!record.used_at && Date.parse(record.expires_at) <= Date.now()) return null;
      return { tenant_id: record.tenant_id };
    },
    insertSentinelReport(report: SentinelReportInput): void {
      sentinelReports.push({ ...report, status: "new" });
    },
    recordUsage(event: UsageEventInput): void {
      const key = `${event.tenant_id}|${event.day}|${event.channel}`;
      const existing = usageEvents.get(key);
      usageEvents.set(
        key,
        existing
          ? { ...existing, quotes: existing.quotes + event.quotes, routes: existing.routes + event.routes }
          : event
      );
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
      const result = await pool.query<{ tenant_id: string }>(
        `select tenant_id from registration_tokens
         where token = $1 and (used_at is not null or expires_at > now())`,
        [token]
      );
      return result.rows[0] ?? null;
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
           quotes = usage_events.quotes + excluded.quotes,
           routes = usage_events.routes + excluded.routes`,
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
