import type { ChangeStatus } from "@/domain/status";

export type PublishGateInput = {
  changeStatus: ChangeStatus;
  approval: {
    revisionId: string;
    commitSha: string;
    deploymentId: string;
    revoked: boolean;
  } | null;
  revision: {
    id: string;
    commitSha: string | null;
    validationStatus: "pending" | "passed" | "failed";
  };
  preview: {
    id: string;
    commitSha: string;
    status: "building" | "ready" | "failed";
    url: string;
  } | null;
  productionSha: string;
  baseSha: string;
  branchTipSha: string;
};

export type PublishGateResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export function evaluatePublish(input: PublishGateInput): PublishGateResult {
  if (input.changeStatus !== "approved") {
    return {
      ok: false,
      code: "not_approved",
      message: "Publish only runs after this exact revision has been approved.",
    };
  }
  if (!input.approval || input.approval.revoked) {
    return {
      ok: false,
      code: "approval_missing",
      message: "There is no valid approval for this revision.",
    };
  }
  if (input.approval.revisionId !== input.revision.id) {
    return {
      ok: false,
      code: "approval_mismatch",
      message: "The approval belongs to a different revision.",
    };
  }
  if (!input.revision.commitSha || input.revision.validationStatus !== "passed") {
    return {
      ok: false,
      code: "checks_failed",
      message: "Required checks have not passed for the approved revision.",
    };
  }
  if (!input.preview || input.preview.status !== "ready" || !input.preview.url) {
    return {
      ok: false,
      code: "preview_missing",
      message: "The approved preview is not ready.",
    };
  }
  if (input.preview.id !== input.approval.deploymentId) {
    return {
      ok: false,
      code: "deployment_mismatch",
      message: "Publishing was rejected because the deployment is not the approved preview.",
    };
  }
  const approvedSha = input.approval.commitSha;
  if (
    input.revision.commitSha !== approvedSha ||
    input.preview.commitSha !== approvedSha ||
    input.branchTipSha !== approvedSha
  ) {
    return {
      ok: false,
      code: "revision_moved",
      message: "The branch no longer matches the approved commit. Request a revision.",
    };
  }
  if (input.productionSha !== input.baseSha) {
    return {
      ok: false,
      code: "production_moved",
      message: "Production changed after this preview was created. Request a revision before publishing.",
    };
  }
  return { ok: true };
}
