import { createSign, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateText, Output } from "ai";
import { z } from "zod";
import { applyFieldEdit, parseFieldEdit } from "@/domain/fields";
import { PortalError } from "@/domain/errors";
import { applyProposedEdits, buildAgentPrompt, redactSecrets } from "@/domain/safety";
import type { Env } from "@/server/env";

export type EditRequest = {
  request: string;
  files: Record<string, string>;
  allow: string[];
  tokenBudget: number;
  attachmentText?: string;
};

export type EditResult = {
  files: Record<string, string>;
  tokensUsed: number;
  summary: string;
};

export interface CodingAgent {
  edit(input: EditRequest): Promise<EditResult>;
}

export const fieldEditorAgent: CodingAgent = {
  async edit(input) {
    const parsed = parseFieldEdit(input.request);
    if (!parsed) {
      throw new PortalError(
        "unsupported_request",
        "This website's editor can update the headline, tagline, phone number, or accent color when the request says exactly what to change. Open-ended edits need the Claude agent, which is not selected for this website.",
      );
    }
    for (const file of parsed.field === "accent" ? ["styles.css"] : ["index.html"]) {
      if (!input.allow.includes(file)) {
        throw new PortalError("path_rejected", `The ${file} file is not on this website's allowlist.`);
      }
    }
    const applied = applyFieldEdit(input.files, parsed);
    return { files: applied.files, tokensUsed: 0, summary: applied.summary };
  },
};

const editSchema = z.object({
  files: z.array(z.object({ path: z.string(), content: z.string() })).max(8),
});

export function createClaudeAgent(env: Env): CodingAgent {
  return {
    async edit(input) {
      const model = await resolveModel(env);
      if (!model) {
        throw new PortalError(
          "ai_not_configured",
          "Claude is not configured. Set AI_GATEWAY_API_KEY or ANTHROPIC_API_KEY. The request was not executed.",
        );
      }
      const prompt = buildAgentPrompt({
        request: input.request,
        files: Object.entries(input.files).map(([filePath, content]) => ({ path: filePath, content })),
        attachmentText: input.attachmentText,
      });
      const maxOutputTokens = Math.min(Math.max(input.tokenBudget, 1), 8000);
      const result = await generateText({
        model,
        instructions: prompt.system,
        prompt: prompt.user,
        maxOutputTokens,
        output: Output.object({ schema: editSchema }),
      });
      if (!result.output) {
        throw new PortalError("ai_failed", "Claude did not return a file edit.");
      }
      const files = applyProposedEdits(input.files, result.output.files, input.allow);
      const usage = result.usage;
      const tokensUsed = usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      const changed = result.output.files.map((file) => file.path);
      return {
        files,
        tokensUsed,
        summary: changed.length > 0 ? `Updated ${changed.join(", ")}.` : "Claude proposed no file changes.",
      };
    },
  };
}

async function resolveModel(env: Env): Promise<string | import("ai").LanguageModel | null> {
  if (env.aiGatewayApiKey || process.env.VERCEL_OIDC_TOKEN) return env.aiGatewayModel;
  if (!env.anthropicApiKey) return null;
  const { createAnthropic } = await import("@ai-sdk/anthropic");
  return createAnthropic({ apiKey: env.anthropicApiKey })(env.aiModel);
}

export function assertAllowedRepository(repository: string, allowed: string | null, provider: string): void {
  if (!allowed || repository !== allowed) {
    throw new PortalError(
      "repo_not_allowlisted",
      `${provider} rejected ${repository}. The portal is configured for a single allowlisted repository.`,
    );
  }
}

export function createGitHubAppJwt(appId: string, privateKeyPem: string, now = Date.now()): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iat: Math.floor(now / 1000) - 60,
      exp: Math.floor(now / 1000) + 9 * 60,
      iss: appId,
    }),
  );
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${base64Url(signer.sign(privateKeyPem))}`;
}

export function githubHttpsRemote(repository: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new PortalError("repo_not_allowlisted", "The repository name is not a GitHub owner/name.");
  }
  return `https://github.com/${repository}.git`;
}

export async function githubAskpassEnv(token: string, home: string): Promise<NodeJS.ProcessEnv> {
  await mkdir(home, { recursive: true });
  const script = path.join(home, "askpass.sh");
  await writeFile(script, "#!/bin/sh\nprintf '%s\\n' \"$GIT_TOKEN\"\n", { mode: 0o700 });
  return {
    PATH: process.env.PATH,
    NODE_ENV: process.env.NODE_ENV,
    HOME: home,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: script,
    GIT_TOKEN: token,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
}

export type GitHubMergeResponse = {
  sha?: string;
  parents?: { sha: string }[];
};

export function assertApprovedMerge(merge: GitHubMergeResponse, approvedSha: string): string {
  if (!merge.sha) {
    throw new PortalError("deploy_unconfirmed", "GitHub did not return a merge commit.");
  }
  const parents = merge.parents?.map((parent) => parent.sha) ?? [];
  if (merge.sha !== approvedSha && !parents.includes(approvedSha)) {
    throw new PortalError(
      "deploy_unconfirmed",
      "GitHub merge did not contain the approved commit. Publishing was rejected.",
    );
  }
  return merge.sha;
}

export async function requestInstallationToken(
  env: Env,
  repository: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  assertAllowedRepository(repository, env.githubAllowedRepo, "GitHub");
  if (!env.githubAppId || !env.githubAppPrivateKey || !env.githubInstallationId) {
    throw new PortalError("github_not_configured", "The GitHub App is not configured. The repository was not contacted.");
  }
  const jwt = createGitHubAppJwt(env.githubAppId, env.githubAppPrivateKey);
  const response = await fetchImpl(
    `https://api.github.com/app/installations/${encodeURIComponent(env.githubInstallationId)}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "website-update-portal",
      },
    },
  );
  if (!response.ok) {
    throw new PortalError("github_auth", `GitHub refused the installation token request (${response.status}).`);
  }
  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== "string" || !body.token) {
    throw new PortalError("github_auth", "GitHub did not return an installation token.");
  }
  return body.token;
}

export async function mergeOnGitHub(input: {
  env: Env;
  repository: string;
  productionBranch: string;
  approvedSha: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  assertAllowedRepository(input.repository, input.env.githubAllowedRepo, "GitHub");
  const response = await (input.fetchImpl ?? fetch)(`https://api.github.com/repos/${input.repository}/merges`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "website-update-portal",
    },
    body: JSON.stringify({
      base: input.productionBranch,
      head: input.approvedSha,
      commit_message: `Publish ${input.approvedSha}`,
    }),
  });
  if (response.status === 204) return input.approvedSha;
  if (!response.ok) {
    const detail = redactSecrets(await response.text()).slice(0, 300);
    throw new PortalError("github_merge_failed", `GitHub merge failed (${response.status}). ${detail}`);
  }
  return assertApprovedMerge((await response.json()) as GitHubMergeResponse, input.approvedSha);
}

export type VercelDeploymentBody = {
  id?: string;
  url?: string;
  meta?: { githubCommitSha?: string };
  gitSource?: { sha?: string; ref?: string };
};

export function assertVercelDeployment(body: VercelDeploymentBody, approvedSha: string): { externalId: string; url: string } {
  if (!body.id || !body.url) {
    throw new PortalError("deploy_unconfirmed", "Vercel did not return a deployment.");
  }
  const confirmed =
    body.meta?.githubCommitSha || body.gitSource?.sha || (body.gitSource?.ref === approvedSha ? approvedSha : null);
  if (confirmed !== approvedSha) {
    throw new PortalError(
      "deploy_unconfirmed",
      "Vercel did not confirm the deployment is the approved commit. Publishing was rejected.",
    );
  }
  return {
    externalId: body.id,
    url: body.url.startsWith("http") ? body.url : `https://${body.url}`,
  };
}

export async function createVercelDeployment(input: {
  env: Env;
  projectId: string;
  teamId?: string | null;
  repository: string;
  ref: string;
  target: "preview" | "production";
  fetchImpl?: typeof fetch;
}): Promise<{ externalId: string; url: string }> {
  if (!input.env.vercelToken) {
    throw new PortalError("vercel_not_configured", "Vercel is not configured. No deployment was created.");
  }
  if (input.env.deployProvider !== "vercel") {
    throw new PortalError("deploy_rejected", "The configured deployment provider is not Vercel.");
  }
  const [owner, repo] = input.repository.split("/");
  if (!owner || !repo) {
    throw new PortalError("repo_not_allowlisted", "Vercel deploys require a GitHub owner/name repository.");
  }
  const team = input.teamId ?? input.env.vercelTeamId;
  const query = team ? `?teamId=${encodeURIComponent(team)}` : "";
  const response = await (input.fetchImpl ?? fetch)(`https://api.vercel.com/v13/deployments${query}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.env.vercelToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: repo,
      project: input.projectId,
      target: input.target,
      gitSource: { type: "github", org: owner, repo, ref: input.ref },
    }),
  });
  if (!response.ok) {
    const detail = redactSecrets(await response.text(), [input.env.vercelToken]).slice(0, 300);
    throw new PortalError("vercel_failed", `Vercel deployment failed (${response.status}). ${detail}`);
  }
  return assertVercelDeployment((await response.json()) as VercelDeploymentBody, input.ref);
}

export function newStorageName(): string {
  return randomBytes(16).toString("hex");
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}
