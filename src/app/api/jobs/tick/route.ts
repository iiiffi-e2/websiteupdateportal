import { processDue } from "@/server/engine";
import { authorizeTick } from "@/server/env";
import { getEngine } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const engine = await getEngine();
  if (!authorizeTick(request.headers.get("authorization"), engine.env.jobTickSecret)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await processDue(engine);
  return Response.json(result);
}
