import type { ReactNode } from "react";
import { logoutAction } from "@/app/logout-action";
import type { PortalUser } from "@/server/view";

export function PortalFrame({
  user,
  admin,
  sites,
  activeWebsiteId,
  children,
}: {
  user: PortalUser;
  admin: boolean;
  sites: { id: string; name: string }[];
  activeWebsiteId?: string;
  children: ReactNode;
}) {
  return (
    <div className="shell">
      <header className="topbar">
        <a className="wordmark" href="/">
          Website Update Portal
        </a>
        <nav className="site-switch" aria-label="Websites">
          {sites.map((site) => (
            <a key={site.id} href={`/portal/${site.id}`} aria-current={site.id === activeWebsiteId ? "page" : undefined}>
              {site.name}
            </a>
          ))}
        </nav>
        <div className="top-actions">
          {admin ? <a href="/admin">Admin</a> : null}
          <span>{user.name}</span>
          <form action={logoutAction}>
            <button type="submit">Sign out</button>
          </form>
        </div>
      </header>
      {children}
    </div>
  );
}
