export const ORG_ROLES = ["owner", "admin", "member", "client"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const WEBSITE_ROLES = ["manager", "editor", "approver", "viewer"] as const;
export type WebsiteRole = (typeof WEBSITE_ROLES)[number];

export const ACTIONS = [
  "org.admin",
  "website.admin",
  "website.read",
  "website.request",
  "website.approve",
  "website.publish",
  "website.rollback",
] as const;

export type Action = (typeof ACTIONS)[number];

export type AccessInput = {
  orgRole: OrgRole | null;
  websiteRole: WebsiteRole | null;
  action: Action;
};

export type AccessDecision = {
  allowed: boolean;
  reason: string;
};

const REQUEST_ROLES: readonly WebsiteRole[] = ["manager", "editor", "approver"];
const APPROVE_ROLES: readonly WebsiteRole[] = ["manager", "approver"];

export function decideAccess(input: AccessInput): AccessDecision {
  if (!input.orgRole) {
    return { allowed: false, reason: "You are not a member of this organization." };
  }

  if (input.action === "org.admin" || input.action === "website.admin" || input.action === "website.rollback") {
    const allowed = input.orgRole === "owner" || input.orgRole === "admin";
    return allowed
      ? { allowed: true, reason: "Organization managers can administer websites." }
      : { allowed: false, reason: "Only an organization owner or admin can do that." };
  }

  if (input.orgRole === "owner" || input.orgRole === "admin") {
    return { allowed: true, reason: "Organization managers can access every website." };
  }

  if (!input.websiteRole) {
    return { allowed: false, reason: "You are not a member of this website." };
  }

  if (input.action === "website.read") {
    return { allowed: true, reason: "Website members can view this website." };
  }

  if (input.action === "website.request" && REQUEST_ROLES.includes(input.websiteRole)) {
    return { allowed: true, reason: "You can request changes on this website." };
  }

  if (
    (input.action === "website.approve" || input.action === "website.publish") &&
    APPROVE_ROLES.includes(input.websiteRole)
  ) {
    return {
      allowed: true,
      reason: "You can approve and publish changes on this website.",
    };
  }

  return { allowed: false, reason: "Your website role does not allow that action." };
}
