import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { PortalError } from "@/domain/errors";
import { redactSecrets } from "@/domain/safety";

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 30_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = cap(stdout + chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = cap(stderr + chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function cap(value: string): string {
  return value.length > 100_000 ? value.slice(0, 100_000) : value;
}

export async function gitEnv(home: string): Promise<NodeJS.ProcessEnv> {
  await mkdir(home, { recursive: true });
  return {
    PATH: process.env.PATH,
    NODE_ENV: process.env.NODE_ENV,
    HOME: home,
    LANG: "C",
    TMPDIR: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "Website Update Portal",
    GIT_AUTHOR_EMAIL: "portal@localhost",
    GIT_COMMITTER_NAME: "Website Update Portal",
    GIT_COMMITTER_EMAIL: "portal@localhost",
    GIT_TERMINAL_PROMPT: "0",
  };
}

export function scrubbedEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    NODE_ENV: process.env.NODE_ENV,
    HOME: home,
    LANG: "C",
    TMPDIR: home,
  };
}

export async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const result = await runCommand("git", args, { cwd, env, timeoutMs: 30_000 });
  if (result.code !== 0) {
    const detail = redactSecrets(result.stderr || result.stdout || `git ${args[0]} failed`);
    throw new PortalError("git_failed", detail, {
      retryable: /lock|temporarily unavailable|cannot lock/i.test(detail),
    });
  }
  return result.stdout;
}
