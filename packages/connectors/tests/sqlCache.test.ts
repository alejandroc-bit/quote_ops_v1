import { describe, expect, it } from "vitest";
import {
  InMemoryKeyValueCache,
  SqlKeyValueCache,
  createSqlCacheFromEnv,
  createTieredCache,
  type SqlExecutor,
  type SqlRow
} from "../src/index";

/** In-memory Map behind the SqlExecutor interface. */
class FakeSqlExecutor implements SqlExecutor {
  readonly rows = new Map<string, { value: string; expires_at: Date | null }>();
  createCount = 0;
  closed = false;

  async query(sql: string, params: Record<string, unknown>): Promise<SqlRow[]> {
    const key = params.key as string;
    if (/CREATE TABLE/i.test(sql)) {
      this.createCount += 1;
      return [];
    }
    if (/^SELECT/i.test(sql)) {
      const row = this.rows.get(key);
      return row ? [{ value: row.value, expires_at: row.expires_at }] : [];
    }
    if (/^DELETE/i.test(sql)) {
      this.rows.delete(key);
      return [];
    }
    if (/^INSERT/i.test(sql)) {
      this.rows.set(key, {
        value: params.value as string,
        expires_at: params.expires_at as Date | null
      });
      return [];
    }
    throw new Error(`unexpected sql: ${sql}`);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

describe("SqlKeyValueCache", () => {
  it("miss → set → hit, creating the table lazily once", async () => {
    const executor = new FakeSqlExecutor();
    const cache = new SqlKeyValueCache(executor);

    expect(await cache.get("route:mty-slw")).toBeNull();
    await cache.set("route:mty-slw", JSON.stringify({ km: 87 }), 3600);
    expect(await cache.get("route:mty-slw")).toBe('{"km":87}');
    expect(executor.createCount).toBe(1);
  });

  it("returns null after ttl expiry and deletes the stale row", async () => {
    let clock = 1_000_000;
    const executor = new FakeSqlExecutor();
    const cache = new SqlKeyValueCache(executor, "postgres", () => clock);

    await cache.set("k", "v", 60);
    expect(await cache.get("k")).toBe("v");

    clock += 61_000;
    expect(await cache.get("k")).toBeNull();
    expect(executor.rows.has("k")).toBe(false);
  });

  it("entries set without ttl never expire", async () => {
    let clock = 0;
    const cache = new SqlKeyValueCache(new FakeSqlExecutor(), "postgres", () => clock);
    await cache.set("k", "v");
    clock += 10 * 365 * 24 * 3600 * 1000;
    expect(await cache.get("k")).toBe("v");
  });

  it("del removes the entry", async () => {
    const cache = new SqlKeyValueCache(new FakeSqlExecutor());
    await cache.set("k", "v", 60);
    await cache.del("k");
    expect(await cache.get("k")).toBeNull();
  });

  it("degrades to a no-op cache when the executor fails", async () => {
    const broken: SqlExecutor = {
      async query() {
        throw new Error("db down");
      },
      async close() {}
    };
    const cache = new SqlKeyValueCache(broken);
    await cache.set("k", "v", 60);
    expect(await cache.get("k")).toBeNull();
  });

  it("close closes the executor", async () => {
    const executor = new FakeSqlExecutor();
    await new SqlKeyValueCache(executor).close();
    expect(executor.closed).toBe(true);
  });
});

describe("createSqlCacheFromEnv", () => {
  it("returns null when nothing is configured", async () => {
    expect(await createSqlCacheFromEnv({})).toBeNull();
  });

  it("returns null for an unknown dialect", async () => {
    expect(
      await createSqlCacheFromEnv({
        QUOTEOPS_CACHE_DB_URL: "oracle://x",
        QUOTEOPS_CACHE_DB_DIALECT: "oracle"
      })
    ).toBeNull();
  });

  it("falls back to DATABASE_URL as postgres", async () => {
    const cache = await createSqlCacheFromEnv({
      DATABASE_URL: "postgres://user:pass@localhost:5432/appliance"
    });
    expect(cache).toBeInstanceOf(SqlKeyValueCache);
    await cache?.close(); // pg Pool is lazy: no connection was opened
  });
});

describe("createTieredCache", () => {
  it("reads primary first, falls back on miss, writes both", async () => {
    const primary = new InMemoryKeyValueCache();
    const sqlExecutor = new FakeSqlExecutor();
    const fallback = new SqlKeyValueCache(sqlExecutor);
    const tiered = createTieredCache(primary, fallback);

    await tiered.set("k", "v", 60);
    expect(await primary.get("k")).toBe("v");
    expect(sqlExecutor.rows.get("k")?.value).toBe("v");

    // simulate restart: fast tier wiped, durable tier still answers
    await primary.close();
    expect(await tiered.get("k")).toBe("v");
  });
});
