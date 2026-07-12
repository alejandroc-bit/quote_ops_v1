import type { SqlExecutor, SqlRow } from "./SqlTmsAdapter.js";

export type SqlDialect = "postgres" | "mysql" | "mssql";

/**
 * Translates `:name` bind params to Postgres `$n` positional params. Repeated
 * `:name` reuses the same index; `::type` casts are left untouched. Values not
 * present in `params` are left as-is so a genuinely missing bind surfaces as a
 * driver error rather than a silent NULL.
 */
export function translatePgParams(
  sql: string,
  params: Record<string, unknown>
): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const indexByName = new Map<string, number>();

  // (?<!:) avoids matching the second colon of a ::cast
  const text = sql.replace(/(?<!:):([A-Za-z_][A-Za-z0-9_]*)/g, (match, name: string) => {
    if (!(name in params)) {
      return match;
    }
    let index = indexByName.get(name);
    if (index === undefined) {
      values.push(params[name]);
      index = values.length;
      indexByName.set(name, index);
    }
    return `$${index}`;
  });

  return { text, values };
}

/**
 * Translates `:name` bind params to mssql `@name` (mssql binds by name via
 * request.input). `::casts` are left untouched.
 */
export function translateMssqlParams(sql: string): string {
  return sql.replace(/(?<!:):([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => `@${name}`);
}

/**
 * Builds a live executor from a connection URL. Drivers are imported lazily so
 * a client using one dialect never pays to load the other two. Not covered by
 * unit tests (needs a real DB); the pure translators above are the tested part.
 */
export async function createSqlExecutor(
  dialect: SqlDialect,
  connectionUrl: string
): Promise<SqlExecutor> {
  if (dialect === "postgres") {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: connectionUrl });
    return {
      async query(sql, params) {
        const { text, values } = translatePgParams(sql, params);
        const result = await pool.query(text, values);
        return result.rows as SqlRow[];
      },
      async close() {
        await pool.end();
      }
    };
  }

  if (dialect === "mysql") {
    const mysql = await import("mysql2/promise");
    const pool = mysql.createPool(connectionUrl);
    return {
      async query(sql, params) {
        // mysql2 binds :name placeholders from an object at runtime, but its
        // QueryValues type only models arrays/Buffers — hence the cast.
        const [rows] = await pool.query({ sql, namedPlaceholders: true }, params as never);
        return (Array.isArray(rows) ? rows : []) as SqlRow[];
      },
      async close() {
        await pool.end();
      }
    };
  }

  const mssql = await import("mssql");
  const pool = new mssql.ConnectionPool(connectionUrl);
  const connected = await pool.connect();
  return {
    async query(sql, params) {
      const request = connected.request();
      for (const [name, value] of Object.entries(params)) {
        request.input(name, value ?? null);
      }
      const result = await request.query(translateMssqlParams(sql));
      return (result.recordset ?? []) as unknown as SqlRow[];
    },
    async close() {
      await connected.close();
    }
  };
}
