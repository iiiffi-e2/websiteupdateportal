create table organizations (
  id uuid primary key,
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key,
  email text not null unique,
  name text not null,
  password_hash text,
  supabase_user_id uuid unique,
  created_at timestamptz not null default now()
);

create table organization_memberships (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  user_id uuid not null references users (id),
  role text not null check (role in ('owner', 'admin', 'member', 'client')),
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create table websites (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  name text not null,
  slug text not null,
  autonomous_enabled boolean not null default true,
  production_branch text not null default 'main',
  created_at timestamptz not null default now(),
  unique (organization_id, slug)
);

create table website_memberships (
  id uuid primary key,
  website_id uuid not null references websites (id),
  user_id uuid not null references users (id),
  role text not null check (role in ('manager', 'editor', 'approver', 'viewer')),
  created_at timestamptz not null default now(),
  unique (website_id, user_id)
);

create table website_provider_configs (
  id uuid primary key,
  website_id uuid not null unique references websites (id),
  git_provider text not null check (git_provider in ('local_git', 'github_app')),
  repository text not null,
  installation_id text,
  deploy_provider text not null check (deploy_provider in ('local_preview', 'vercel')),
  vercel_project_id text,
  vercel_team_id text,
  agent_provider text not null check (agent_provider in ('field_editor', 'claude')),
  allowed_paths jsonb not null default '[]'::jsonb,
  validation_argv jsonb not null default '[]'::jsonb,
  budget_max_tokens integer not null default 20000 check (budget_max_tokens > 0),
  budget_max_runtime_seconds integer not null default 120 check (budget_max_runtime_seconds > 0),
  max_concurrent_jobs integer not null default 1 check (max_concurrent_jobs > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table conversations (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  website_id uuid not null references websites (id),
  created_by uuid not null references users (id),
  title text not null,
  created_at timestamptz not null default now()
);

create table messages (
  id uuid primary key,
  conversation_id uuid not null references conversations (id),
  organization_id uuid not null references organizations (id),
  author_user_id uuid references users (id),
  role text not null check (role in ('user', 'assistant', 'system')),
  body text not null,
  created_at timestamptz not null default now()
);

create table attachments (
  id uuid primary key,
  message_id uuid not null references messages (id),
  organization_id uuid not null references organizations (id),
  storage_key text not null,
  filename text not null,
  content_type text not null,
  byte_size integer not null check (byte_size >= 0),
  created_at timestamptz not null default now()
);

create table change_requests (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  website_id uuid not null references websites (id),
  conversation_id uuid not null references conversations (id),
  created_by uuid not null references users (id),
  title text not null,
  status text not null check (
    status in (
      'draft',
      'queued',
      'running',
      'testing',
      'preview_ready',
      'revision_requested',
      'approved',
      'publishing',
      'published',
      'failed',
      'canceled'
    )
  ),
  base_sha text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table change_revisions (
  id uuid primary key,
  change_request_id uuid not null references change_requests (id),
  organization_id uuid not null references organizations (id),
  revision_number integer not null check (revision_number > 0),
  branch_name text not null,
  commit_sha text,
  base_sha text,
  summary text,
  diff_text text,
  validation_status text not null default 'pending' check (validation_status in ('pending', 'passed', 'failed')),
  validation_log text,
  created_at timestamptz not null default now(),
  unique (change_request_id, revision_number)
);

create table agent_jobs (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  website_id uuid not null references websites (id),
  change_request_id uuid not null references change_requests (id),
  revision_id uuid not null references change_revisions (id),
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  attempt integer not null default 0,
  max_attempts integer not null default 2 check (max_attempts > 0),
  locked_at timestamptz,
  locked_by text,
  timeout_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  token_budget integer not null,
  tokens_used integer not null default 0,
  runtime_budget_seconds integer not null,
  log text not null default '',
  checkpoint jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table job_steps (
  id uuid primary key,
  job_id uuid not null references agent_jobs (id),
  name text not null,
  status text not null check (status in ('running', 'succeeded', 'failed')),
  result jsonb not null default '{}'::jsonb,
  log text not null default '',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (job_id, name)
);

create table deployment_previews (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  website_id uuid not null references websites (id),
  change_request_id uuid not null references change_requests (id),
  revision_id uuid not null references change_revisions (id),
  provider text not null,
  external_id text,
  url text not null,
  commit_sha text not null,
  status text not null check (status in ('building', 'ready', 'failed')),
  created_at timestamptz not null default now()
);

create table approval_records (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  website_id uuid not null references websites (id),
  change_request_id uuid not null references change_requests (id),
  revision_id uuid not null unique references change_revisions (id),
  commit_sha text not null,
  deployment_id uuid not null references deployment_previews (id),
  approved_by uuid not null references users (id),
  approved_at timestamptz not null default now()
);

create table approval_revocations (
  id uuid primary key,
  approval_id uuid not null unique references approval_records (id),
  revoked_by uuid not null references users (id),
  reason text not null,
  revoked_at timestamptz not null default now()
);

create table production_deployments (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  website_id uuid not null references websites (id),
  change_request_id uuid not null references change_requests (id),
  revision_id uuid not null references change_revisions (id),
  approval_id uuid not null references approval_records (id),
  provider text not null,
  external_id text,
  commit_sha text,
  previous_sha text,
  status text not null check (status in ('publishing', 'published', 'failed', 'rolled_back')),
  url text,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create table audit_events (
  id uuid primary key,
  organization_id uuid not null references organizations (id),
  website_id uuid references websites (id),
  actor_user_id uuid references users (id),
  action text not null,
  entity_type text not null,
  entity_id uuid not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index websites_org_idx on websites (organization_id);
create index memberships_user_idx on organization_memberships (user_id);
create index website_memberships_user_idx on website_memberships (user_id);
create index messages_conversation_idx on messages (conversation_id, created_at);
create index change_requests_website_idx on change_requests (website_id, status);
create index agent_jobs_status_idx on agent_jobs (status, created_at);
create index audit_org_idx on audit_events (organization_id, created_at desc);

create or replace function portal_reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '% records are immutable', tg_table_name;
end;
$$;

create trigger approval_records_immutable
before update or delete on approval_records
for each row execute function portal_reject_mutation();

create trigger approval_revocations_immutable
before update or delete on approval_revocations
for each row execute function portal_reject_mutation();

create trigger audit_events_immutable
before update or delete on audit_events
for each row execute function portal_reject_mutation();
