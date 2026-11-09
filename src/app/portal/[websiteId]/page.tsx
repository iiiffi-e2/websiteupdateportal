import { notFound, redirect } from "next/navigation";
import { approveAction, cancelAction, publishAction, revisionAction, sendAction } from "@/app/portal/[websiteId]/actions";
import { PortalFrame } from "@/components/frame";
import { LiveRefresh } from "@/components/live-refresh";
import { PortalError } from "@/domain/errors";
import { statusLabel, type ChangeStatus } from "@/domain/status";
import { currentUserId } from "@/server/http";
import { getEngine } from "@/server/runtime";
import { loadWebsitePage } from "@/server/view";

export const dynamic = "force-dynamic";

const ACTIVE = new Set(["queued", "running", "testing", "publishing", "revision_requested"]);

export default async function WebsitePage({
  params,
  searchParams,
}: {
  params: Promise<{ websiteId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { websiteId } = await params;
  const { error } = await searchParams;
  const engine = await getEngine();
  const userId = await currentUserId(engine);
  if (!userId) redirect("/login");
  let page;
  try {
    page = await loadWebsitePage(engine, userId, websiteId);
  } catch (caught) {
    if (caught instanceof PortalError && (caught.code === "not_found" || caught.code === "forbidden")) notFound();
    throw caught;
  }
  if (!page.user) notFound();
  const status = page.current?.status as ChangeStatus | undefined;
  const busy = status ? ACTIVE.has(status) || status === "draft" : false;
  const canCompose = !status || status === "published" || status === "failed" || status === "canceled";
  return (
    <PortalFrame user={page.user} admin={page.admin} sites={page.sites} activeWebsiteId={websiteId}>
      <LiveRefresh active={Boolean(status && ACTIVE.has(status))} />
      <div className="workspace">
        <aside className="sidebar">
          <History changes={page.changes} deployments={page.deployments} />
        </aside>
        <main className="thread">
          <details className="mobile-history">
            <summary>History</summary>
            <History changes={page.changes} deployments={page.deployments} />
          </details>
          <p className="lede">{page.website.name}</p>
          {error ? <p className="alert" role="alert">{error}</p> : null}
          {!page.website.autonomous_enabled ? (
            <p className="alert" role="status">Autonomous processing is off. Requests stay queued until an administrator enables it.</p>
          ) : null}
          {page.messages.length === 0 ? (
            <article className="card">
              <h2>What should change?</h2>
              <p className="lede">
                Ask in one sentence. This site can update the headline, tagline, phone number, or accent color.
              </p>
            </article>
          ) : (
            page.messages.map((message) => (
              <article key={message.id} className={`message ${message.role}`}>
                {message.body}
              </article>
            ))
          )}
          {page.current && status ? (
            <section className="card" aria-live="polite">
              <p className="status" data-status={status}>{statusLabel(status)}</p>
              {page.revision?.summary ? <h2>{page.revision.summary}</h2> : <h2>{page.current.title}</h2>}
              {page.revision?.commit_sha ? <p className="lede">Commit {page.revision.commit_sha.slice(0, 7)}</p> : null}
              {page.current.last_error ? <p className="alert" role="alert">{page.current.last_error}</p> : null}
              {page.preview && status !== "published" && status !== "canceled" ? (
                <a className="button" href={page.preview.url} target="_blank" rel="noreferrer">Open preview</a>
              ) : null}
              <div className="actions">
                {status === "preview_ready" ? (
                  <form action={approveAction}>
                    <input type="hidden" name="websiteId" value={websiteId} />
                    <input type="hidden" name="changeRequestId" value={page.current.id} />
                    <button className="primary" type="submit">Approve</button>
                  </form>
                ) : null}
                {status === "approved" ? (
                  <form action={publishAction}>
                    <input type="hidden" name="websiteId" value={websiteId} />
                    <input type="hidden" name="changeRequestId" value={page.current.id} />
                    <button className="copper" type="submit">Publish</button>
                  </form>
                ) : null}
                {status === "preview_ready" || status === "approved" || status === "queued" || status === "failed" ? (
                  <form action={cancelAction}>
                    <input type="hidden" name="websiteId" value={websiteId} />
                    <input type="hidden" name="changeRequestId" value={page.current.id} />
                    <button className="quiet-button" type="submit">Cancel</button>
                  </form>
                ) : null}
              </div>
              {status === "preview_ready" || status === "approved" ? (
                <form className="stack-form" action={revisionAction}>
                  <input type="hidden" name="websiteId" value={websiteId} />
                  <input type="hidden" name="changeRequestId" value={page.current.id} />
                  <label htmlFor="note">Request a revision</label>
                  <textarea id="note" name="note" required placeholder="Change the headline to Autumn Light" />
                  <button className="quiet-button" type="submit">Request revision</button>
                </form>
              ) : null}
              {page.job?.log ? (
                <details>
                  <summary>Execution log</summary>
                  <pre className="log">{page.job.log}</pre>
                </details>
              ) : null}
            </section>
          ) : null}
          {canCompose ? (
            <div className="composer">
              <form action={sendAction}>
                <input type="hidden" name="websiteId" value={websiteId} />
                {page.conversation ? <input type="hidden" name="conversationId" value={page.conversation.id} /> : null}
                <label htmlFor="request">What should change?</label>
                <textarea id="request" name="body" required placeholder="Change the headline to Summer Hours" disabled={busy} />
                <label htmlFor="attachment">Attachment</label>
                <input id="attachment" name="attachment" type="file" />
                <button className="primary" type="submit">Send request</button>
              </form>
            </div>
          ) : null}
        </main>
      </div>
    </PortalFrame>
  );
}

function History({
  changes,
  deployments,
}: {
  changes: { id: string; title: string; status: string; created_at: string | Date }[];
  deployments: { id: string; status: string; url: string | null; commit_sha: string | null; created_at: string | Date }[];
}) {
  return (
    <>
      <h2>Requests</h2>
      <ul className="history-list">
        {changes.length === 0 ? <li className="lede">No requests yet.</li> : null}
        {changes.map((change) => (
          <li key={change.id}>
            <strong>{change.title}</strong>
            <span className="lede">{statusLabel(change.status as ChangeStatus)} · {when(change.created_at)}</span>
          </li>
        ))}
      </ul>
      <h2>Published</h2>
      <ul className="history-list">
        {deployments.length === 0 ? <li className="lede">Nothing published yet.</li> : null}
        {deployments.map((deployment) => (
          <li key={deployment.id}>
            {deployment.url ? <a href={deployment.url}>{deployment.status}</a> : <strong>{deployment.status}</strong>}
            <span className="lede">{deployment.commit_sha?.slice(0, 7) ?? "pending"} · {when(deployment.created_at)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function when(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}
