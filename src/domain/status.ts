import { PortalError } from "@/domain/errors";

export const CHANGE_STATUSES = [
  "draft",
  "queued",
  "running",
  "testing",
  "preview_ready",
  "revision_requested",
  "approved",
  "publishing",
  "published",
  "failed",
  "canceled",
] as const;

export type ChangeStatus = (typeof CHANGE_STATUSES)[number];

export const TRANSITIONS: Record<ChangeStatus, readonly ChangeStatus[]> = {
  draft: ["queued", "canceled"],
  queued: ["running", "canceled", "failed"],
  running: ["testing", "failed", "queued"],
  testing: ["preview_ready", "failed", "queued"],
  preview_ready: ["approved", "revision_requested", "canceled"],
  revision_requested: ["queued", "canceled"],
  approved: ["publishing", "revision_requested", "canceled"],
  publishing: ["published", "approved"],
  published: [],
  failed: ["queued", "canceled"],
  canceled: [],
};

export function isChangeStatus(value: string): value is ChangeStatus {
  return (CHANGE_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: ChangeStatus, to: ChangeStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ChangeStatus, to: ChangeStatus): void {
  if (!canTransition(from, to)) {
    throw new PortalError(
      "invalid_transition",
      `Cannot move a change from ${from} to ${to}.`,
    );
  }
}

export const ACTIVE_STATUSES: readonly ChangeStatus[] = [
  "draft",
  "queued",
  "running",
  "testing",
  "preview_ready",
  "revision_requested",
  "approved",
  "publishing",
];

export function isActiveStatus(status: ChangeStatus): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

export function statusLabel(status: ChangeStatus): string {
  switch (status) {
    case "draft":
      return "Draft";
    case "queued":
      return "Queued";
    case "running":
      return "Editing";
    case "testing":
      return "Checking";
    case "preview_ready":
      return "Preview ready";
    case "revision_requested":
      return "Revision requested";
    case "approved":
      return "Approved";
    case "publishing":
      return "Publishing";
    case "published":
      return "Published";
    case "failed":
      return "Failed";
    case "canceled":
      return "Canceled";
  }
}
