import { redirect } from "next/navigation";
import { autonomousAction, createOrgAction, inviteAction, registerWebsiteAction, retryAction, rollbackAction } from "@/app/admin/actions";
import { PortalFrame } from "@/components/frame";
import { currentUserId } from "@/server/http";
import { getEngine } from "@/server/runtime";
import { websitesFor } from "@/server/engine";
import { loadAdminPage } from "@/server/view";

export const dynamic = "force-dynamic";

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const engine = await getEngine();
  const userId = await currentUserId(engine);
  if (!userId) redirect("/login");
  const { error } = await searchParams;
  const [page, sites] = await Promise.all([loadAdminPage(engine, userId), websitesFor(engine, userId)]);
  if (!page.user || page.orgs.length === 0) redirect("/");
  return (
    <PortalFrame user={page.user} admin sites={sites}>
      <main className="admin-page">
        <h1>Administration</h1>
        <p className="lede">Create a client organization, invite people, and connect one allowlisted repository.</p>
        {error ? <p className="alert" role="alert">{error}</p> : null}
        <section className="admin-grid">
          <form className="card stack-form" action={createOrgAction}>
            <h2>New organization</h2>
            <label htmlFor="org-name">Name</label>
            <input id="org-name" name="name" type="text" required />
            <label htmlFor="org-slug">Slug</label>
            <input id="org-slug" name="slug" type="text" required placeholder="northwind" />
            <button className="primary" type="submit">Create organization</button>
          </form>
          <form className="card stack-form" action={inviteAction}>
            <h2>Invite a person</h2>
            <label htmlFor="invite-org">Organization</label>
            <select id="invite-org" name="organizationId" required>
              {page.orgs.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
            </select>
            <label htmlFor="invite-name">Name</label>
            <input id="invite-name" name="name" type="text" required />
            <label htmlFor="invite-email">Email</label>
            <input id="invite-email" name="email" type="email" required />
            <label htmlFor="invite-password">Temporary password</label>
            <input id="invite-password" name="password" type="text" required minLength={10} />
            <label htmlFor="invite-role">Organization role</label>
            <select id="invite-role" name="orgRole" defaultValue="client">
              <option value="client">Client</option>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <label htmlFor="invite-website">Website access</label>
            <select id="invite-website" name="websiteId" defaultValue="">
              <option value="">None</option>
              {page.websites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
            </select>
            <label htmlFor="invite-website-role">Website role</label>
            <select id="invite-website-role" name="websiteRole" defaultValue="approver">
              <option value="approver">Approver</option>
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
              <option value="manager">Manager</option>
            </select>
            <button className="primary" type="submit">Invite</button>
          </form>
          <form className="card stack-form" action={registerWebsiteAction}>
            <h2>Register a website</h2>
            <label htmlFor="site-org">Organization</label>
            <select id="site-org" name="organizationId" required>
              {page.orgs.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
            </select>
            <label htmlFor="site-name">Name</label>
            <input id="site-name" name="name" type="text" required />
            <label htmlFor="site-slug">Slug</label>
            <input id="site-slug" name="slug" type="text" required />
            <label htmlFor="git-provider">Repository provider</label>
            <select id="git-provider" name="gitProvider" defaultValue="local_git">
              <option value="local_git">Local git</option>
              <option value="github_app">GitHub App</option>
            </select>
            <label htmlFor="repository">Allowlisted repository</label>
            <input id="repository" name="repository" type="text" required placeholder="lumen-studio" />
            <label htmlFor="deploy-provider">Deployment provider</label>
            <select id="deploy-provider" name="deployProvider" defaultValue={engineDeployDefault()}>
              <option value="local_preview">Local preview</option>
              <option value="vercel">Vercel</option>
            </select>
            <label htmlFor="agent-provider">Editor</label>
            <select id="agent-provider" name="agentProvider" defaultValue="field_editor">
              <option value="field_editor">Field editor</option>
              <option value="claude">Claude</option>
            </select>
            <label htmlFor="allowed-paths">Allowlisted files</label>
            <input id="allowed-paths" name="allowedPaths" type="text" defaultValue="index.html, styles.css" />
            <label htmlFor="validation">Validation command</label>
            <input id="validation" name="validation" type="text" placeholder="node check.js" />
            <label htmlFor="vercel-project">Vercel project id</label>
            <input id="vercel-project" name="vercelProjectId" type="text" />
            <label htmlFor="tokens">Token budget</label>
            <input id="tokens" name="budgetMaxTokens" type="number" min={1} defaultValue={20000} />
            <label htmlFor="runtime">Runtime budget (seconds)</label>
            <input id="runtime" name="budgetMaxRuntimeSeconds" type="number" min={1} defaultValue={120} />
            <label htmlFor="concurrency">Concurrent jobs</label>
            <input id="concurrency" name="maxConcurrentJobs" type="number" min={1} defaultValue={1} />
            <label><input name="autonomousEnabled" type="checkbox" defaultChecked /> Autonomous processing</label>
            <button className="primary" type="submit">Register website</button>
          </form>
        </section>
        <section className="card">
          <h2>Websites</h2>
          <table className="table">
            <thead>
              <tr><th>Name</th><th>Connection</th><th>Processing</th></tr>
            </thead>
            <tbody>
              {page.websites.map((site) => (
                <tr key={site.id}>
                  <td><a href={`/portal/${site.id}`}>{site.name}</a></td>
                  <td>{site.git_provider} · {site.repository} · {site.deploy_provider} · {site.agent_provider}</td>
                  <td>
                    <form action={autonomousAction}>
                      <input type="hidden" name="websiteId" value={site.id} />
                      <input type="hidden" name="enabled" value={site.autonomous_enabled ? "false" : "true"} />
                      <button className="quiet-button" type="submit">{site.autonomous_enabled ? "Disable" : "Enable"}</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="card">
          <h2>Failures</h2>
          {page.failures.length === 0 ? <p className="lede">No failed requests.</p> : null}
          <ul className="history-list">
            {page.failures.map((failure) => (
              <li key={failure.id}>
                <strong>{failure.title}</strong>
                <span className="lede">{failure.last_error}</span>
                <form action={retryAction}>
                  <input type="hidden" name="changeRequestId" value={failure.id} />
                  <button className="quiet-button" type="submit">Retry</button>
                </form>
              </li>
            ))}
          </ul>
        </section>
        <section className="card">
          <h2>Deployments</h2>
          {page.deployments.length === 0 ? <p className="lede">No deployments yet.</p> : null}
          <ul className="history-list">
            {page.deployments.map((deployment) => (
              <li key={deployment.id}>
                <strong>{deployment.status}</strong>
                <span className="lede">{deployment.commit_sha?.slice(0, 7)} {deployment.error ?? ""}</span>
                {deployment.url ? <a href={deployment.url}>Open</a> : null}
                {deployment.status === "published" ? (
                  <form action={rollbackAction}>
                    <input type="hidden" name="deploymentId" value={deployment.id} />
                    <button className="quiet-button" type="submit">Roll back</button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
        <section className="card">
          <h2>Audit</h2>
          <ul className="history-list">
            {page.events.map((event) => (
              <li key={event.id}>
                <strong>{event.action}</strong>
                <span className="lede">{String(event.created_at)}</span>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </PortalFrame>
  );
}

function engineDeployDefault(): string {
  return process.env.DEPLOY_PROVIDER === "vercel" ? "vercel" : "local_preview";
}
