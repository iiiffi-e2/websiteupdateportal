import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Db } from "@/server/db";

export async function migrate(db: Db, migrationsDir?: string): Promise<void> {
  const dir = migrationsDir ?? path.join(/*turbopackIgnore: true*/ process.cwd(), "supabase", "migrations");
  await db.exec(`
    create table if not exists schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    );
  `);
  const files = (await readdir(/*turbopackIgnore: true*/ dir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const applied = await db.query<{ version: string }>("select version from schema_migrations where version = $1", [file]);
    if (applied.length > 0) continue;
    const sql = await readFile(path.join(/*turbopackIgnore: true*/ dir, file), "utf8");
    await db.exec(sql);
    await db.query("insert into schema_migrations (version) values ($1)", [file]);
  }
}
