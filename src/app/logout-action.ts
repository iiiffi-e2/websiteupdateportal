"use server";

import { redirect } from "next/navigation";
import { clearSessionCookie } from "@/server/http";

export async function logoutAction(): Promise<void> {
  await clearSessionCookie();
  redirect("/login");
}
