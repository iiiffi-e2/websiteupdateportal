import type { Engine } from "@/server/engine";
import { requireWebsite, websitesFor } from "@/server/engine";

export type PortalUser = { id: string; email: string; name: string };

export async function loadUser(engine: Engine, userId: string): Promise<PortalUser | null> {
  const rows = await engine.db.query<PortalUser>("select id, email, name from users where id = $1", [userId]);
  return rows[0] ?? null;
}

export async function isOrgAdmin(engine: Engine, userId: string): Promise<boolean> {
  const rows = await engine.db.query(
    "select id from organization_memberships where user_id = $1 and role in ('owner', 'admin') limit 1",
    [userId],
  );
  return rows.length > 0;
}

export async function loadWebsitePage(engine: Engine, userId: string, websiteId: string) {
  const website = await requireWebsite(engine, userId, websiteId, "website.read");
  const [sites, user, admin, conversationRows, changes, deployments] = await Promise.all([
    websitesFor(engine, userId),
    loadUser(engine, userId),
    isOrgAdmin(engine, userId),
    engine.db.query<{ id: string; title: string }>(
      "select id, title from conversations where website_id = $1 order by created_at desc limit 1",
      [websiteId],
    ),
    engine.db.query<{ id: string; title: string; status: string; last_error: string | null; created_at: string }>(
      `select id, title, status, last_error, created_at from change_requests
       where website_id = $1 order by created_at desc limit 20`,
      [websiteId],
    ),
    engine.db.query<{ id: string; status: string; commit_sha: string | null; url: string | null; created_at: string; error: string | null }>(
      `select id, status, commit_sha, url, created_at, error from production_deployments
       where website_id = $1 order by created_at desc limit 20`,
      [websiteId],
    ),
  ]);
  const conversation = conversationRows[0] ?? null;
  const messages = conversation
    ? await engine.db.query<{ id: string; role: string; body: string; created_at: string }>(
        "select id, role, body, created_at from messages where conversation_id = $1 order by created_at asc",
        [conversation.id],
      )
    : [];
  const current = changes[0] ?? null;
  const revision = current
    ? (
        await engine.db.query<{
          id: string;
          summary: string | null;
          commit_sha: string | null;
          validation_status: string;
          branch_name: string;
        }>(
          `select id, summary, commit_sha, validation_status, branch_name
           from change_revisions where change_request_id = $1 order by revision_number desc limit 1`,
          [current.id],
        )
      )[0] ?? null
    : null;
  const preview = revision
    ? (
        await engine.db.query<{ id: string; url: string; commit_sha: string; status: string }>(
          "select id, url, commit_sha, status from deployment_previews where revision_id = $1 order by created_at desc limit 1",
          [revision.id],
        )
      )[0] ?? null
    : null;
  const job = current
    ? (
        await engine.db.query<{ id: string; status: string; error: string | null; log: string }>(
          "select id, status, error, log from agent_jobs where change_request_id = $1 order by created_at desc limit 1",
          [current.id],
        )
      )[0] ?? null
    : null;
  return {
    user,
    admin,
    sites,
    website,
    conversation,
    messages,
    changes,
    deployments,
    current,
    revision,
    preview,
    job,
  };
}

export async function loadAdminPage(engine: Engine, userId: string) {
  const user = await loadUser(engine, userId);
  const orgs = await engine.db.query<{ id: string; name: string; slug: string }>(
    `select o.id, o.name, o.slug
     from organizations o
     join organization_memberships m on m.organization_id = o.id
     where m.user_id = $1 and m.role in ('owner', 'admin')
     order by o.name`,
    [userId],
  );
  const scope = `organization_id in (
         select organization_id from organization_memberships
         where user_id = $1 and role in ('owner', 'admin')
       )`;
  const websites = await engine.db.query<{
    id: string;
    name: string;
    slug: string;
    organization_id: string;
    autonomous_enabled: boolean;
    repository: string | null;
    git_provider: string | null;
    deploy_provider: string | null;
    agent_provider: string | null;
  }>(
    `select w.id, w.name, w.slug, w.organization_id, w.autonomous_enabled,
            c.repository, c.git_provider, c.deploy_provider, c.agent_provider
     from websites w
     left join website_provider_configs c on c.website_id = w.id
     where w.${scope}
     order by w.name`,
    [userId],
  );
  const failures = await engine.db.query<{ id: string; website_id: string; title: string; last_error: string | null; created_at: string }>(
    `select cr.id, cr.website_id, cr.title, cr.last_error, cr.created_at
     from change_requests cr
     where cr.${scope} and cr.status = 'failed'
     order by cr.created_at desc limit 20`,
    [userId],
  );
  const deployments = await engine.db.query<{
    id: string;
    website_id: string;
    status: string;
    commit_sha: string | null;
    url: string | null;
    error: string | null;
    created_at: string;
  }>(
    `select id, website_id, status, commit_sha, url, error, created_at
     from production_deployments
     where ${scope}
     order by created_at desc limit 20`,
    [userId],
  );
  const events = await engine.db.query<{ id: string; action: string; created_at: string; website_id: string | null }>(
    `select id, action, created_at, website_id from audit_events
     where ${scope}
     order by created_at desc limit 30`,
    [userId],
  );
  return { user, orgs, websites, failures, deployments, events };
}
