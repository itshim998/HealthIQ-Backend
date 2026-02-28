import { Pool, PoolConfig, QueryResult } from "pg";

// HealthIQ v2 — Database Connection Manager
// Single pool instance shared across the application.

let pool: Pool | undefined;

export function getDatabasePool(): Pool {
  if (!pool) {
    const config: PoolConfig = {
      connectionString: process.env.DATABASE_URL,
      max: parseInt(process.env.DB_POOL_MAX || "20", 10),
      idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || "30000", 10),
      connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT || "5000", 10),
      ssl: process.env.DB_SSL === "false"
        ? false
        : { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false" },
    };

    pool = new Pool(config);

    pool.on("error", (err: Error) => {
      console.error("[HealthIQ DB] Unexpected error on idle client:", err.message);
    });

    console.log("[HealthIQ DB] Connection pool created");
  }
  return pool;
}

export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  const p = getDatabasePool();
  const start = Date.now();
  const result = await p.query<T>(text, params);
  const duration = Date.now() - start;

  if (duration > 1000) {
    console.warn(`[HealthIQ DB] Slow query (${duration}ms):`, text.substring(0, 100));
  }

  return result;
}

export async function withTransaction<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const p = getDatabasePool();
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function closeDatabasePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    console.log("[HealthIQ DB] Connection pool closed");
  }
}
