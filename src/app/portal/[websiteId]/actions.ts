"use server";

import { redirect } from "next/navigation";
import { PortalError } from "@/domain/errors";
import {
  approveChange,
  cancelChange,
  processDue,
  publishChange,
  requestRevision,
  sendChange,
} from "@/server/engine";
import { currentUserId } from "@/server/http";
import { getEngine } from "@/server/runtime";

function fail(websiteId: string, error: unknown): never {
  const message = error instanceof PortalError ? error.message : "The request could not be completed.";
  redirect(`/portal/${websiteId}?error=${encodeURIComponent(message)}`);
}

async function actor(websiteId: string): Promise<{ engine: Awaited<ReturnType<typeof getEngine>>; userId: string }> {
  const engine = await getEngine();
  const userId = await currentUserId(engine);
  if (!userId) redirect("/login");
  return { engine, userId };
}

export async function sendAction(formData: FormData): Promise<void> {
  const websiteId = String(formData.get("websiteId") ?? "");
  const { engine, userId } = await actor(websiteId);
  const file = formData.get("attachment");
  let attachment: { filename: string; contentType: string; bytes: Buffer } | null = null;
  if (file instanceof File && file.size > 0) {
    attachment = {
      filename: file.name,
      contentType: file.type || "application/octet-stream",
      bytes: Buffer.from(await file.arrayBuffer()),
    };
  }
  try {
    const conversationId = String(formData.get("conversationId") ?? "");
    await sendChange(engine, {
      actorId: userId,
      websiteId,
      conversationId: conversationId || undefined,
      body: String(formData.get("body") ?? ""),
      attachment,
    });
    await processDue(engine);
  } catch (error) {
    fail(websiteId, error);
  }
  redirect(`/portal/${websiteId}`);
}

export async function approveAction(formData: FormData): Promise<void> {
  const websiteId = String(formData.get("websiteId") ?? "");
  const { engine, userId } = await actor(websiteId);
  try {
    await approveChange(engine, userId, String(formData.get("changeRequestId") ?? ""));
  } catch (error) {
    fail(websiteId, error);
  }
  redirect(`/portal/${websiteId}`);
}

export async function revisionAction(formData: FormData): Promise<void> {
  const websiteId = String(formData.get("websiteId") ?? "");
  const { engine, userId } = await actor(websiteId);
  try {
    await requestRevision(engine, userId, String(formData.get("changeRequestId") ?? ""), String(formData.get("note") ?? ""));
    await processDue(engine);
  } catch (error) {
    fail(websiteId, error);
  }
  redirect(`/portal/${websiteId}`);
}

export async function publishAction(formData: FormData): Promise<void> {
  const websiteId = String(formData.get("websiteId") ?? "");
  const { engine, userId } = await actor(websiteId);
  try {
    await publishChange(engine, userId, String(formData.get("changeRequestId") ?? ""));
  } catch (error) {
    fail(websiteId, error);
  }
  redirect(`/portal/${websiteId}`);
}

export async function cancelAction(formData: FormData): Promise<void> {
  const websiteId = String(formData.get("websiteId") ?? "");
  const { engine, userId } = await actor(websiteId);
  try {
    await cancelChange(engine, userId, String(formData.get("changeRequestId") ?? ""));
  } catch (error) {
    fail(websiteId, error);
  }
  redirect(`/portal/${websiteId}`);
}
