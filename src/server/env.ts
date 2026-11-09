import path from "node:path";

export type Env = {
  nodeEnv: string;
  dataDir: string;
  databaseUrl: string | null;
  authSecret: string;
  seedDemo: boolean;
  supabaseUrl: string | null;
  supabaseAnonKey: string | null;
  supabaseServiceRoleKey: string | null;
  githubAppId: string | null;
  githubAppPrivateKey: string | null;
  githubInstallationId: string | null;
  githubAllowedRepo: string | null;
  localAllowedRepo: string;
  deployProvider: "local_preview" | "vercel";
  vercelToken: string | null;
  vercelTeamId: string | null;
  aiGatewayApiKey: string | null;
  anthropicApiKey: string | null;
  aiModel: string;
  aiGatewayModel: string;
  jobTickSecret: string | null;
  jobGlobalConcurrency: number;
  bootstrapAdminEmail: string | null;
  bootstrapAdminPassword: string | null;
  bootstrapOrgName: string;
};

export function readEnv(source: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Env {
  const nodeEnv = source.NODE_ENV ?? "development";
  const deploy = source.DEPLOY_PROVIDER ?? "local_preview";
  if (deploy !== "local_preview" && deploy !== "vercel") {
    throw new Error("DEPLOY_PROVIDER must be local_preview or vercel.");
  }
  const authSecret = source.AUTH_SECRET?.trim() || (nodeEnv === "production" ? "" : "dev-only-auth-secret-change-me");
  if (!authSecret) {
    throw new Error("AUTH_SECRET is required in production.");
  }
  const concurrency = Number(source.JOB_GLOBAL_CONCURRENCY ?? "2");
  return {
    nodeEnv,
    dataDir: path.resolve(cwd, source.DATA_DIR ?? ".data"),
    databaseUrl: blankToNull(source.DATABASE_URL),
    authSecret,
    seedDemo: source.SEED_DEMO ? source.SEED_DEMO !== "false" : nodeEnv !== "production",
    supabaseUrl: blankToNull(source.SUPABASE_URL),
    supabaseAnonKey: blankToNull(source.SUPABASE_ANON_KEY),
    supabaseServiceRoleKey: blankToNull(source.SUPABASE_SERVICE_ROLE_KEY),
    githubAppId: blankToNull(source.GITHUB_APP_ID),
    githubAppPrivateKey: source.GITHUB_APP_PRIVATE_KEY?.replaceAll("\\n", "\n") ?? null,
    githubInstallationId: blankToNull(source.GITHUB_INSTALLATION_ID),
    githubAllowedRepo: blankToNull(source.GITHUB_ALLOWED_REPO),
    localAllowedRepo: source.LOCAL_ALLOWED_REPO?.trim() || "lumen-studio",
    deployProvider: deploy,
    vercelToken: blankToNull(source.VERCEL_TOKEN),
    vercelTeamId: blankToNull(source.VERCEL_TEAM_ID),
    aiGatewayApiKey: blankToNull(source.AI_GATEWAY_API_KEY),
    anthropicApiKey: blankToNull(source.ANTHROPIC_API_KEY),
    aiModel: source.AI_MODEL?.trim() || "claude-sonnet-5-5",
    aiGatewayModel: source.AI_GATEWAY_MODEL?.trim() || "anthropic/claude-sonnet-5.5",
    jobTickSecret: blankToNull(source.JOB_TICK_SECRET),
    jobGlobalConcurrency: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 2,
    bootstrapAdminEmail: blankToNull(source.BOOTSTRAP_ADMIN_EMAIL),
    bootstrapAdminPassword: blankToNull(source.BOOTSTRAP_ADMIN_PASSWORD),
    bootstrapOrgName: source.BOOTSTRAP_ORG_NAME?.trim() || "Agency",
  };
}

function blankToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function authorizeTick(header: string | null, secret: string | null): boolean {
  if (!secret || !header) return false;
  return header === `Bearer ${secret}`;
}
