# Website Update Portal

A maintenance desk for website owners. A client describes a change in conversation, the portal edits an allowlisted repository on a branch, runs checks, and opens a preview. Nothing reaches production until that person approves the exact preview and chooses Publish.

The repository started as a title-only README. This is the first working version.

## Local setup

Requirements: Node.js 22, npm, and git.

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open http://127.0.0.1:3000 and sign in with the demo accounts:

| Person | Email | Password | Can |
| --- | --- | --- | --- |
| Administrator | admin@northwind.test | Harbor-Admin-1 | Manage the organization and roll back |
| Client | client@northwind.test | Harbor-Client-1 | Request, approve, and publish Lumen Studio |

The demo website is `examples/lumen-studio`. On first boot it is copied to `.data/repos/lumen-studio` and initialized as its own git repository. Ask for a specific field change, for example `Change the headline to Summer Hours`. The field editor can update the headline, tagline, phone number, and accent color. Approve the preview, then publish. The published files are served from the production snapshot for that website.

Without `DATABASE_URL`, data is stored in embedded Postgres under `.data/pglite`. Set `SEED_DEMO=false` when you do not want the demo accounts.

## Tests

```bash
npm test
npm run typecheck
npx playwright install chromium
npm run test:e2e
```

## Jobs

The page runs a queued change after it is submitted. A separate worker is available for work that should continue outside the request:

```bash
npm run worker
```

## Documentation

- [Integration setup](docs/INTEGRATIONS.md) for Supabase, GitHub, Claude, and Vercel.
- [Implementation status](docs/STATUS.md) for what is complete and what is not connected in this environment.

## Architecture

Organizations, memberships, websites, conversations, change requests, revisions, jobs, previews, approvals, deployments, and audit events live in Postgres. Every client request is checked against organization and website membership. Change status moves only through the server-side transition map. Approval rows, revocations, and audit events cannot be updated or deleted.

The coding agent, git host, and deployment host are separate interfaces. This build ships a field editor, a Claude agent, a local git workspace, a GitHub App client, a local preview server, and a Vercel deployment client. One environment variable allowlists a single local repository, and another allowlists a single GitHub repository. The deployment provider is also a single configured choice. A website that does not match those settings fails closed.
