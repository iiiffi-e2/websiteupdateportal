import { PortalError } from "@/domain/errors";
import { redactSecrets } from "@/domain/safety";
import type { Env } from "@/server/env";
import { readAttachment, writeAttachment } from "@/server/files";

const BUCKET = "portal-attachments";

export function usesSupabaseStorage(env: Env): boolean {
  return Boolean(env.supabaseUrl && env.supabaseServiceRoleKey);
}

export async function putBytes(
  env: Env,
  id: string,
  bytes: Buffer,
  contentType: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!usesSupabaseStorage(env)) {
    await writeAttachment(env.dataDir, id, bytes);
    return;
  }
  const response = await fetchImpl(`${env.supabaseUrl!.replace(/\/$/, "")}/storage/v1/object/${BUCKET}/${id}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      apikey: env.supabaseServiceRoleKey!,
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body: new Uint8Array(bytes),
  });
  if (!response.ok) {
    const detail = redactSecrets(await response.text(), [env.supabaseServiceRoleKey!]).slice(0, 180);
    throw new PortalError("storage_failed", `Attachment storage failed (${response.status}). ${detail}`);
  }
}

export async function getBytes(env: Env, id: string, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  if (!usesSupabaseStorage(env)) return readAttachment(env.dataDir, id);
  const response = await fetchImpl(`${env.supabaseUrl!.replace(/\/$/, "")}/storage/v1/object/${BUCKET}/${id}`, {
    headers: {
      Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      apikey: env.supabaseServiceRoleKey!,
    },
  });
  if (!response.ok) throw new PortalError("not_found", "Not found.");
  return Buffer.from(await response.arrayBuffer());
}
