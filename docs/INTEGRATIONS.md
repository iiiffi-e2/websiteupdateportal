# Integration setup

The portal runs the full request, preview, approval, and publish workflow without these services by using the local adapters. Connect a service only when you are ready for that provider. Credentials belong in the server environment, never in browser code, prompts, or logs.

## Supabase Auth, Postgres, and Storage

1. Create a Supabase project.
2. Apply `supabase/migrations/20261109120000_init.sql` with the Supabase SQL editor or CLI.
3. Apply `supabase/rls.sql` afterward. It expects `public.users.id` to equal `auth.uid()` for browser connections. The Next.js server still authorizes every request; row-level security is a second layer for direct database clients.
4. Set `DATABASE_URL` to the pooler connection string.
5. Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` to move login to Supabase Auth. Invited people must already exist in `users`. A successful Supabase login does not create a portal account.
6. Create a private Storage bucket named `portal-attachments`. Set `SUPABASE_SERVICE_ROLE_KEY` only on the server. Attachments are then uploaded and read with that key. When the key is absent, files stay under `DATA_DIR/attachments`. The browser never receives the service role key.

Create the first administrator with `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD`, then invite everyone else from Administration. Turn `SEED_DEMO` off outside local development.

## GitHub App

1. Create a GitHub App that can read and write contents on one repository.
2. Install it on that repository only.
3. Set `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PEM, with literal `\n` newlines if the host requires one line), `GITHUB_INSTALLATION_ID`, and `GITHUB_ALLOWED_REPO` as `owner/name`.
4. Register the website with the GitHub provider and that exact repository. Any other repository is rejected before a token request or clone.

The worker clones with `GIT_ASKPASS` so the installation token is not placed in the git remote URL. Publishing merges the approved commit through the GitHub merges API and rejects a result that does not contain that commit.

## Claude

Set `AI_GATEWAY_API_KEY` and keep `AI_GATEWAY_MODEL=anthropic/claude-sonnet-5.5`. On Vercel, the AI Gateway can also authenticate with its OIDC token. If the gateway key is absent and `ANTHROPIC_API_KEY` is set, the server calls Claude directly with `AI_MODEL` (default `claude-sonnet-5-5`).

The model receives an allowlisted file snapshot and the client message inside untrusted wrappers. It returns proposed file contents. The worker, not the model, decides which paths may be written. A website stays on the field editor until an administrator selects Claude. If Claude is selected and neither credential is present, the job fails and says so.

## Vercel deployments

1. Set `DEPLOY_PROVIDER=vercel`.
2. Set `VERCEL_TOKEN` and, for a team project, `VERCEL_TEAM_ID`.
3. Register the website with the Vercel provider and its project id. The repository must be the allowlisted GitHub repository connected to that project.

Preview and production deployments are created through the Vercel deployments API. A production deployment is rejected when the response does not confirm the approved commit. The local preview provider is a separate, real snapshot served by this app; it is not a stand-in URL for Vercel.

## Jobs

`POST /api/jobs/tick` with `Authorization: Bearer $JOB_TICK_SECRET` runs due work. The request page also runs due work after someone sends, revises, or retries a change. For a process that outlives a request, run `npm run worker`.

Jobs have a per-website concurrency limit, a global limit (`JOB_GLOBAL_CONCURRENCY`), a runtime budget, a token budget, and one automatic retry for retryable failures such as a timeout. Validation failures and policy failures are not retried until an administrator presses Retry.
