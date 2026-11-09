import { readFile, stat } from "node:fs/promises";
import { PortalError } from "@/domain/errors";
import { readAuthorizedPreview } from "@/server/engine";
import { currentUserId } from "@/server/http";
import { getEngine } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ previewId: string; path?: string[] }> },
): Promise<Response> {
  const { previewId, path: parts } = await context.params;
  return serve(async (engine, userId) => readAuthorizedPreview(engine, userId, previewId, parts ?? ["index.html"]));
}

async function serve(
  resolve: (engine: Awaited<ReturnType<typeof getEngine>>, userId: string) => Promise<{ filePath: string; contentType: string }>,
): Promise<Response> {
  const engine = await getEngine();
  const userId = await currentUserId(engine);
  if (!userId) return new Response("Sign in required.", { status: 401 });
  try {
    const file = await resolve(engine, userId);
    const info = await stat(file.filePath);
    if (!info.isFile()) return new Response("Not found.", { status: 404 });
    const bytes = await readFile(file.filePath);
    return new Response(new Uint8Array(bytes), {
      headers: { "content-type": file.contentType, "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
    });
  } catch (error) {
    if (error instanceof PortalError) return new Response("Not found.", { status: 404 });
    return new Response("Not found.", { status: 404 });
  }
}
