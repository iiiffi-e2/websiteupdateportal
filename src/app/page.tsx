import { redirect } from "next/navigation";
import { websitesFor } from "@/server/engine";
import { currentUserId } from "@/server/http";
import { getEngine } from "@/server/runtime";
import { isOrgAdmin } from "@/server/view";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const engine = await getEngine();
  const userId = await currentUserId(engine);
  if (!userId) redirect("/login");
  const sites = await websitesFor(engine, userId);
  if (sites[0]) redirect(`/portal/${sites[0].id}`);
  if (await isOrgAdmin(engine, userId)) redirect("/admin");
  redirect("/login?error=No%20website%20is%20assigned%20to%20this%20account.");
}
