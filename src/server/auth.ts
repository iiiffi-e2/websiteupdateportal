import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { PortalError } from "@/domain/errors";
import type { Db } from "@/server/db";
import type { Env } from "@/server/env";

const scrypt = promisify(scryptCallback);

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("base64url");
  const key = (await scrypt(password, salt, 32)) as Buffer;
  return `scrypt$${salt}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  const key = (await scrypt(password, salt, 32)) as Buffer;
  const expected = Buffer.from(hash, "base64url");
  if (key.length !== expected.length) return false;
  return timingSafeEqual(key, expected);
}

export function sealSession(userId: string, secret: string, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ sub: userId, exp: now + 14 * 24 * 60 * 60 * 1000 })).toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

export function openSession(token: string, secret: string, now = Date.now()): { sub: string } | null {
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = sign(body, secret);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { sub?: unknown; exp?: unknown };
    if (typeof parsed.sub !== "string" || typeof parsed.exp !== "number" || parsed.exp < now) return null;
    return { sub: parsed.sub };
  } catch {
    return null;
  }
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

type UserRecord = {
  id: string;
  email: string;
  password_hash: string | null;
  supabase_user_id: string | null;
};

export async function login(db: Db, env: Env, email: string, password: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const normalized = email.trim().toLowerCase();
  if (env.supabaseUrl && env.supabaseAnonKey) {
    const remote = await supabasePasswordGrant(env.supabaseUrl, env.supabaseAnonKey, normalized, password, fetchImpl);
    const users = await db.query<UserRecord>(
      "select id, email, password_hash, supabase_user_id from users where email = $1 or supabase_user_id = $2",
      [normalized, remote.id],
    );
    const user = users[0];
    if (!user) {
      throw new PortalError("not_invited", "This account has not been invited.");
    }
    if (user.supabase_user_id !== remote.id) {
      await db.query("update users set supabase_user_id = $1 where id = $2", [remote.id, user.id]);
    }
    return user.id;
  }
  const users = await db.query<UserRecord>(
    "select id, email, password_hash, supabase_user_id from users where email = $1",
    [normalized],
  );
  const user = users[0];
  if (!user?.password_hash || !(await verifyPassword(password, user.password_hash))) {
    throw new PortalError("unauthorized", "Email or password is incorrect.");
  }
  return user.id;
}

export async function supabasePasswordGrant(
  url: string,
  anonKey: string,
  email: string,
  password: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; email: string }> {
  const response = await fetchImpl(`${url.replace(/\/$/, "")}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    throw new PortalError("unauthorized", "Email or password is incorrect.");
  }
  const body = (await response.json()) as { user?: { id?: unknown; email?: unknown } };
  if (typeof body.user?.id !== "string") {
    throw new PortalError("unauthorized", "Email or password is incorrect.");
  }
  return { id: body.user.id, email: typeof body.user.email === "string" ? body.user.email : email };
}
