"use server";

import { redirect } from "next/navigation";
import { PortalError } from "@/domain/errors";
import { login } from "@/server/auth";
import { setSessionCookie } from "@/server/http";
import { getEngine } from "@/server/runtime";

export async function loginAction(formData: FormData): Promise<void> {
  const engine = await getEngine();
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  try {
    const userId = await login(engine.db, engine.env, email, password);
    await setSessionCookie(engine, userId);
  } catch (error) {
    const message = error instanceof PortalError ? error.message : "Email or password is incorrect.";
    redirect(`/login?error=${encodeURIComponent(message)}`);
  }
  redirect("/");
}
