# Implementation status

Checked in this environment on 9 November 2026. Unit tests cover access control, state transitions, approval immutability, and the publish guards. No Supabase project, GitHub App, Claude credential, or Vercel token was available here, so those clients were not called against live services.

## Complete and exercised locally

- Next.js App Router application with a conversational website page, desktop and mobile layout, and an administration page. Playwright drives the local milestone: sign in, request a headline change, open the preview, approve it, and publish it.
- Postgres schema and migration for organizations, users, memberships, websites, provider configuration, conversations, messages, attachments, change requests, revisions, agent jobs, previews, approvals, revocations, production deployments, and audit events.
- Server-side membership checks. A person in another organization gets the same not-found response as a missing record.
- Status transitions. Illegal moves are rejected. Approval records, revocations, and audit events are immutable in the database.
- The Lumen Studio fixture can be changed from chat. The field editor writes the requested headline, tagline, phone, or accent color, commits it on a branch, and leaves `main` untouched.
- Validation runs with a scrubbed environment that does not receive portal secrets. Failed checks do not create a preview and do not publish.
- A real preview snapshot is served from the approved commit. The URL is an application route backed by those files.
- Approval records the signed-in user, website, change request, revision, commit SHA, preview id, and timestamp. Publish checks that approval, the checks, the branch tip, and the production SHA. Production drift or a moved branch blocks publishing and does not merge.
- Publish is a separate action. It merges with `--no-ff` and records the deployment. An administrator can roll the website back to the previous tree with a new commit.
- Revisions revoke the prior approval and start a new branch from production. A second request is rejected while one is open.
- Jobs carry a timeout, one automatic retry for retryable failures, a global concurrency cap, a per-website cap, and token and runtime budgets. Autonomous processing can be turned off; queued work then waits.
- Administration can create an organization, invite a user, register a website, and review failures, deployments, and audit events.
- Demo accounts and the local git repository are created on an empty database when demo seed is enabled.

## Implemented, not exercised against a live provider

- Supabase Auth password grant, including the rule that an unknown Supabase user is not given a portal account.
- Supabase Storage uploads and downloads for the private `portal-attachments` bucket when `SUPABASE_SERVICE_ROLE_KEY` is set. Local disk is used otherwise. Row-level security SQL is in `supabase/rls.sql` and is not applied to the embedded database, where the superuser connection would bypass it. The application checks are the active gate and are tested.
- GitHub App JWT, installation token, allowlist, askpass clone, and merge verification. A repository other than `GITHUB_ALLOWED_REPO` is rejected before any request.
- Claude through the Vercel AI Gateway, or directly with an Anthropic key when the gateway key is absent. The model is asked for file contents only. Proposed paths outside the allowlist are rejected. Without a key, a website set to Claude fails the job instead of inventing an edit.
- Vercel preview and production deployment requests. Publishing is rejected when Vercel does not confirm the approved commit. No preview URL is stored unless the API returns one.

## Not in this version

- Billing, WordPress, and multi-team agency administration.
- Email delivery for invitations. An administrator sets the initial password.
- Vercel Workflow as the hosted durable runner. Durability here is the Postgres job record, checkpoints, the tick route, and `npm run worker`. A crashed job can be retried from its checkpoint; it does not yet suspend inside Vercel Workflow.
- A live end-to-end run against GitHub, Claude, and Vercel. The local milestone is the path that was executed in this environment.
