import { mkdir } from "node:fs/promises";
import path from "node:path";
import { hashPassword } from "@/server/auth";
import { openDatabase, type Db } from "@/server/db";
import { createEngine, type Engine } from "@/server/engine";
import { readEnv, type Env } from "@/server/env";
import { initWebsiteRepo } from "@/server/git-workspace";
import { migrate } from "@/server/migrate";

const globalRuntime = globalThis as { __portalRuntime?: Promise<Engine> };

export function getEngine(): Promise<Engine> {
  globalRuntime.__portalRuntime ??= boot();
  return globalRuntime.__portalRuntime;
}

async function boot(): Promise<Engine> {
  const env = readEnv();
  await mkdir(env.dataDir, { recursive: true });
  const db = await openDatabase(env);
  return startEngine(db, env);
}

export async function startEngine(db: Db, env: Env): Promise<Engine> {
  await mkdir(env.dataDir, { recursive: true });
  await migrate(db);
  const engine = createEngine(db, env);
  await bootstrapAdmin(engine);
  if (env.seedDemo) await seedDemo(engine);
  return engine;
}

async function bootstrapAdmin(engine: Engine): Promise<void> {
  if (!engine.env.bootstrapAdminEmail || !engine.env.bootstrapAdminPassword) return;
  const existing = await engine.db.query("select id from users limit 1");
  if (existing.length > 0) return;
  const userId = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  await engine.db.query("insert into users (id, email, name, password_hash) values ($1,$2,$3,$4)", [
    userId,
    engine.env.bootstrapAdminEmail.toLowerCase(),
    "Administrator",
    await hashPassword(engine.env.bootstrapAdminPassword),
  ]);
  await engine.db.query("insert into organizations (id, name, slug) values ($1,$2,'agency')", [
    orgId,
    engine.env.bootstrapOrgName,
  ]);
  await engine.db.query(
    "insert into organization_memberships (id, organization_id, user_id, role) values ($1,$2,$3,'owner')",
    [crypto.randomUUID(), orgId, userId],
  );
}

export async function seedDemo(engine: Engine): Promise<void> {
  const existing = await engine.db.query("select id from organizations where slug = 'northwind'");
  if (existing.length > 0) return;
  const repo = path.join(engine.env.dataDir, "repos", engine.env.localAllowedRepo);
  await initWebsiteRepo(
    path.join(/*turbopackIgnore: true*/ process.cwd(), "examples", "lumen-studio"),
    repo,
    path.join(engine.env.dataDir, "git-home"),
  );
  const adminId = crypto.randomUUID();
  const clientId = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const websiteId = crypto.randomUUID();
  const adminHash = await hashPassword("Harbor-Admin-1");
  const clientHash = await hashPassword("Harbor-Client-1");
  await engine.db.query("insert into users (id, email, name, password_hash) values ($1,$2,$3,$4)", [
    adminId,
    "admin@northwind.test",
    "Avery Quinn",
    adminHash,
  ]);
  await engine.db.query("insert into users (id, email, name, password_hash) values ($1,$2,$3,$4)", [
    clientId,
    "client@northwind.test",
    "Morgan Lee",
    clientHash,
  ]);
  await engine.db.query("insert into organizations (id, name, slug) values ($1,'Northwind Clients','northwind')", [orgId]);
  await engine.db.query(
    "insert into organization_memberships (id, organization_id, user_id, role) values ($1,$2,$3,'owner')",
    [crypto.randomUUID(), orgId, adminId],
  );
  await engine.db.query(
    "insert into organization_memberships (id, organization_id, user_id, role) values ($1,$2,$3,'client')",
    [crypto.randomUUID(), orgId, clientId],
  );
  await engine.db.query(
    "insert into websites (id, organization_id, name, slug, autonomous_enabled, production_branch) values ($1,$2,'Lumen Studio','lumen',true,'main')",
    [websiteId, orgId],
  );
  await engine.db.query(
    "insert into website_memberships (id, website_id, user_id, role) values ($1,$2,$3,'approver')",
    [crypto.randomUUID(), websiteId, clientId],
  );
  await engine.db.query(
    `insert into website_provider_configs (
       id, website_id, git_provider, repository, deploy_provider, agent_provider, allowed_paths, validation_argv,
       budget_max_tokens, budget_max_runtime_seconds, max_concurrent_jobs
     ) values ($1,$2,'local_git',$3,$4,'field_editor',$5::jsonb,'[]'::jsonb,20000,120,1)`,
    [crypto.randomUUID(), websiteId, engine.env.localAllowedRepo, engine.env.deployProvider, JSON.stringify(["index.html", "styles.css"])],
  );
}
