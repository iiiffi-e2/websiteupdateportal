import { readFile, stat } from "node:fs/promises";
import { readAuthorizedProduction } from "@/server/engine";
import { currentUserId } from "@/server/http";
import { getEngine } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ websiteId: string; path?: string[] }> },
): Promise<Response> {
  const { websiteId, path: parts } = await context.params;
  const engine = await getEngine();
  const userId = await currentUserId(engine);
  if (!userId) return new Response("Sign in required.", { status: 401 });
  try {
    const file = await readAuthorizedProduction(engine, userId, websiteId, parts ?? ["index.html"]);
    const info = await stat(file.filePath);
    if (!info.isFile()) return new Response("Not found.", { status: 404 });
    const bytes = await readFile(file.filePath);
    return new Response(new Uint8Array(bytes), {
      headers: { "content-type": file.contentType, "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
    });
  } catch {
    return new Response("Not found.", { status: 404 });
  }
}
