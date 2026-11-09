import { readFile } from "node:fs/promises";
import path from "node:path";
import { decideAccess, type Action, type OrgRole, type WebsiteRole } from "@/domain/access";
import { PortalError, asPortalError } from "@/domain/errors";
import { evaluatePublish } from "@/domain/publish";
import { containsSecret, knownSecretValues, redactSecrets } from "@/domain/safety";
import { assertTransition, isChangeStatus, type ChangeStatus } from "@/domain/status";
import { hashPassword } from "@/server/auth";
import type { Db } from "@/server/db";
import type { Env } from "@/server/env";
import { snapshotTree } from "@/server/files";
import { getBytes, putBytes } from "@/server/storage";
import { LocalGitWorkspace } from "@/server/git-workspace";
import {
  assertAllowedRepository,
  createClaudeAgent,
  createVercelDeployment,
  fieldEditorAgent,
  githubAskpassEnv,
  githubHttpsRemote,
  mergeOnGitHub,
  requestInstallationToken,
  type CodingAgent,
} from "@/server/providers";
import { runCommand } from "@/server/process";

export type Engine = {
  db: Db;
  env: Env;
  agents: { field_editor: CodingAgent; claude: CodingAgent };
  workerId: string;
};

type AccessRow = {
  website_id: string;
  organization_id: string;
  name: string;
  slug: string;
  autonomous_enabled: boolean;
  production_branch: string;
  org_role: OrgRole | null;
  website_role: WebsiteRole | null;
};

type JobRow = {
  id: string;
  organization_id: string;
  website_id: string;
  change_request_id: string;
  revision_id: string;
  status: string;
  attempt: number;
  max_attempts: number;
  token_budget: number;
  tokens_used: number;
  runtime_budget_seconds: number;
  checkpoint: unknown;
  log: string;
};

type Checkpoint = {
  workdir?: string;
  baseSha?: string;
  summary?: string;
  edited?: boolean;
  validated?: boolean;
  commitSha?: string;
  diff?: string;
  previewId?: string;
  previewUrl?: string;
};

export function createEngine(db: Db, env: Env): Engine {
  return {
    db,
    env,
    workerId: `portal-${process.pid}`,
    agents: {
      field_editor: fieldEditorAgent,
      claude: createClaudeAgent(env),
    },
  };
}

export async function requireWebsite(engine: Engine, userId: string, websiteId: string, action: Action): Promise<AccessRow> {
  const rows = await engine.db.query<AccessRow>(
    `select w.id as website_id, w.organization_id, w.name, w.slug, w.autonomous_enabled, w.production_branch,
            m.role as org_role, wm.role as website_role
     from websites w
     left join organization_memberships m on m.organization_id = w.organization_id and m.user_id = $2
     left join website_memberships wm on wm.website_id = w.id and wm.user_id = $2
     where w.id = $1`,
    [websiteId, userId],
  );
  const row = rows[0];
  if (!row?.org_role) throw new PortalError("not_found", "Not found.");
  const decision = decideAccess({
    orgRole: row.org_role,
    websiteRole: row.website_role,
    action,
  });
  if (!decision.allowed) {
    if (!row.website_role && row.org_role !== "owner" && row.org_role !== "admin") {
      throw new PortalError("not_found", "Not found.");
    }
    throw new PortalError("forbidden", decision.reason);
  }
  return row;
}

export async function sendChange(
  engine: Engine,
  input: {
    actorId: string;
    websiteId: string;
    conversationId?: string;
    body: string;
    attachment?: { filename: string; contentType: string; bytes: Buffer } | null;
  },
): Promise<{ changeRequestId: string; conversationId: string; jobId: string }> {
  const body = input.body.trim();
  if (body.length < 1 || body.length > 4000) {
    throw new PortalError("invalid_request", "Describe the change in 4000 characters or fewer.");
  }
  const website = await requireWebsite(engine, input.actorId, input.websiteId, "website.request");
  const active = await engine.db.query<{ id: string }>(
    `select id from change_requests
     where website_id = $1 and status in ('draft','queued','running','testing','preview_ready','revision_requested','approved','publishing')
     limit 1`,
    [website.website_id],
  );
  if (active.length > 0) {
    throw new PortalError("busy", "This website already has a change in progress. Finish or cancel it first.");
  }
  const conversationId = await ensureConversation(engine, website, input.actorId, input.conversationId, body);
  const messageId = crypto.randomUUID();
  const changeRequestId = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const config = await loadConfig(engine, website.website_id);
  await engine.db.transaction(async (tx) => {
    await tx.query(
      `insert into messages (id, conversation_id, organization_id, author_user_id, role, body)
       values ($1,$2,$3,$4,'user',$5)`,
      [messageId, conversationId, website.organization_id, input.actorId, body],
    );
    if (input.attachment) {
      await storeAttachment(engine, tx, {
        messageId,
        organizationId: website.organization_id,
        attachment: input.attachment,
      });
    }
    await tx.query(
      `insert into change_requests (id, organization_id, website_id, conversation_id, created_by, title, status)
       values ($1,$2,$3,$4,$5,$6,'queued')`,
      [changeRequestId, website.organization_id, website.website_id, conversationId, input.actorId, body.slice(0, 80)],
    );
    await tx.query(
      `insert into change_revisions (id, change_request_id, organization_id, revision_number, branch_name)
       values ($1,$2,$3,1,$4)`,
      [revisionId, changeRequestId, website.organization_id, branchName(changeRequestId, 1)],
    );
    await tx.query(
      `insert into agent_jobs (
         id, organization_id, website_id, change_request_id, revision_id, status, token_budget, runtime_budget_seconds
       ) values ($1,$2,$3,$4,$5,'queued',$6,$7)`,
      [jobId, website.organization_id, website.website_id, changeRequestId, revisionId, config.budget_max_tokens, config.budget_max_runtime_seconds],
    );
  });
  await audit(engine, {
    organizationId: website.organization_id,
    websiteId: website.website_id,
    actorUserId: input.actorId,
    action: "change.queued",
    entityType: "change_request",
    entityId: changeRequestId,
    metadata: { jobId },
  });
  await addAssistant(engine, conversationId, website.organization_id, "Request queued.");
  return { changeRequestId, conversationId, jobId };
}

export async function approveChange(engine: Engine, actorId: string, changeRequestId: string): Promise<void> {
  const change = await mustChange(engine, changeRequestId);
  await requireWebsite(engine, actorId, change.website_id, "website.approve");
  if (change.status !== "preview_ready") {
    throw new PortalError("invalid_transition", "Only a ready preview can be approved.");
  }
  const revision = await latestRevision(engine, changeRequestId);
  const preview = await previewForRevision(engine, revision.id);
  if (!revision.commit_sha || revision.validation_status !== "passed" || !preview || preview.status !== "ready") {
    throw new PortalError("checks_failed", "Required checks have not passed for this preview.");
  }
  const approvalId = crypto.randomUUID();
  await engine.db.query(
    `insert into approval_records (
       id, organization_id, website_id, change_request_id, revision_id, commit_sha, deployment_id, approved_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [approvalId, change.organization_id, change.website_id, change.id, revision.id, revision.commit_sha, preview.id, actorId],
  );
  await transition(engine, change.id, "approved", null);
  await audit(engine, {
    organizationId: change.organization_id,
    websiteId: change.website_id,
    actorUserId: actorId,
    action: "change.approved",
    entityType: "approval_record",
    entityId: approvalId,
    metadata: {
      changeRequestId: change.id,
      revisionId: revision.id,
      commitSha: revision.commit_sha,
      deploymentId: preview.id,
    },
  });
  await addAssistant(engine, change.conversation_id, change.organization_id, "Approved. Publish when you want this exact preview to go live.");
}

export async function requestRevision(engine: Engine, actorId: string, changeRequestId: string, note: string): Promise<void> {
  const body = note.trim();
  if (body.length < 1 || body.length > 4000) {
    throw new PortalError("invalid_request", "Describe the revision in 4000 characters or fewer.");
  }
  const change = await mustChange(engine, changeRequestId);
  await requireWebsite(engine, actorId, change.website_id, "website.request");
  if (change.status !== "preview_ready" && change.status !== "approved") {
    throw new PortalError("invalid_transition", "A revision can be requested from a preview or an approval that has not been published.");
  }
  if (change.status === "approved") {
    const approvals = await engine.db.query<{ id: string }>(
      `select a.id from approval_records a
       left join approval_revocations r on r.approval_id = a.id
       where a.change_request_id = $1 and r.id is null
       order by a.approved_at desc limit 1`,
      [change.id],
    );
    if (approvals[0]) {
      await engine.db.query(
        `insert into approval_revocations (id, approval_id, revoked_by, reason) values ($1,$2,$3,$4)`,
        [crypto.randomUUID(), approvals[0].id, actorId, body.slice(0, 500)],
      );
    }
  }
  await transition(engine, change.id, "revision_requested", null);
  const previous = await latestRevision(engine, change.id);
  const revisionId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const config = await loadConfig(engine, change.website_id);
  const revisionNumber = previous.revision_number + 1;
  await engine.db.query(
    `insert into messages (id, conversation_id, organization_id, author_user_id, role, body) values ($1,$2,$3,$4,'user',$5)`,
    [crypto.randomUUID(), change.conversation_id, change.organization_id, actorId, body],
  );
  await engine.db.query(
    `insert into change_revisions (id, change_request_id, organization_id, revision_number, branch_name)
     values ($1,$2,$3,$4,$5)`,
    [revisionId, change.id, change.organization_id, revisionNumber, branchName(change.id, revisionNumber)],
  );
  await engine.db.query(
    `insert into agent_jobs (
       id, organization_id, website_id, change_request_id, revision_id, status, token_budget, runtime_budget_seconds
     ) values ($1,$2,$3,$4,$5,'queued',$6,$7)`,
    [jobId, change.organization_id, change.website_id, change.id, revisionId, config.budget_max_tokens, config.budget_max_runtime_seconds],
  );
  await transition(engine, change.id, "queued", null);
  await audit(engine, {
    organizationId: change.organization_id,
    websiteId: change.website_id,
    actorUserId: actorId,
    action: "change.revision_requested",
    entityType: "change_request",
    entityId: change.id,
    metadata: { revisionId },
  });
}

export async function publishChange(engine: Engine, actorId: string, changeRequestId: string): Promise<void> {
  const change = await mustChange(engine, changeRequestId);
  await requireWebsite(engine, actorId, change.website_id, "website.publish");
  const revision = await latestRevision(engine, change.id);
  const preview = await previewForRevision(engine, revision.id);
  const approval = await currentApproval(engine, change.id);
  const config = await loadConfig(engine, change.website_id);
  const workspace = workspaceFor(engine, config);
  const productionSha = await workspace.productionSha();
  const branchTipSha = revision.branch_name ? await workspace.branchTip(revision.branch_name) : "";
  const decision = evaluatePublish({
    changeStatus: change.status as ChangeStatus,
    approval: approval
      ? {
          revisionId: approval.revision_id,
          commitSha: approval.commit_sha,
          deploymentId: approval.deployment_id,
          revoked: approval.revoked,
        }
      : null,
    revision: {
      id: revision.id,
      commitSha: revision.commit_sha,
      validationStatus: revision.validation_status,
    },
    preview: preview
      ? { id: preview.id, commitSha: preview.commit_sha, status: preview.status, url: preview.url }
      : null,
    productionSha,
    baseSha: revision.base_sha ?? "",
    branchTipSha,
  });
  if (!decision.ok) throw new PortalError(decision.code, decision.message);
  await transition(engine, change.id, "publishing", null);
  const deploymentId = crypto.randomUUID();
  await engine.db.query(
    `insert into production_deployments (
       id, organization_id, website_id, change_request_id, revision_id, approval_id, provider, previous_sha, status
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,'publishing')`,
    [
      deploymentId,
      change.organization_id,
      change.website_id,
      change.id,
      revision.id,
      approval!.id,
      config.deploy_provider,
      productionSha,
    ],
  );
  try {
    let providerId = "";
    let url = "";
    let gitSha = revision.commit_sha!;
    if (config.deploy_provider === "vercel") {
      const promoted = await createVercelDeployment({
        env: engine.env,
        projectId: config.vercel_project_id ?? "",
        teamId: config.vercel_team_id,
        repository: config.repository,
        ref: revision.commit_sha!,
        target: "production",
      });
      providerId = promoted.externalId;
      url = promoted.url;
    }
    if (config.git_provider === "github_app") {
      const token = await requestInstallationToken(engine.env, config.repository);
      gitSha = await mergeOnGitHub({
        env: engine.env,
        repository: config.repository,
        productionBranch: config.production_branch,
        approvedSha: revision.commit_sha!,
        token,
      });
    } else {
      const merged = await workspace.merge(revision.branch_name, revision.commit_sha!, revision.base_sha!);
      gitSha = merged.sha;
      await snapshotTree(workspace.repoPath, productionDir(engine, change.website_id));
      url = url || `/api/production/${change.website_id}/index.html`;
    }
    await engine.db.query(
      `update production_deployments
       set status = 'published', commit_sha = $2, external_id = $3, url = $4, finished_at = now()
       where id = $1`,
      [deploymentId, gitSha, providerId || gitSha, url],
    );
    await transition(engine, change.id, "published", null);
    await audit(engine, {
      organizationId: change.organization_id,
      websiteId: change.website_id,
      actorUserId: actorId,
      action: "change.published",
      entityType: "production_deployment",
      entityId: deploymentId,
      metadata: { commitSha: gitSha, approvedSha: revision.commit_sha, providerId, approvalId: approval!.id },
    });
    await addAssistant(
      engine,
      change.conversation_id,
      change.organization_id,
      `Published ${revision.commit_sha!.slice(0, 7)}.`,
    );
    await workspace.removeWorktree(path.join(engine.env.dataDir, "worktrees", revision.id)).catch(() => undefined);
  } catch (error) {
    const portal = asPortalError(error);
    const message = redactSecrets(portal.message, knownSecretValues());
    await engine.db.query(
      `update production_deployments set status = 'failed', error = $2, finished_at = now() where id = $1`,
      [deploymentId, message],
    );
    await transition(engine, change.id, "approved", message);
    throw new PortalError(portal.code, message, { retryable: portal.retryable });
  }
}

export async function rollbackDeployment(engine: Engine, actorId: string, deploymentId: string): Promise<void> {
  const rows = await engine.db.query<{
    id: string;
    organization_id: string;
    website_id: string;
    status: string;
    commit_sha: string | null;
    previous_sha: string | null;
  }>("select id, organization_id, website_id, status, commit_sha, previous_sha from production_deployments where id = $1", [
    deploymentId,
  ]);
  const deployment = rows[0];
  if (!deployment) throw new PortalError("not_found", "Not found.");
  await requireWebsite(engine, actorId, deployment.website_id, "website.rollback");
  if (deployment.status !== "published" || !deployment.previous_sha || !deployment.commit_sha) {
    throw new PortalError("rollback_rejected", "Only the published deployment can be rolled back, and only when the previous commit is known.");
  }
  const config = await loadConfig(engine, deployment.website_id);
  const workspace = workspaceFor(engine, config);
  const productionSha = await workspace.productionSha();
  if (productionSha !== deployment.commit_sha && config.git_provider === "local_git") {
    throw new PortalError("rollback_rejected", "Production is no longer at this deployment.");
  }
  const restored = await workspace.rollback(deployment.previous_sha);
  await snapshotTree(workspace.repoPath, productionDir(engine, deployment.website_id));
  await engine.db.query(
    `update production_deployments set status = 'rolled_back', finished_at = now() where id = $1`,
    [deployment.id],
  );
  await audit(engine, {
    organizationId: deployment.organization_id,
    websiteId: deployment.website_id,
    actorUserId: actorId,
    action: "deployment.rolled_back",
    entityType: "production_deployment",
    entityId: deployment.id,
    metadata: { restoredSha: restored.sha, previousSha: deployment.previous_sha },
  });
}

export async function cancelChange(engine: Engine, actorId: string, changeRequestId: string): Promise<void> {
  const change = await mustChange(engine, changeRequestId);
  await requireWebsite(engine, actorId, change.website_id, "website.request");
  if (!isChangeStatus(change.status) || !["draft", "queued", "preview_ready", "revision_requested", "approved", "failed"].includes(change.status)) {
    throw new PortalError("invalid_transition", "This change can no longer be canceled.");
  }
  await transition(engine, change.id, "canceled", null);
  await engine.db.query(
    `update agent_jobs set status = 'canceled', finished_at = now() where change_request_id = $1 and status = 'queued'`,
    [change.id],
  );
  await audit(engine, {
    organizationId: change.organization_id,
    websiteId: change.website_id,
    actorUserId: actorId,
    action: "change.canceled",
    entityType: "change_request",
    entityId: change.id,
    metadata: {},
  });
}

export async function retryChange(engine: Engine, actorId: string, changeRequestId: string): Promise<void> {
  const change = await mustChange(engine, changeRequestId);
  await requireWebsite(engine, actorId, change.website_id, "website.admin");
  if (change.status !== "failed") {
    throw new PortalError("invalid_transition", "Only a failed change can be retried.");
  }
  await transition(engine, change.id, "queued", null);
  await engine.db.query(
    `update agent_jobs
     set status = 'queued', error = null, locked_at = null, locked_by = null, timeout_at = null, finished_at = null,
         max_attempts = attempt + 1
     where id = (
       select id from agent_jobs where change_request_id = $1 order by created_at desc limit 1
     )`,
    [change.id],
  );
  await audit(engine, {
    organizationId: change.organization_id,
    websiteId: change.website_id,
    actorUserId: actorId,
    action: "change.retried",
    entityType: "change_request",
    entityId: change.id,
    metadata: {},
  });
}

export async function claimNext(engine: Engine): Promise<JobRow | null> {
  return engine.db.transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(842016)");
    const rows = await tx.query<{ id: string }>(
      `select j.id
       from agent_jobs j
       join websites w on w.id = j.website_id
       join website_provider_configs c on c.website_id = w.id
       where j.status = 'queued'
         and w.autonomous_enabled = true
         and (
           select count(*) from agent_jobs r
           where r.website_id = j.website_id and r.status = 'running'
         ) < c.max_concurrent_jobs
         and (
           select count(*) from agent_jobs r where r.status = 'running'
         ) < $1
       order by j.created_at
       for update of j skip locked
       limit 1`,
      [engine.env.jobGlobalConcurrency],
    );
    if (!rows[0]) return null;
    const updated = await tx.query<JobRow>(
      `update agent_jobs
       set status = 'running',
           attempt = attempt + 1,
           locked_at = now(),
           locked_by = $2,
           started_at = coalesce(started_at, now()),
           timeout_at = now() + make_interval(secs => runtime_budget_seconds)
       where id = $1 and status = 'queued'
       returning id, organization_id, website_id, change_request_id, revision_id, status, attempt, max_attempts,
                 token_budget, tokens_used, runtime_budget_seconds, checkpoint, log`,
      [rows[0].id, engine.workerId],
    );
    return updated[0] ?? null;
  });
}

export async function sweepTimeouts(engine: Engine): Promise<void> {
  const rows = await engine.db.query<{ id: string; attempt: number; max_attempts: number; change_request_id: string }>(
    `select id, attempt, max_attempts, change_request_id
     from agent_jobs
     where status = 'running' and timeout_at is not null and timeout_at < now()`,
  );
  for (const job of rows) {
    const retry = job.attempt < job.max_attempts;
    if (retry) {
      await engine.db.query(
        `update agent_jobs
         set status = 'queued', locked_at = null, locked_by = null, timeout_at = null, error = $2
         where id = $1 and status = 'running'`,
        [job.id, "The job exceeded its runtime budget and was queued again."],
      );
      const change = await mustChange(engine, job.change_request_id);
      if (change.status === "running" || change.status === "testing") {
        await transition(engine, change.id, "queued", "Timed out. The job was queued again.");
      }
    } else {
      await engine.db.query(
        `update agent_jobs set status = 'failed', finished_at = now(), error = $2 where id = $1 and status = 'running'`,
        [job.id, "The job exceeded its runtime budget."],
      );
      const change = await mustChange(engine, job.change_request_id);
      if (change.status === "running" || change.status === "testing" || change.status === "queued") {
        await transition(engine, change.id, "failed", "The job exceeded its runtime budget.");
        await addAssistant(engine, change.conversation_id, change.organization_id, "The job exceeded its runtime budget.");
      }
    }
  }
}

export async function processDue(engine: Engine): Promise<{ claimed: number }> {
  await sweepTimeouts(engine);
  let claimed = 0;
  for (;;) {
    const job = await claimNext(engine);
    if (!job) break;
    claimed += 1;
    try {
      await executeJob(engine, job.id);
    } catch (error) {
      await failRunningJob(engine, job.id, error);
    }
  }
  return { claimed };
}

export async function executeJob(engine: Engine, jobId: string): Promise<void> {
  const job = await mustJob(engine, jobId);
  const change = await mustChange(engine, job.change_request_id);
  const revision = await revisionById(engine, job.revision_id);
  const config = await loadConfig(engine, job.website_id);
  const secrets = knownSecretValues();
  let checkpoint = jsonObject<Checkpoint>(job.checkpoint);
  try {
    assertProvider(engine, config);
    if (config.git_provider === "github_app") {
      await ensureGithubMirror(engine, config.repository, config.production_branch);
    }
    const workspace = workspaceFor(engine, config);
    if (change.status === "queued") await transition(engine, change.id, "running", null);
    await ensureTime(engine, job.id);
    if (!checkpoint.baseSha) {
      const prepared = await workspace.prepare(revision.branch_name, path.join(engine.env.dataDir, "worktrees", revision.id));
      checkpoint = { ...checkpoint, workdir: prepared.workdir, baseSha: prepared.baseSha };
      await engine.db.query(
        `update change_revisions set base_sha = $2 where id = $1 and base_sha is null`,
        [revision.id, prepared.baseSha],
      );
      await saveCheckpoint(engine, job.id, checkpoint, 0);
      await appendLog(engine, job.id, "Created an isolated branch.", secrets);
    }
    const workdir = checkpoint.workdir ?? path.join(engine.env.dataDir, "worktrees", revision.id);
    const allow = stringArray(config.allowed_paths);
    if (!checkpoint.edited) {
      await ensureTime(engine, job.id);
      const request = await latestUserMessage(engine, change.conversation_id);
      const files = await workspace.read(workdir, allow);
      const attachmentText = await latestAttachmentText(engine, change.conversation_id);
      const agent = engine.agents[config.agent_provider];
      const edited = await agent.edit({
        request,
        files,
        allow,
        tokenBudget: job.token_budget,
        attachmentText,
      });
      if (edited.tokensUsed > job.token_budget) {
        throw new PortalError("budget_exceeded", "The edit exceeded the token budget. Nothing was committed.");
      }
      for (const content of Object.values(edited.files)) {
        if (containsSecret(content, secrets)) {
          throw new PortalError("checks_failed", "Validation failed because the change included a portal secret. Nothing was committed.");
        }
      }
      await workspace.write(workdir, edited.files);
      checkpoint = { ...checkpoint, edited: true, summary: edited.summary };
      await saveCheckpoint(engine, job.id, checkpoint, edited.tokensUsed);
      await appendLog(engine, job.id, edited.summary, secrets);
    }
    const fresh = await mustChange(engine, change.id);
    if (fresh.status === "running") await transition(engine, change.id, "testing", null);
    if (!checkpoint.validated) {
      await ensureTime(engine, job.id);
      const htmlPath = path.join(workdir, "index.html");
      const html = await readFile(htmlPath, "utf8");
      if (!html.includes("<html") || !html.includes('data-field="headline"')) {
        throw new PortalError("checks_failed", "Validation failed because index.html is no longer a usable page.");
      }
      const command = await workspace.validateCommand(workdir, stringArray(config.validation_argv));
      const log = redactSecrets(command.log, secrets).slice(0, 4000);
      if (command.code !== 0) {
        await engine.db.query(
          `update change_revisions set validation_status = 'failed', validation_log = $2 where id = $1`,
          [revision.id, log],
        );
        throw new PortalError("checks_failed", "Validation failed. Nothing was committed.");
      }
      checkpoint = { ...checkpoint, validated: true };
      await saveCheckpoint(engine, job.id, checkpoint, 0);
    }
    if (!checkpoint.commitSha) {
      await ensureTime(engine, job.id);
      const summary = checkpoint.summary ?? "Updated the allowlisted website files.";
      const sha = await workspace.commit(workdir, summary, allow);
      const diff = redactSecrets(await workspace.diff(workdir, checkpoint.baseSha!), secrets).slice(0, 100_000);
      if (containsSecret(diff, secrets)) {
        throw new PortalError("checks_failed", "Validation failed because the diff included a portal secret.");
      }
      await engine.db.query(
        `update change_revisions
         set commit_sha = $2, summary = $3, diff_text = $4, validation_status = 'passed', validation_log = 'passed'
         where id = $1`,
        [revision.id, sha, summary, diff],
      );
      checkpoint = { ...checkpoint, commitSha: sha, diff };
      await saveCheckpoint(engine, job.id, checkpoint, 0);
      await appendLog(engine, job.id, `Committed ${sha}.`, secrets);
    }
    if (!checkpoint.previewId) {
      await ensureTime(engine, job.id);
      const previewId = crypto.randomUUID();
      let url = "";
      let externalId: string = previewId;
      if (config.deploy_provider === "vercel") {
        const deployment = await createVercelDeployment({
          env: engine.env,
          projectId: config.vercel_project_id ?? "",
          teamId: config.vercel_team_id,
          repository: config.repository,
          ref: checkpoint.commitSha!,
          target: "preview",
        });
        url = deployment.url;
        externalId = deployment.externalId;
      } else {
        await snapshotTree(workdir, path.join(engine.env.dataDir, "previews", previewId));
        url = `/api/previews/${previewId}/index.html`;
      }
      await engine.db.query(
        `insert into deployment_previews (
           id, organization_id, website_id, change_request_id, revision_id, provider, external_id, url, commit_sha, status
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ready')`,
        [
          previewId,
          change.organization_id,
          change.website_id,
          change.id,
          revision.id,
          config.deploy_provider,
          externalId,
          url,
          checkpoint.commitSha,
        ],
      );
      checkpoint = { ...checkpoint, previewId, previewUrl: url };
      await saveCheckpoint(engine, job.id, checkpoint, 0);
    }
    const beforePreview = await mustChange(engine, change.id);
    if (beforePreview.status === "testing") await transition(engine, change.id, "preview_ready", null);
    await engine.db.query(
      `update agent_jobs set status = 'succeeded', finished_at = now(), error = null where id = $1`,
      [job.id],
    );
    await addAssistant(
      engine,
      change.conversation_id,
      change.organization_id,
      `${checkpoint.summary ?? "The edit is ready."} A preview is ready for review.`,
    );
    await audit(engine, {
      organizationId: change.organization_id,
      websiteId: change.website_id,
      actorUserId: null,
      action: "change.preview_ready",
      entityType: "change_request",
      entityId: change.id,
      metadata: { commitSha: checkpoint.commitSha, previewId: checkpoint.previewId },
    });
  } catch (error) {
    await failRunningJob(engine, job.id, error);
  }
}

async function failRunningJob(engine: Engine, jobId: string, error: unknown): Promise<void> {
  const portal = asPortalError(error);
  const message = redactSecrets(portal.message, knownSecretValues()).slice(0, 1000);
  const job = await mustJob(engine, jobId);
  if (job.status !== "running") return;
  const retry = portal.retryable && job.attempt < job.max_attempts;
  const change = await mustChange(engine, job.change_request_id);
  if (retry) {
    await engine.db.query(
      `update agent_jobs set status = 'queued', locked_at = null, locked_by = null, timeout_at = null, error = $2 where id = $1`,
      [job.id, message],
    );
    if (change.status === "running" || change.status === "testing") {
      await transition(engine, change.id, "queued", message);
    }
    await appendLog(engine, job.id, `Retrying: ${message}`, knownSecretValues());
    return;
  }
  await engine.db.query(
    `update agent_jobs set status = 'failed', finished_at = now(), error = $2 where id = $1`,
    [job.id, message],
  );
  if (change.status === "queued" || change.status === "running" || change.status === "testing") {
    await transition(engine, change.id, "failed", message);
  }
  await addAssistant(engine, change.conversation_id, change.organization_id, message);
  await audit(engine, {
    organizationId: change.organization_id,
    websiteId: change.website_id,
    actorUserId: null,
    action: "change.failed",
    entityType: "agent_job",
    entityId: job.id,
    metadata: { code: portal.code },
  });
}

export async function createOrganization(engine: Engine, actorId: string, name: string, slug: string): Promise<string> {
  await assertOrgAdminSomewhere(engine, actorId);
  const id = crypto.randomUUID();
  await engine.db.query("insert into organizations (id, name, slug) values ($1,$2,$3)", [id, requireName(name), requireSlug(slug)]);
  await engine.db.query(
    "insert into organization_memberships (id, organization_id, user_id, role) values ($1,$2,$3,'owner')",
    [crypto.randomUUID(), id, actorId],
  );
  await audit(engine, {
    organizationId: id,
    websiteId: null,
    actorUserId: actorId,
    action: "organization.created",
    entityType: "organization",
    entityId: id,
    metadata: { slug },
  });
  return id;
}

export async function inviteUser(
  engine: Engine,
  actorId: string,
  input: {
    organizationId: string;
    email: string;
    name: string;
    password: string;
    orgRole: OrgRole;
    websiteId?: string;
    websiteRole?: WebsiteRole;
  },
): Promise<string> {
  await requireOrgRole(engine, actorId, input.organizationId);
  if (input.password.length < 10) throw new PortalError("invalid_request", "Passwords must be at least 10 characters.");
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new PortalError("invalid_request", "Enter a valid email address.");
  const existing = await engine.db.query<{ id: string }>("select id from users where email = $1", [email]);
  const userId = existing[0]?.id ?? crypto.randomUUID();
  if (!existing[0]) {
    await engine.db.query("insert into users (id, email, name, password_hash) values ($1,$2,$3,$4)", [
      userId,
      email,
      requireName(input.name),
      await hashPassword(input.password),
    ]);
  }
  await engine.db.query(
    `insert into organization_memberships (id, organization_id, user_id, role) values ($1,$2,$3,$4)
     on conflict (organization_id, user_id) do update set role = excluded.role`,
    [crypto.randomUUID(), input.organizationId, userId, input.orgRole],
  );
  if (input.websiteId && input.websiteRole) {
    const website = await engine.db.query<{ id: string }>(
      "select id from websites where id = $1 and organization_id = $2",
      [input.websiteId, input.organizationId],
    );
    if (!website[0]) throw new PortalError("not_found", "Not found.");
    await engine.db.query(
      `insert into website_memberships (id, website_id, user_id, role) values ($1,$2,$3,$4)
       on conflict (website_id, user_id) do update set role = excluded.role`,
      [crypto.randomUUID(), input.websiteId, userId, input.websiteRole],
    );
  }
  await audit(engine, {
    organizationId: input.organizationId,
    websiteId: input.websiteId ?? null,
    actorUserId: actorId,
    action: "user.invited",
    entityType: "user",
    entityId: userId,
    metadata: { email, orgRole: input.orgRole },
  });
  return userId;
}

export async function registerWebsite(
  engine: Engine,
  actorId: string,
  input: {
    organizationId: string;
    name: string;
    slug: string;
    gitProvider: "local_git" | "github_app";
    repository: string;
    deployProvider: "local_preview" | "vercel";
    agentProvider: "field_editor" | "claude";
    allowedPaths: string[];
    validationArgv: string[];
    vercelProjectId?: string;
    vercelTeamId?: string;
    budgetMaxTokens: number;
    budgetMaxRuntimeSeconds: number;
    maxConcurrentJobs: number;
    autonomousEnabled: boolean;
  },
): Promise<string> {
  await requireOrgRole(engine, actorId, input.organizationId);
  if (input.gitProvider === "local_git") {
    assertAllowedRepository(input.repository, engine.env.localAllowedRepo, "Local git");
  } else {
    assertAllowedRepository(input.repository, engine.env.githubAllowedRepo, "GitHub");
  }
  if (input.deployProvider !== engine.env.deployProvider) {
    throw new PortalError("deploy_rejected", `This portal deployment provider is ${engine.env.deployProvider}.`);
  }
  const websiteId = crypto.randomUUID();
  await engine.db.query(
    `insert into websites (id, organization_id, name, slug, autonomous_enabled) values ($1,$2,$3,$4,$5)`,
    [websiteId, input.organizationId, requireName(input.name), requireSlug(input.slug), input.autonomousEnabled],
  );
  await engine.db.query(
    `insert into website_provider_configs (
       id, website_id, git_provider, repository, deploy_provider, vercel_project_id, vercel_team_id,
       agent_provider, allowed_paths, validation_argv, budget_max_tokens, budget_max_runtime_seconds, max_concurrent_jobs
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13)`,
    [
      crypto.randomUUID(),
      websiteId,
      input.gitProvider,
      input.repository,
      input.deployProvider,
      input.vercelProjectId ?? null,
      input.vercelTeamId ?? null,
      input.agentProvider,
      JSON.stringify(input.allowedPaths),
      JSON.stringify(input.validationArgv),
      input.budgetMaxTokens,
      input.budgetMaxRuntimeSeconds,
      input.maxConcurrentJobs,
    ],
  );
  await audit(engine, {
    organizationId: input.organizationId,
    websiteId,
    actorUserId: actorId,
    action: "website.registered",
    entityType: "website",
    entityId: websiteId,
    metadata: { repository: input.repository, gitProvider: input.gitProvider, deployProvider: input.deployProvider },
  });
  return websiteId;
}

export async function setAutonomous(engine: Engine, actorId: string, websiteId: string, enabled: boolean): Promise<void> {
  const website = await requireWebsite(engine, actorId, websiteId, "website.admin");
  await engine.db.query("update websites set autonomous_enabled = $2 where id = $1", [websiteId, enabled]);
  await audit(engine, {
    organizationId: website.organization_id,
    websiteId,
    actorUserId: actorId,
    action: enabled ? "website.autonomous_enabled" : "website.autonomous_disabled",
    entityType: "website",
    entityId: websiteId,
    metadata: {},
  });
}

export async function readAuthorizedAttachment(engine: Engine, actorId: string, attachmentId: string): Promise<{
  filename: string;
  contentType: string;
  bytes: Buffer;
}> {
  const rows = await engine.db.query<{ organization_id: string; website_id: string; filename: string; content_type: string }>(
    `select a.organization_id, c.website_id, a.filename, a.content_type
     from attachments a
     join messages m on m.id = a.message_id
     join conversations c on c.id = m.conversation_id
     where a.id = $1`,
    [attachmentId],
  );
  const row = rows[0];
  if (!row) throw new PortalError("not_found", "Not found.");
  await requireWebsite(engine, actorId, row.website_id, "website.read");
  const bytes = await getBytes(engine.env, attachmentId);
  return { filename: row.filename, contentType: row.content_type, bytes };
}

export async function readAuthorizedPreview(
  engine: Engine,
  actorId: string,
  previewId: string,
  parts: string[],
): Promise<{ filePath: string; contentType: string }> {
  const rows = await engine.db.query<{ website_id: string }>(
    "select website_id from deployment_previews where id = $1",
    [previewId],
  );
  const row = rows[0];
  if (!row) throw new PortalError("not_found", "Not found.");
  await requireWebsite(engine, actorId, row.website_id, "website.read");
  const { contentTypeFor, resolveInside } = await import("@/server/files");
  const filePath = resolveInside(path.join(engine.env.dataDir, "previews", previewId), parts.length ? parts : ["index.html"]);
  return { filePath, contentType: contentTypeFor(filePath) };
}

export async function websitesFor(engine: Engine, userId: string): Promise<{ id: string; name: string; organization_id: string; autonomous_enabled: boolean }[]> {
  return engine.db.query(
    `select w.id, w.name, w.organization_id, w.autonomous_enabled
     from websites w
     join organization_memberships m on m.organization_id = w.organization_id and m.user_id = $1
     left join website_memberships wm on wm.website_id = w.id and wm.user_id = $1
     where m.role in ('owner', 'admin') or wm.id is not null
     order by w.name`,
    [userId],
  );
}

export async function readAuthorizedProduction(
  engine: Engine,
  actorId: string,
  websiteId: string,
  parts: string[],
): Promise<{ filePath: string; contentType: string }> {
  await requireWebsite(engine, actorId, websiteId, "website.read");
  const { contentTypeFor, resolveInside } = await import("@/server/files");
  const filePath = resolveInside(productionDir(engine, websiteId), parts.length ? parts : ["index.html"]);
  return { filePath, contentType: contentTypeFor(filePath) };
}

async function ensureGithubMirror(engine: Engine, repository: string, productionBranch: string): Promise<string> {
  const dest = path.join(engine.env.dataDir, "mirrors", repository.replace("/", "__"));
  const token = await requestInstallationToken(engine.env, repository);
  const home = path.join(engine.env.dataDir, "git-home");
  const env = await githubAskpassEnv(token, home);
  const remote = githubHttpsRemote(repository);
  const { access } = await import("node:fs/promises");
  const exists = await access(dest).then(() => true).catch(() => false);
  if (!exists) {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.dirname(dest), { recursive: true });
    const cloned = await runCommand("git", ["clone", "--branch", productionBranch, remote, dest], { env });
    if (cloned.code !== 0) {
      throw new PortalError("git_failed", "GitHub clone failed. The token was not written to the log.");
    }
  }
  return dest;
}

function workspaceFor(engine: Engine, config: ConfigRow): LocalGitWorkspace {
  const repoPath =
    config.git_provider === "local_git"
      ? path.join(engine.env.dataDir, "repos", config.repository)
      : path.join(engine.env.dataDir, "mirrors", config.repository.replace("/", "__"));
  return new LocalGitWorkspace(repoPath, config.production_branch, path.join(engine.env.dataDir, "git-home"));
}

function assertProvider(engine: Engine, config: ConfigRow): void {
  if (config.git_provider === "local_git") {
    assertAllowedRepository(config.repository, engine.env.localAllowedRepo, "Local git");
    if (!/^[a-z0-9-]+$/.test(config.repository)) {
      throw new PortalError("repo_not_allowlisted", "Local repository ids must be simple names.");
    }
  } else {
    assertAllowedRepository(config.repository, engine.env.githubAllowedRepo, "GitHub");
  }
  if (config.deploy_provider !== engine.env.deployProvider) {
    throw new PortalError(
      "deploy_rejected",
      `This portal deployment provider is ${engine.env.deployProvider}. The website is set to ${config.deploy_provider}.`,
    );
  }
}

async function ensureConversation(
  engine: Engine,
  website: AccessRow,
  actorId: string,
  conversationId: string | undefined,
  body: string,
): Promise<string> {
  if (conversationId) {
    const rows = await engine.db.query<{ id: string }>(
      "select id from conversations where id = $1 and website_id = $2 and organization_id = $3",
      [conversationId, website.website_id, website.organization_id],
    );
    if (!rows[0]) throw new PortalError("not_found", "Not found.");
    return conversationId;
  }
  const id = crypto.randomUUID();
  await engine.db.query(
    `insert into conversations (id, organization_id, website_id, created_by, title) values ($1,$2,$3,$4,$5)`,
    [id, website.organization_id, website.website_id, actorId, body.slice(0, 80)],
  );
  return id;
}

async function storeAttachment(
  engine: Engine,
  db: Db,
  input: { messageId: string; organizationId: string; attachment: { filename: string; contentType: string; bytes: Buffer } },
): Promise<void> {
  const allowed = ["text/plain", "text/markdown", "application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif"];
  if (!allowed.includes(input.attachment.contentType)) {
    throw new PortalError("attachment_rejected", "Attachments must be text, PDF, or an image.");
  }
  const { safeFilename } = await import("@/server/files");
  const id = crypto.randomUUID();
  await putBytes(engine.env, id, input.attachment.bytes, input.attachment.contentType);
  await db.query(
    `insert into attachments (id, message_id, organization_id, storage_key, filename, content_type, byte_size)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [id, input.messageId, input.organizationId, id, safeFilename(input.attachment.filename), input.attachment.contentType, input.attachment.bytes.byteLength],
  );
}

async function transition(engine: Engine, changeRequestId: string, to: ChangeStatus, error: string | null): Promise<void> {
  const rows = await engine.db.query<{ status: string }>("select status from change_requests where id = $1", [changeRequestId]);
  const current = rows[0]?.status;
  if (!current || !isChangeStatus(current)) throw new PortalError("not_found", "Not found.");
  if (current === to) return;
  assertTransition(current, to);
  const updated = await engine.db.query(
    `update change_requests set status = $1, last_error = $2, updated_at = now() where id = $3 and status = $4 returning id`,
    [to, error, changeRequestId, current],
  );
  if (!updated.length) throw new PortalError("invalid_transition", "The change was updated by someone else.");
}

async function audit(
  engine: Engine,
  event: {
    organizationId: string;
    websiteId: string | null;
    actorUserId: string | null;
    action: string;
    entityType: string;
    entityId: string;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await engine.db.query(
    `insert into audit_events (id, organization_id, website_id, actor_user_id, action, entity_type, entity_id, metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [
      crypto.randomUUID(),
      event.organizationId,
      event.websiteId,
      event.actorUserId,
      event.action,
      event.entityType,
      event.entityId,
      JSON.stringify(event.metadata),
    ],
  );
}

async function addAssistant(engine: Engine, conversationId: string, organizationId: string, body: string): Promise<void> {
  await engine.db.query(
    `insert into messages (id, conversation_id, organization_id, role, body) values ($1,$2,$3,'assistant',$4)`,
    [crypto.randomUUID(), conversationId, organizationId, redactSecrets(body, knownSecretValues()).slice(0, 4000)],
  );
}

type ChangeRow = {
  id: string;
  organization_id: string;
  website_id: string;
  conversation_id: string;
  status: string;
  title: string;
  last_error: string | null;
};

async function mustChange(engine: Engine, id: string): Promise<ChangeRow> {
  const rows = await engine.db.query<ChangeRow>(
    `select id, organization_id, website_id, conversation_id, status, title, last_error from change_requests where id = $1`,
    [id],
  );
  if (!rows[0]) throw new PortalError("not_found", "Not found.");
  return rows[0];
}

type RevisionRow = {
  id: string;
  revision_number: number;
  branch_name: string;
  commit_sha: string | null;
  base_sha: string | null;
  summary: string | null;
  validation_status: "pending" | "passed" | "failed";
};

async function latestRevision(engine: Engine, changeRequestId: string): Promise<RevisionRow> {
  const rows = await engine.db.query<RevisionRow>(
    `select id, revision_number, branch_name, commit_sha, base_sha, summary, validation_status
     from change_revisions where change_request_id = $1 order by revision_number desc limit 1`,
    [changeRequestId],
  );
  if (!rows[0]) throw new PortalError("not_found", "Not found.");
  return rows[0];
}

async function revisionById(engine: Engine, id: string): Promise<RevisionRow> {
  const rows = await engine.db.query<RevisionRow>(
    `select id, revision_number, branch_name, commit_sha, base_sha, summary, validation_status
     from change_revisions where id = $1`,
    [id],
  );
  if (!rows[0]) throw new PortalError("not_found", "Not found.");
  return rows[0];
}

type PreviewRow = {
  id: string;
  commit_sha: string;
  status: "building" | "ready" | "failed";
  url: string;
};

async function previewForRevision(engine: Engine, revisionId: string): Promise<PreviewRow | null> {
  const rows = await engine.db.query<PreviewRow>(
    `select id, commit_sha, status, url from deployment_previews where revision_id = $1 order by created_at desc limit 1`,
    [revisionId],
  );
  return rows[0] ?? null;
}

type ApprovalRow = {
  id: string;
  revision_id: string;
  commit_sha: string;
  deployment_id: string;
  approved_by: string;
  revoked: boolean;
};

async function currentApproval(engine: Engine, changeRequestId: string): Promise<ApprovalRow | null> {
  const rows = await engine.db.query<ApprovalRow>(
    `select a.id, a.revision_id, a.commit_sha, a.deployment_id, a.approved_by, (r.id is not null) as revoked
     from approval_records a
     left join approval_revocations r on r.approval_id = a.id
     where a.change_request_id = $1
     order by a.approved_at desc
     limit 1`,
    [changeRequestId],
  );
  return rows[0] ?? null;
}

type ConfigRow = {
  website_id: string;
  production_branch: string;
  git_provider: "local_git" | "github_app";
  repository: string;
  deploy_provider: "local_preview" | "vercel";
  vercel_project_id: string | null;
  vercel_team_id: string | null;
  agent_provider: "field_editor" | "claude";
  allowed_paths: unknown;
  validation_argv: unknown;
  budget_max_tokens: number;
  budget_max_runtime_seconds: number;
};

async function loadConfig(engine: Engine, websiteId: string): Promise<ConfigRow> {
  const rows = await engine.db.query<ConfigRow>(
    `select c.website_id, w.production_branch, c.git_provider, c.repository, c.deploy_provider, c.vercel_project_id,
            c.vercel_team_id, c.agent_provider, c.allowed_paths, c.validation_argv, c.budget_max_tokens, c.budget_max_runtime_seconds
     from website_provider_configs c
     join websites w on w.id = c.website_id
     where c.website_id = $1`,
    [websiteId],
  );
  if (!rows[0]) throw new PortalError("not_configured", "This website has no provider configuration.");
  return rows[0];
}

async function mustJob(engine: Engine, id: string): Promise<JobRow> {
  const rows = await engine.db.query<JobRow>(
    `select id, organization_id, website_id, change_request_id, revision_id, status, attempt, max_attempts,
            token_budget, tokens_used, runtime_budget_seconds, checkpoint, log
     from agent_jobs where id = $1`,
    [id],
  );
  if (!rows[0]) throw new PortalError("not_found", "Not found.");
  return rows[0];
}

async function saveCheckpoint(engine: Engine, jobId: string, checkpoint: Checkpoint, tokensUsed: number): Promise<void> {
  await engine.db.query(
    `update agent_jobs
     set checkpoint = $2::jsonb,
         tokens_used = case when $3 > 0 then $3 else tokens_used end
     where id = $1`,
    [jobId, JSON.stringify(checkpoint), tokensUsed],
  );
}

async function appendLog(engine: Engine, jobId: string, line: string, secrets: string[]): Promise<void> {
  const safe = redactSecrets(line, secrets).slice(0, 2000);
  await engine.db.query("update agent_jobs set log = log || $2 where id = $1", [jobId, `${safe}\n`]);
}

async function ensureTime(engine: Engine, jobId: string): Promise<void> {
  const rows = await engine.db.query<{ timed_out: boolean }>(
    "select (timeout_at is not null and timeout_at < now()) as timed_out from agent_jobs where id = $1",
    [jobId],
  );
  if (rows[0]?.timed_out) {
    throw new PortalError("timeout", "The job exceeded its runtime budget.", { retryable: true });
  }
}

async function latestUserMessage(engine: Engine, conversationId: string): Promise<string> {
  const rows = await engine.db.query<{ body: string }>(
    `select body from messages where conversation_id = $1 and role = 'user' order by created_at desc limit 1`,
    [conversationId],
  );
  if (!rows[0]) throw new PortalError("invalid_request", "The conversation has no request.");
  return rows[0].body;
}

async function latestAttachmentText(engine: Engine, conversationId: string): Promise<string | undefined> {
  const rows = await engine.db.query<{ id: string; content_type: string }>(
    `select a.id, a.content_type
     from attachments a
     join messages m on m.id = a.message_id
     where m.conversation_id = $1 and a.content_type in ('text/plain', 'text/markdown')
     order by a.created_at desc limit 1`,
    [conversationId],
  );
  if (!rows[0]) return undefined;
  const bytes = await getBytes(engine.env, rows[0].id);
  return bytes.subarray(0, 20_000).toString("utf8");
}

async function assertOrgAdminSomewhere(engine: Engine, userId: string): Promise<void> {
  const rows = await engine.db.query<{ role: OrgRole }>(
    "select role from organization_memberships where user_id = $1 and role in ('owner', 'admin') limit 1",
    [userId],
  );
  if (!rows[0]) throw new PortalError("forbidden", "Only an organization owner or admin can do that.");
}

async function requireOrgRole(engine: Engine, userId: string, organizationId: string): Promise<void> {
  const rows = await engine.db.query<{ role: OrgRole }>(
    "select role from organization_memberships where user_id = $1 and organization_id = $2",
    [userId, organizationId],
  );
  if (!rows[0]) throw new PortalError("not_found", "Not found.");
  if (rows[0].role !== "owner" && rows[0].role !== "admin") {
    throw new PortalError("forbidden", "Only an organization owner or admin can do that.");
  }
}

function productionDir(engine: Engine, websiteId: string): string {
  return path.join(engine.env.dataDir, "production", websiteId);
}

function branchName(changeRequestId: string, revision: number): string {
  return `portal/${changeRequestId.slice(0, 8)}-r${revision}`;
}

function requireName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 80) throw new PortalError("invalid_request", "Use a name between 2 and 80 characters.");
  return trimmed;
}

function requireSlug(slug: string): string {
  const trimmed = slug.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmed)) {
    throw new PortalError("invalid_request", "Use a lowercase slug with letters, numbers, and hyphens.");
  }
  return trimmed;
}

function stringArray(value: unknown): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function jsonObject<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  if (value && typeof value === "object") return value as T;
  return {} as T;
}

export async function ensureMirrorOnDemand(engine: Engine, websiteId: string): Promise<void> {
  const config = await loadConfig(engine, websiteId);
  if (config.git_provider === "github_app") {
    await ensureGithubMirror(engine, config.repository, config.production_branch);
  }
}
