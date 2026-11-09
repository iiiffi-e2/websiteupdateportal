import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PortalError } from "@/domain/errors";
import { git, gitEnv, runCommand, scrubbedEnv } from "@/server/process";

export class LocalGitWorkspace {
  private envPromise: Promise<NodeJS.ProcessEnv> | null = null;

  constructor(
    readonly repoPath: string,
    readonly productionBranch: string,
    private readonly home: string,
  ) {}

  private environment(): Promise<NodeJS.ProcessEnv> {
    this.envPromise ??= gitEnv(this.home);
    return this.envPromise;
  }

  async productionSha(): Promise<string> {
    const env = await this.environment();
    return (await git(this.repoPath, ["rev-parse", this.productionBranch], env)).trim();
  }

  async prepare(branch: string, workdir: string): Promise<{ workdir: string; baseSha: string }> {
    const env = await this.environment();
    await rm(workdir, { recursive: true, force: true });
    await mkdir(path.dirname(workdir), { recursive: true });
    const existing = await runCommand("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: this.repoPath,
      env,
    });
    if (existing.code === 0) {
      await git(this.repoPath, ["worktree", "add", "--force", workdir, branch], env);
    } else {
      await git(this.repoPath, ["worktree", "add", "-b", branch, workdir, this.productionBranch], env);
    }
    const baseSha = (await git(this.repoPath, ["merge-base", branch, this.productionBranch], env)).trim();
    return { workdir, baseSha };
  }

  async read(workdir: string, paths: readonly string[]): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    for (const rel of paths) {
      files[rel] = await readFile(path.join(workdir, rel), "utf8");
    }
    return files;
  }

  async write(workdir: string, files: Record<string, string>): Promise<void> {
    for (const [rel, content] of Object.entries(files)) {
      const destination = path.join(workdir, rel);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }
  }

  async commit(workdir: string, message: string, paths: readonly string[]): Promise<string> {
    const env = await this.environment();
    await git(workdir, ["add", "--", ...paths], env);
    const status = await git(workdir, ["status", "--porcelain"], env);
    if (!status.trim()) {
      throw new PortalError("edit_failed", "The editor did not change any files.");
    }
    await git(workdir, ["commit", "-m", sanitizeMessage(message)], env);
    return (await git(workdir, ["rev-parse", "HEAD"], env)).trim();
  }

  async diff(workdir: string, baseSha: string): Promise<string> {
    const env = await this.environment();
    return git(workdir, ["diff", "--no-ext-diff", `${baseSha}..HEAD`], env);
  }

  async tip(workdir: string): Promise<string> {
    const env = await this.environment();
    return (await git(workdir, ["rev-parse", "HEAD"], env)).trim();
  }

  async branchTip(branch: string): Promise<string> {
    const env = await this.environment();
    return (await git(this.repoPath, ["rev-parse", branch], env)).trim();
  }

  async merge(branch: string, commitSha: string, baseSha: string): Promise<{ sha: string }> {
    const env = await this.environment();
    const production = (await git(this.repoPath, ["rev-parse", this.productionBranch], env)).trim();
    if (production !== baseSha) {
      throw new PortalError(
        "production_moved",
        "Production changed after this preview was created. Request a revision before publishing.",
      );
    }
    const tip = (await git(this.repoPath, ["rev-parse", branch], env)).trim();
    if (tip !== commitSha) {
      throw new PortalError("revision_moved", "The branch no longer matches the approved commit. Request a revision.");
    }
    const mergeBase = (await git(this.repoPath, ["merge-base", branch, this.productionBranch], env)).trim();
    if (mergeBase !== baseSha) {
      throw new PortalError("production_moved", "The change conflicts with production. Request a revision.");
    }
    try {
      await git(this.repoPath, ["merge", "--no-ff", "--no-edit", branch, "-m", sanitizeMessage(`Publish ${commitSha}`)], env);
    } catch (error) {
      await runCommand("git", ["merge", "--abort"], { cwd: this.repoPath, env }).catch(() => undefined);
      throw error;
    }
    const ancestor = await runCommand("git", ["merge-base", "--is-ancestor", commitSha, this.productionBranch], {
      cwd: this.repoPath,
      env,
    });
    if (ancestor.code !== 0) {
      throw new PortalError("deploy_unconfirmed", "The merge did not contain the approved commit. Publishing was rejected.");
    }
    const sha = (await git(this.repoPath, ["rev-parse", this.productionBranch], env)).trim();
    return { sha };
  }

  async rollback(previousSha: string): Promise<{ sha: string }> {
    const env = await this.environment();
    await git(this.repoPath, ["checkout", this.productionBranch], env);
    await git(this.repoPath, ["checkout", previousSha, "--", "."], env);
    await git(this.repoPath, ["commit", "-m", sanitizeMessage(`Rollback to ${previousSha}`)], env);
    const sha = (await git(this.repoPath, ["rev-parse", "HEAD"], env)).trim();
    return { sha };
  }

  async validateCommand(workdir: string, argv: readonly string[]): Promise<{ code: number; log: string }> {
    if (argv.length === 0) return { code: 0, log: "" };
    const [command, ...args] = argv;
    if (!command || command.includes("/") || command.includes("\\")) {
      throw new PortalError("validation_failed", "Validation commands must be executable names, not paths.");
    }
    const env = scrubbedEnv(this.home);
    const result = await runCommand(command, [...args], { cwd: workdir, env, timeoutMs: 30_000 });
    return { code: result.code, log: `${result.stdout}\n${result.stderr}`.trim() };
  }

  async removeWorktree(workdir: string): Promise<void> {
    const env = await this.environment();
    await runCommand("git", ["worktree", "remove", "--force", workdir], { cwd: this.repoPath, env }).catch(() => undefined);
    await rm(workdir, { recursive: true, force: true });
  }
}

export async function initWebsiteRepo(templateDir: string, dest: string, home: string): Promise<void> {
  const { cp } = await import("node:fs/promises");
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  await cp(templateDir, dest, { recursive: true });
  const env = await gitEnv(home);
  await git(dest, ["init", "-b", "main"], env);
  await git(dest, ["add", "index.html", "styles.css"], env);
  await git(dest, ["commit", "-m", "Initial site"], env);
}

function sanitizeMessage(message: string): string {
  return message.replace(/[\r\n\0]/g, " ").slice(0, 200);
}
