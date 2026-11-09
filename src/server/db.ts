import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";
import type { Env } from "@/server/env";

export type Row = Record<string, unknown>;

export interface Db {
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  exec?: (sql: string) => Promise<unknown>;
};

export function wrapPglite(client: PGlite): Db {
  return wrap(client, false, async (fn) => client.transaction(async (tx) => fn(tx)));
}

export function wrapPostgres(sql: postgres.Sql): Db {
  return wrap(
    {
      query: async (text, params = []) => {
        const rows = await sql.unsafe(text, params as never[]);
        return { rows: Array.from(rows) };
      },
      exec: async (text) => {
        await sql.unsafe(text);
      },
    },
    false,
    async (fn) => sql.begin(async (tx) => fn({
      query: async (text, params = []) => {
        const rows = await tx.unsafe(text, params as never[]);
        return { rows: Array.from(rows) };
      },
      exec: async (text) => {
        await tx.unsafe(text);
      },
    })),
  );
}

function wrap(
  client: Queryable,
  inTransaction: boolean,
  begin: (fn: (tx: Queryable) => Promise<unknown>) => Promise<unknown>,
): Db {
  const db: Db = {
    async query(sql, params = []) {
      const result = await client.query(sql, params);
      return result.rows as never[];
    },
    async exec(sql) {
      if (!client.exec) throw new Error("This connection cannot run scripts.");
      await client.exec(sql);
    },
    async transaction(fn) {
      if (inTransaction) return fn(db);
      const result = await begin(async (tx) => fn(wrap(tx, true, begin)));
      return result as never;
    },
  };
  return db;
}

export async function openDatabase(env: Env): Promise<Db> {
  if (env.databaseUrl) {
    const sql = postgres(env.databaseUrl, { max: 10, idle_timeout: 20 });
    return wrapPostgres(sql);
  }
  const client = new PGlite(env.dataDir ? `${env.dataDir}/pglite` : undefined);
  await client.waitReady;
  return wrapPglite(client);
}

export async function openMemoryDatabase(): Promise<Db> {
  const client = new PGlite();
  await client.waitReady;
  return wrapPglite(client);
}
