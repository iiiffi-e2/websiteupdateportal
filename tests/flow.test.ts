import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PortalError } from "@/domain/errors";
import { login } from "@/server/auth";
import { openMemoryDatabase } from "@/server/db";
import {
  approveChange,
  cancelChange,
  claimNext,
  processDue,
  publishChange,
  readAuthorizedAttachment,
  requestRevision,
  requireWebsite,
  retryChange,
  rollbackDeployment,
  sendChange,
  setAutonomous,
  sweepTimeouts,
  websitesFor,
} from "@/server/engine";
import { readEnv } from "@/server/env";
import { initWebsiteRepo } from "@/server/git-workspace";
import { requestInstallationToken } from "@/server/providers";
import { startEngine } from "@/server/runtime";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "portal-"));
  dirs.push(dataDir);
  const env = readEnv(
    {
      NODE_ENV: "test",
      DATA_DIR: dataDir,
      AUTH_SECRET: "test-auth-secret",
      SEED_DEMO: "false",
      LOCAL_ALLOWED_REPO: "lumen-studio",
      DEPLOY_PROVIDER: "local_preview",
      JOB_GLOBAL_CONCURRENCY: "2",
    },
    "/",
  );
  const db = await openMemoryDatabase();
  const engine = await startEngine(db, env);
  await initWebsiteRepo(
    path.join(process.cwd(), "examples", "lumen-studio"),
    path.join(dataDir, "repos", "lumen-studio"),
    path.join(dataDir, "git-home"),
  );
  const adminId = crypto.randomUUID();
  const clientId = crypto.randomUUID();
  const viewerId = crypto.randomUUID();
  const rivalId = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const rivalOrgId = crypto.randomUUID();
  const websiteId = crypto.randomUUID();
  const { hashPassword } = await import("@/server/auth");
  await db.query("insert into users (id, email, name, password_hash) values ($1,$2,$3,$4)", [
    adminId,
    "admin@northwind.test",
    "Avery",
    await hashPassword("Harbor-Admin-1"),
  ]);
  await db.query("insert into users (id, email, name, password_hash) values ($1,$2,$3,$4)", [
    clientId,
    "client@northwind.test",
    "Morgan",
    await hashPassword("Harbor-Client-1"),
  ]);
  await db.query("insert into users (id, email, name, password_hash) values ($1,$2,'Viewer',$3)", [
    viewerId,
    "viewer@northwind.test",
    await hashPassword("Harbor-Viewer-1"),
  ]);
  await db.query("insert into users (id, email, name, password_hash) values ($1,$2,'Rival',$3)", [
    rivalId,
    "rival@other.test",
    await hashPassword("Harbor-Rival-11"),
  ]);
  await db.query("insert into organizations (id, name, slug) values ($1,'Northwind','northwind')", [orgId]);
  await db.query("insert into organizations (id, name, slug) values ($1,'Other','other')", [rivalOrgId]);
  for (const [userId, role, organizationId] of [
    [adminId, "owner", orgId],
    [clientId, "client", orgId],
    [viewerId, "client", orgId],
    [rivalId, "owner", rivalOrgId],
  ] as const) {
    await db.query("insert into organization_memberships (id, organization_id, user_id, role) values ($1,$2,$3,$4)", [
      crypto.randomUUID(),
      organizationId,
      userId,
      role,
    ]);
  }
  await db.query(
    "insert into websites (id, organization_id, name, slug, autonomous_enabled) values ($1,$2,'Lumen Studio','lumen',true)",
    [websiteId, orgId],
  );
  await db.query("insert into website_memberships (id, website_id, user_id, role) values ($1,$2,$3,'approver')", [
    crypto.randomUUID(),
    websiteId,
    clientId,
  ]);
  await db.query("insert into website_memberships (id, website_id, user_id, role) values ($1,$2,$3,'viewer')", [
    crypto.randomUUID(),
    websiteId,
    viewerId,
  ]);
  await db.query(
    `insert into website_provider_configs (
       id, website_id, git_provider, repository, deploy_provider, agent_provider, allowed_paths, validation_argv,
       budget_max_tokens, budget_max_runtime_seconds, max_concurrent_jobs
     ) values ($1,$2,'local_git','lumen-studio','local_preview','field_editor',$3::jsonb,'[]'::jsonb,20000,120,1)`,
    [crypto.randomUUID(), websiteId, JSON.stringify(["index.html", "styles.css"])],
  );
  return { engine, dataDir, adminId, clientId, viewerId, rivalId, orgId, websiteId };
}

async function mainHtml(dataDir: string) {
  return readFile(path.join(dataDir, "repos", "lumen-studio", "index.html"), "utf8");
}

async function statusOf(engine: Awaited<ReturnType<typeof setup>>["engine"], changeRequestId: string) {
  const rows = await engine.db.query<{ status: string; last_error: string | null }>(
    "select status, last_error from change_requests where id = $1",
    [changeRequestId],
  );
  return rows[0];
}

describe("request, preview, approve, publish, rollback", () => {
  it("changes the test website only after approval", async () => {
    const { engine, dataDir, clientId, rivalId, websiteId } = await setup();
    const sent = await sendChange(engine, {
      actorId: clientId,
      websiteId,
      body: "Change the headline to Summer Hours",
      attachment: { filename: "note.txt", contentType: "text/plain", bytes: Buffer.from("A reference note") },
    });
    await processDue(engine);
    const change = await statusOf(engine, sent.changeRequestId);
    expect(change?.status).toBe("preview_ready");
    expect(await mainHtml(dataDir)).toContain("Lumen Studio");
    expect(await mainHtml(dataDir)).not.toContain(">Summer Hours<");
    const previews = await engine.db.query<{ id: string; url: string; commit_sha: string }>(
      "select id, url, commit_sha from deployment_previews where change_request_id = $1",
      [sent.changeRequestId],
    );
    expect(previews[0]?.url).toBe(`/api/previews/${previews[0]?.id}/index.html`);
    const previewHtml = await readFile(path.join(dataDir, "previews", previews[0]!.id, "index.html"), "utf8");
    expect(previewHtml).toContain('data-field="headline">Summer Hours<');
    expect(previewHtml).toContain("HACKED");
    await expect(publishChange(engine, clientId, sent.changeRequestId)).rejects.toThrow(/approved/);
    await approveChange(engine, clientId, sent.changeRequestId);
    await expect(
      engine.db.query("update approval_records set commit_sha = 'forged'"),
    ).rejects.toThrow(/immutable/);
    await publishChange(engine, clientId, sent.changeRequestId);
    expect((await statusOf(engine, sent.changeRequestId))?.status).toBe("published");
    expect(await mainHtml(dataDir)).toContain('data-field="headline">Summer Hours<');
    const production = await readFile(path.join(dataDir, "production", websiteId, "index.html"), "utf8");
    expect(production).toContain("Summer Hours");
    const deployment = await engine.db.query<{ id: string; status: string }>(
      "select id, status from production_deployments where website_id = $1",
      [websiteId],
    );
    expect(deployment[0]?.status).toBe("published");
    await expect(requireWebsite(engine, rivalId, websiteId, "website.read")).rejects.toThrow(/Not found/);
    expect(await websitesFor(engine, rivalId)).toEqual([]);
    await expect(readAuthorizedAttachment(engine, rivalId, (
      await engine.db.query<{ id: string }>("select id from attachments limit 1")
    )[0]!.id)).rejects.toThrow(/Not found/);
  });

  it("rolls production back to the previous commit", async () => {
    const { engine, dataDir, adminId, clientId, websiteId } = await setup();
    const sent = await sendChange(engine, {
      actorId: clientId,
      websiteId,
      body: "Change the headline to Summer Hours",
    });
    await processDue(engine);
    await approveChange(engine, clientId, sent.changeRequestId);
    await publishChange(engine, clientId, sent.changeRequestId);
    const deployment = await engine.db.query<{ id: string }>(
      "select id from production_deployments where status = 'published'",
    );
    await rollbackDeployment(engine, adminId, deployment[0]!.id);
    expect(await mainHtml(dataDir)).toContain('data-field="headline">Lumen Studio<');
    const rolled = await engine.db.query<{ status: string }>("select status from production_deployments where id = $1", [
      deployment[0]!.id,
    ]);
    expect(rolled[0]?.status).toBe("rolled_back");
    await expect(engine.db.query("delete from audit_events")).rejects.toThrow(/immutable/);
  });
});

describe("guards", () => {
  it("blocks a second request, viewers, other organizations, and unpublished production edits", async () => {
    const { engine, clientId, viewerId, rivalId, websiteId } = await setup();
    const sent = await sendChange(engine, { actorId: clientId, websiteId, body: "Change the headline to Summer Hours" });
    await expect(sendChange(engine, { actorId: clientId, websiteId, body: "Change the headline to Other" })).rejects.toThrow(/in progress/);
    await expect(sendChange(engine, { actorId: viewerId, websiteId, body: "Change the headline to Other" })).rejects.toThrow(
      /does not allow|Not found|forbidden/i,
    );
    await expect(approveChange(engine, rivalId, sent.changeRequestId)).rejects.toThrow(/Not found/);
    await expect(publishChange(engine, viewerId, sent.changeRequestId)).rejects.toThrow(/Not found|does not allow|approved/i);
    const loggedIn = await login(engine.db, engine.env, "client@northwind.test", "Harbor-Client-1");
    expect(loggedIn).toBe(clientId);
    await expect(login(engine.db, engine.env, "client@northwind.test", "wrong-password")).rejects.toThrow(/incorrect/);
  });

  it("does not run while autonomous processing is disabled", async () => {
    const { engine, dataDir, adminId, clientId, websiteId } = await setup();
    await setAutonomous(engine, adminId, websiteId, false);
    const sent = await sendChange(engine, { actorId: clientId, websiteId, body: "Change the headline to Summer Hours" });
    const result = await processDue(engine);
    expect(result.claimed).toBe(0);
    expect((await statusOf(engine, sent.changeRequestId))?.status).toBe("queued");
    expect(await mainHtml(dataDir)).toContain("Lumen Studio");
  });

  it("fails closed when checks fail or production moved, and does not auto-retry a rejected request", async () => {
    const { engine, dataDir, adminId, clientId, websiteId } = await setup();
    process.env.DATABASE_URL = "postgres://user:secret-password@localhost/portal";
    await engine.db.query(
      `update website_provider_configs set validation_argv = $1::jsonb where website_id = $2`,
      [JSON.stringify(["node", "-e", "if (process.env.DATABASE_URL) process.exit(2)"]), websiteId],
    );
    const secretAttempt = await sendChange(engine, {
      actorId: clientId,
      websiteId,
      body: "Change the headline to Summer Hours",
    });
    await processDue(engine);
    expect((await statusOf(engine, secretAttempt.changeRequestId))?.status).toBe("preview_ready");
    delete process.env.DATABASE_URL;

    await cancelChange(engine, clientId, secretAttempt.changeRequestId);
    await engine.db.query(`update website_provider_configs set validation_argv = $1::jsonb where website_id = $2`, [
      JSON.stringify(["node", "-e", "process.exit(1)"]),
      websiteId,
    ]);
    const failed = await sendChange(engine, { actorId: clientId, websiteId, body: "Change the headline to Summer Hours" });
    await processDue(engine);
    expect((await statusOf(engine, failed.changeRequestId))?.status).toBe("failed");
    expect(await mainHtml(dataDir)).toContain("Lumen Studio");
    const again = await processDue(engine);
    expect(again.claimed).toBe(0);

    await engine.db.query(`update website_provider_configs set validation_argv = '[]'::jsonb where website_id = $1`, [websiteId]);
    await retryChange(engine, adminId, failed.changeRequestId);
    await processDue(engine);
    expect((await statusOf(engine, failed.changeRequestId))?.status).toBe("preview_ready");
    await approveChange(engine, clientId, failed.changeRequestId);
    const { git } = await import("@/server/process");
    const { gitEnv } = await import("@/server/process");
    const repo = path.join(dataDir, "repos", "lumen-studio");
    const env = await gitEnv(path.join(dataDir, "git-home"));
    await git(repo, ["commit", "--allow-empty", "-m", "Production moved"], env);
    await expect(publishChange(engine, clientId, failed.changeRequestId)).rejects.toThrow(/Production changed/);
    expect((await statusOf(engine, failed.changeRequestId))?.status).toBe("approved");
    expect(await mainHtml(dataDir)).not.toContain(">Summer Hours<");
  });

  it("requests a revision and keeps the old approval from publishing", async () => {
    const { engine, dataDir, clientId, websiteId } = await setup();
    const sent = await sendChange(engine, { actorId: clientId, websiteId, body: "Change the headline to Summer Hours" });
    await processDue(engine);
    await approveChange(engine, clientId, sent.changeRequestId);
    await requestRevision(engine, clientId, sent.changeRequestId, "Change the headline to Autumn Light");
    await processDue(engine);
    expect((await statusOf(engine, sent.changeRequestId))?.status).toBe("preview_ready");
    const preview = await engine.db.query<{ id: string }>(
      "select id from deployment_previews order by created_at desc limit 1",
    );
    const html = await readFile(path.join(dataDir, "previews", preview[0]!.id, "index.html"), "utf8");
    expect(html).toContain("Autumn Light");
    await expect(publishChange(engine, clientId, sent.changeRequestId)).rejects.toThrow(/approved/);
    await approveChange(engine, clientId, sent.changeRequestId);
    await publishChange(engine, clientId, sent.changeRequestId);
    expect(await mainHtml(dataDir)).toContain("Autumn Light");
  });

  it("loads an administrator view without crossing organizations", async () => {
    const { engine, adminId, rivalId } = await setup();
    const { loadAdminPage } = await import("@/server/view");
    const page = await loadAdminPage(engine, adminId);
    expect(page.websites.map((site) => site.name)).toEqual(["Lumen Studio"]);
    const rival = await loadAdminPage(engine, rivalId);
    expect(rival.websites).toEqual([]);
  });

  it("enforces global concurrency, timeouts, and the repository allowlist", async () => {
    const { engine, adminId, orgId, websiteId } = await setup();
    const secondId = await (await import("@/server/engine")).registerWebsite(engine, adminId, {
      organizationId: orgId,
      name: "Second",
      slug: "second",
      gitProvider: "local_git",
      repository: "lumen-studio",
      deployProvider: "local_preview",
      agentProvider: "field_editor",
      allowedPaths: ["index.html", "styles.css"],
      validationArgv: [],
      budgetMaxTokens: 1000,
      budgetMaxRuntimeSeconds: 30,
      maxConcurrentJobs: 1,
      autonomousEnabled: true,
    });
    engine.env.jobGlobalConcurrency = 1;
    await sendChange(engine, { actorId: adminId, websiteId, body: "Change the headline to Summer Hours" });
    await sendChange(engine, { actorId: adminId, websiteId: secondId, body: "Change the tagline to Open late" });
    const first = await claimNext(engine);
    const second = await claimNext(engine);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    await engine.db.query("update agent_jobs set timeout_at = now() - interval '1 minute' where id = $1", [first!.id]);
    await sweepTimeouts(engine);
    const retried = await engine.db.query<{ status: string }>("select status from agent_jobs where id = $1", [first!.id]);
    expect(retried[0]?.status).toBe("queued");
    const claimedAgain = await claimNext(engine);
    await engine.db.query("update agent_jobs set timeout_at = now() - interval '1 minute' where id = $1", [claimedAgain!.id]);
    await sweepTimeouts(engine);
    const exhausted = await engine.db.query<{ status: string }>("select status from agent_jobs where id = $1", [claimedAgain!.id]);
    expect(exhausted[0]?.status).toBe("failed");
    await expect(
      requestInstallationToken({ ...engine.env, githubAllowedRepo: "acme/site" }, "other/repo", (() => {
        throw new Error("should not fetch");
      }) as typeof fetch),
    ).rejects.toBeInstanceOf(PortalError);
  });
});
