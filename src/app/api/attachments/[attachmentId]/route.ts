import { readAuthorizedAttachment } from "@/server/engine";
import { currentUserId } from "@/server/http";
import { getEngine } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ attachmentId: string }> },
): Promise<Response> {
  const { attachmentId } = await context.params;
  const engine = await getEngine();
  const userId = await currentUserId(engine);
  if (!userId) return new Response("Sign in required.", { status: 401 });
  try {
    const file = await readAuthorizedAttachment(engine, userId, attachmentId);
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        "content-type": file.contentType,
        "content-disposition": `attachment; filename="${file.filename.replaceAll('"', "")}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return new Response("Not found.", { status: 404 });
  }
}
