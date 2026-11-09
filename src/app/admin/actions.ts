"use server";

import { redirect } from "next/navigation";
import { PortalError } from "@/domain/errors";
import type { OrgRole, WebsiteRole } from "@/domain/access";
import {
  createOrganization,
  inviteUser,
  processDue,
  registerWebsite,
  retryChange,
  rollbackDeployment,
  setAutonomous,
} from "@/server/engine";
import { currentUserId } from "@/server/http";
import { getEngine } from "@/server/runtime";

function fail(error: unknown): never {
  const message = error instanceof PortalError ? error.message : "The request could not be completed.";
  redirect(`/admin?error=${encodeURIComponent(message)}`);
}

async function actor() {
  const engine = await getEngine();
  const userId = await currentUserId(engine);
  if (!userId) redirect("/login");
  return { engine, userId };
}

export async function createOrgAction(formData: FormData): Promise<void> {
  const { engine, userId } = await actor();
  try {
    await createOrganization(engine, userId, String(formData.get("name") ?? ""), String(formData.get("slug") ?? ""));
  } catch (error) {
    fail(error);
  }
  redirect("/admin");
}

export async function inviteAction(formData: FormData): Promise<void> {
  const { engine, userId } = await actor();
  const websiteId = String(formData.get("websiteId") ?? "");
  try {
    await inviteUser(engine, userId, {
      organizationId: String(formData.get("organizationId") ?? ""),
      email: String(formData.get("email") ?? ""),
      name: String(formData.get("name") ?? ""),
      password: String(formData.get("password") ?? ""),
      orgRole: String(formData.get("orgRole") ?? "client") as OrgRole,
      websiteId: websiteId || undefined,
      websiteRole: websiteId ? (String(formData.get("websiteRole") ?? "approver") as WebsiteRole) : undefined,
    });
  } catch (error) {
    fail(error);
  }
  redirect("/admin");
}

export async function registerWebsiteAction(formData: FormData): Promise<void> {
  const { engine, userId } = await actor();
  const paths = String(formData.get("allowedPaths") ?? "index.html, styles.css")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const validation = String(formData.get("validation") ?? "").trim();
  try {
    const websiteId = await registerWebsite(engine, userId, {
      organizationId: String(formData.get("organizationId") ?? ""),
      name: String(formData.get("name") ?? ""),
      slug: String(formData.get("slug") ?? ""),
      gitProvider: String(formData.get("gitProvider") ?? "local_git") as "local_git" | "github_app",
      repository: String(formData.get("repository") ?? ""),
      deployProvider: String(formData.get("deployProvider") ?? "local_preview") as "local_preview" | "vercel",
      agentProvider: String(formData.get("agentProvider") ?? "field_editor") as "field_editor" | "claude",
      allowedPaths: paths,
      validationArgv: validation ? validation.split(/\s+/) : [],
      vercelProjectId: String(formData.get("vercelProjectId") ?? "") || undefined,
      vercelTeamId: String(formData.get("vercelTeamId") ?? "") || undefined,
      budgetMaxTokens: Number(formData.get("budgetMaxTokens") ?? 20000),
      budgetMaxRuntimeSeconds: Number(formData.get("budgetMaxRuntimeSeconds") ?? 120),
      maxConcurrentJobs: Number(formData.get("maxConcurrentJobs") ?? 1),
      autonomousEnabled: formData.get("autonomousEnabled") === "on",
    });
    redirect(`/portal/${websiteId}`);
  } catch (error) {
    if (error instanceof PortalError) fail(error);
    throw error;
  }
}

export async function autonomousAction(formData: FormData): Promise<void> {
  const { engine, userId } = await actor();
  try {
    await setAutonomous(engine, userId, String(formData.get("websiteId") ?? ""), formData.get("enabled") === "true");
  } catch (error) {
    fail(error);
  }
  redirect("/admin");
}

export async function retryAction(formData: FormData): Promise<void> {
  const { engine, userId } = await actor();
  const changeRequestId = String(formData.get("changeRequestId") ?? "");
  try {
    await retryChange(engine, userId, changeRequestId);
    await processDue(engine);
  } catch (error) {
    fail(error);
  }
  redirect("/admin");
}

export async function rollbackAction(formData: FormData): Promise<void> {
  const { engine, userId } = await actor();
  try {
    await rollbackDeployment(engine, userId, String(formData.get("deploymentId") ?? ""));
  } catch (error) {
    fail(error);
  }
  redirect("/admin");
}
