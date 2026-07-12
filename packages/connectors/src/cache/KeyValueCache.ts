/**
 * Minimal cache surface the TMS decorator needs. Kept tiny so the appliance
 * can run with Redis, with an in-memory map (tests), or with nothing at all —
 * the cache is a speed-up, never a source of truth.
 */
export interface KeyValueCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  close(): Promise<void>;
}

export class InMemoryKeyValueCache implements KeyValueCache {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  async close(): Promise<void> {
    this.store.clear();
  }
}

/**
 * Connects to Redis. Any connection failure returns null so the caller falls
 * back to a pass-through (uncached) adapter instead of blocking quoting.
 */
export async function createRedisCache(url: string): Promise<KeyValueCache | null> {
  try {
    const { createClient } = await import("redis");
    const client = createClient({ url });
    client.on("error", () => {
      /* swallow: a mid-run Redis blip must not crash the appliance */
    });
    await client.connect();
    return {
      async get(key) {
        try {
          return await client.get(key);
        } catch {
          return null;
        }
      },
      async set(key, value, ttlSeconds) {
        try {
          await client.set(key, value, { EX: ttlSeconds });
        } catch {
          /* best-effort cache write */
        }
      },
      async close() {
        await client.quit().catch(() => undefined);
      }
    };
  } catch {
    return null;
  }
}
