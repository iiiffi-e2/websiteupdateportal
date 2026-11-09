import { redirect } from "next/navigation";
import { loginAction } from "@/app/login/actions";
import { currentUserId } from "@/server/http";
import { getEngine } from "@/server/runtime";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const engine = await getEngine();
  const userId = await currentUserId(engine);
  if (userId) redirect("/");
  const { error } = await searchParams;
  return (
    <main className="login-screen">
      <form className="login-card" action={loginAction}>
        <p className="lede">Website maintenance</p>
        <h1>Sign in</h1>
        <p className="lede">Describe a change in plain language. You will review a preview before anything is published.</p>
        {error ? <p className="alert" role="alert">{error}</p> : null}
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required />
        <button className="primary" type="submit">Sign in</button>
      </form>
    </main>
  );
}
