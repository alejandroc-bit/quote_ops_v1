import type { SqlExecutor } from "../tms/SqlTmsAdapter.js";
import { createSqlExecutor, type SqlDialect } from "../tms/sqlExecutor.js";
import type { KeyValueCache } from "./KeyValueCache.js";

/**
 * Durable cache-aside layer over the CLIENT's own SQL database (appliance
 * Postgres by default, or external Cloud SQL / Azure SQL via
 * QUOTEOPS_CACHE_DB_URL) so cached TMS lookups survive restarts.
 *
 * Layering guidance: when Redis is configured, put it in FRONT of this cache
 * (fast tier) via `createTieredCache(redis, sqlCache)` — Redis absorbs the hot
 * path, SQL is the durable layer that repopulates it after a restart.
 *
 * Table (created lazily on first use):
 *   cache_entries(cache_key pk, value text, expires_at timestamp null)
 * Expiry is compared in JS so all three dialects behave identically.
 */
export class SqlKeyValueCache implements KeyValueCache {
  private ready: Promise<void> | null = null;

  constructor(
    private readonly executor: SqlExecutor,
    private readonly dialect: SqlDialect = "postgres",
    private readonly now: () => number = () => Date.now()
  ) {}

  private ensureTable(): Promise<void> {
    // memoized so the DDL runs once; reset on failure so the next call retries
    this.ready ??= this.executor.query(createTableSql(this.dialect), {}).then(
      () => undefined,
      (error) => {
        this.ready = null;
        throw error;
      }
    );
    return this.ready;
  }

  async get(key: string): Promise<string | null> {
    try {
      await this.ensureTable();
      const rows = await this.executor.query(
        "SELECT value, expires_at FROM cache_entries WHERE cache_key = :key",
        { key }
      );
      const row = rows[0];
      if (!row) return null;
      const expiresAt = row.expires_at;
      if (expiresAt != null && new Date(expiresAt as string | Date).getTime() <= this.now()) {
        await this.del(key); // best-effort cleanup of the expired entry
        return null;
      }
      return String(row.value);
    } catch {
      return null; // cache is a speed-up, never a source of truth
    }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    try {
      await this.ensureTable();
      const expiresAt = ttlSeconds != null ? new Date(this.now() + ttlSeconds * 1000) : null;
      // ponytail: delete+insert instead of per-dialect upsert; a lost race on a
      // best-effort cache write is harmless. Switch to native upsert if PK
      // collisions ever show up in logs at real concurrency.
      await this.del(key);
      await this.executor.query(
        "INSERT INTO cache_entries (cache_key, value, expires_at) VALUES (:key, :value, :expires_at)",
        { key, value, expires_at: expiresAt }
      );
    } catch {
      /* best-effort cache write */
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.ensureTable();
      await this.executor.query("DELETE FROM cache_entries WHERE cache_key = :key", { key });
    } catch {
      /* best-effort */
    }
  }

  async close(): Promise<void> {
    await this.executor.close();
  }
}

function createTableSql(dialect: SqlDialect): string {
  if (dialect === "mssql") {
    return (
      "IF OBJECT_ID(N'cache_entries', N'U') IS NULL " +
      "CREATE TABLE cache_entries (cache_key NVARCHAR(450) NOT NULL PRIMARY KEY, " +
      "value NVARCHAR(MAX) NOT NULL, expires_at DATETIME2 NULL)"
    );
  }
  if (dialect === "mysql") {
    return (
      "CREATE TABLE IF NOT EXISTS cache_entries (cache_key VARCHAR(512) NOT NULL PRIMARY KEY, " +
      "value TEXT NOT NULL, expires_at DATETIME NULL)"
    );
  }
  return (
    "CREATE TABLE IF NOT EXISTS cache_entries (cache_key TEXT PRIMARY KEY, " +
    "value TEXT NOT NULL, expires_at TIMESTAMPTZ NULL)"
  );
}

const sqlDialects: readonly SqlDialect[] = ["postgres", "mysql", "mssql"];

/**
 * Env-driven factory: QUOTEOPS_CACHE_DB_DIALECT + QUOTEOPS_CACHE_DB_URL point
 * the cache at the client's own SQL tech; otherwise falls back to the
 * appliance DATABASE_URL (postgres). Returns null when nothing is configured
 * or the driver fails to load, so the caller degrades to an uncached adapter.
 */
export async function createSqlCacheFromEnv(
  env: Record<string, string | undefined>
): Promise<SqlKeyValueCache | null> {
  const url = env.QUOTEOPS_CACHE_DB_URL ?? env.DATABASE_URL;
  if (!url) return null;
  const dialect = (
    env.QUOTEOPS_CACHE_DB_URL ? (env.QUOTEOPS_CACHE_DB_DIALECT ?? "postgres") : "postgres"
  ) as SqlDialect;
  if (!sqlDialects.includes(dialect)) return null;
  try {
    const executor = await createSqlExecutor(dialect, url);
    return new SqlKeyValueCache(executor, dialect);
  } catch {
    return null;
  }
}

/**
 * Minimal two-tier cache: reads try `primary` (fast, e.g. Redis) then
 * `fallback` (durable, e.g. SqlKeyValueCache); writes go to both.
 */
export function createTieredCache(primary: KeyValueCache, fallback: KeyValueCache): KeyValueCache {
  return {
    async get(key) {
      return (await primary.get(key)) ?? (await fallback.get(key));
    },
    async set(key, value, ttlSeconds) {
      await Promise.all([primary.set(key, value, ttlSeconds), fallback.set(key, value, ttlSeconds)]);
    },
    async close() {
      await Promise.all([primary.close(), fallback.close()]);
    }
  };
}
