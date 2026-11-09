import { cookies } from "next/headers";
import { openSession, sealSession } from "@/server/auth";
import type { Engine } from "@/server/engine";

export const SESSION_COOKIE = "wup_session";

export async function currentUserId(engine: Engine): Promise<string | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = openSession(token, engine.env.authSecret);
  if (!session) return null;
  const rows = await engine.db.query<{ id: string }>("select id from users where id = $1", [session.sub]);
  return rows[0]?.id ?? null;
}

export async function setSessionCookie(engine: Engine, userId: string): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, sealSession(userId, engine.env.authSecret), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: engine.env.nodeEnv === "production",
    maxAge: 14 * 24 * 60 * 60,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}
