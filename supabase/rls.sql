-- Defense in depth for Supabase Auth. Apply this file in the Supabase SQL editor
-- after the portal migrations. It is not applied to the local embedded database,
-- where the Next.js service enforces the same membership rules and tests them.
--
-- Assumption: public.users.id equals auth.uid() for signed-in client connections.
-- The portal server still authorizes every request. Do not grant the service role
-- to browsers.

alter table organizations enable row level security;
alter table users enable row level security;
alter table organization_memberships enable row level security;
alter table websites enable row level security;
alter table website_memberships enable row level security;
alter table website_provider_configs enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table attachments enable row level security;
alter table change_requests enable row level security;
alter table change_revisions enable row level security;
alter table agent_jobs enable row level security;
alter table job_steps enable row level security;
alter table deployment_previews enable row level security;
alter table approval_records enable row level security;
alter table approval_revocations enable row level security;
alter table production_deployments enable row level security;
alter table audit_events enable row level security;

create or replace function portal_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select organization_id
  from organization_memberships
  where user_id = auth.uid()
$$;

create policy organizations_member on organizations
for select to authenticated
using (id in (select portal_org_ids()));

create policy users_self on users
for select to authenticated
using (
  id = auth.uid()
  or id in (
    select user_id from organization_memberships
    where organization_id in (select portal_org_ids())
  )
);

create policy org_memberships_member on organization_memberships
for select to authenticated
using (organization_id in (select portal_org_ids()));

create policy websites_member on websites
for select to authenticated
using (organization_id in (select portal_org_ids()));

create policy website_memberships_member on website_memberships
for select to authenticated
using (
  website_id in (
    select id from websites where organization_id in (select portal_org_ids())
  )
);

create policy provider_configs_admin on website_provider_configs
for select to authenticated
using (
  website_id in (
    select w.id
    from websites w
    join organization_memberships m on m.organization_id = w.organization_id
    where m.user_id = auth.uid() and m.role in ('owner', 'admin')
  )
);

create policy conversations_member on conversations
for select to authenticated
using (organization_id in (select portal_org_ids()));

create policy messages_member on messages
for select to authenticated
using (organization_id in (select portal_org_ids()));

create policy attachments_member on attachments
for select to authenticated
using (organization_id in (select portal_org_ids()));

create policy changes_member on change_requests
for select to authenticated
using (organization_id in (select portal_org_ids()));

create policy revisions_member on change_revisions
for select to authenticated
using (organization_id in (select portal_org_ids()));

create policy jobs_member on agent_jobs
for select to authenticated
using (organization_id in (select portal_org_ids()));

create policy steps_member on job_steps
for select to authenticated
using (
  job_id in (select id from agent_jobs where organization_id in (select portal_org_ids()))
);

create policy previews_member on deployment_previews
for select to authenticated
using (organization_id in (select portal_org_ids()));

create policy approvals_member on approval_records
for select to authenticated
using (organization_id in (select portal_org_ids()));

create policy revocations_member on approval_revocations
for select to authenticated
using (
  approval_id in (select id from approval_records where organization_id in (select portal_org_ids()))
);

create policy deployments_member on production_deployments
for select to authenticated
using (organization_id in (select portal_org_ids()));

create policy audit_admin on audit_events
for select to authenticated
using (
  organization_id in (
    select organization_id from organization_memberships
    where user_id = auth.uid() and role in ('owner', 'admin')
  )
);
