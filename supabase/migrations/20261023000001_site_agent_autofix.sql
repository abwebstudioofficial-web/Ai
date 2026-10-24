-- =============================================================================
-- Site Agent: browser error catcher + automatic small UI fixes
-- =============================================================================
-- New tables only; existing Site Agent tables just get wider CHECK lists.
-- Nothing here touches the app's business tables.
-- =============================================================================

-- Browser errors reported by the site's error catcher (via the site-agent-errors
-- Edge Function - the browser never writes to this table directly). One row per
-- distinct error ("fingerprint"); repeats only bump the counters.
create table if not exists public.agent_site_errors (
  id             bigint generated always as identity primary key,
  fingerprint    text not null unique,
  kind           text not null check (kind in ('error', 'unhandledrejection', 'console.error', 'resource')),
  message        text not null,
  source         text,           -- script URL (query/hash removed)
  line           integer,
  col            integer,
  stack          text,
  page           text,           -- path only, e.g. /logistix/
  user_agent     text,
  occurrences    integer not null default 1,
  sessions       text[] not null default '{}',   -- random per-tab ids (max 20), to count distinct visits
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  -- new -> fixing -> fixed | needs_human | ignored; fixed -> regressed if it shows up again after the fix
  status         text not null default 'new'
                 check (status in ('new', 'fixing', 'fixed', 'regressed', 'needs_human', 'ignored')),
  status_note    text,
  fixed_at       timestamptz,
  emailed_at     timestamptz
);
create index if not exists agent_site_errors_status_idx on public.agent_site_errors (status, last_seen_at desc);

-- One row per automatic fix attempt (the AI investigation, its pull request, the
-- site check on GitHub, the merge, and the email to the developer).
create table if not exists public.agent_autofixes (
  id               bigint generated always as identity primary key,
  error_id         bigint references public.agent_site_errors (id) on delete set null,
  run_id           uuid,
  status           text not null default 'investigating'
                   check (status in ('investigating', 'checking', 'finalizing', 'merged', 'needs_approval',
                                     'failed', 'gave_up')),
  auto_merge       boolean not null default false,   -- false = the change needs the developer's approval
  blocked_reasons  text[] not null default '{}',     -- why it can't be merged automatically
  broken           text,                             -- what was broken (plain words)
  change           text,                             -- what was changed (plain words)
  lines_changed    integer,
  branch           text,
  pr_number        integer,
  pr_url           text,
  base_sha         text,
  head_sha         text,
  merged_sha       text,
  check_state      text,                             -- last seen state of the "site-check" GitHub check
  note             text,
  emailed_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists agent_autofixes_status_idx on public.agent_autofixes (status, created_at desc);

-- Wider CHECK lists for the existing tables.
alter table public.agent_runs drop constraint if exists agent_runs_kind_check;
alter table public.agent_runs add constraint agent_runs_kind_check check (kind in ('chat', 'autofix'));
alter table public.agent_ai_calls drop constraint if exists agent_ai_calls_purpose_check;
alter table public.agent_ai_calls add constraint agent_ai_calls_purpose_check
  check (purpose in ('chat', 'explain_problems', 'autofix'));
alter table public.agent_notifications drop constraint if exists agent_notifications_kind_check;
alter table public.agent_notifications add constraint agent_notifications_kind_check
  check (kind in ('alert', 'report', 'approval', 'recovery', 'system', 'autofix'));

-- Same access rules as the other agent tables: admins may read, only the functions write.
do $$
declare
  t text;
begin
  foreach t in array array['agent_site_errors', 'agent_autofixes'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "agent admins can read" on public.%I', t);
    execute format(
      'create policy "agent admins can read" on public.%I for select to authenticated using (public.agent_is_admin(auth.uid()))',
      t
    );
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end
$$;

-- Emails are now sent once per problem, and "Recovered" only for problems that were
-- emailed. Problems that are open right now were already in the (emailed) morning
-- reports, so count them as emailed.
update public.agent_alerts set notified_at = coalesce(notified_at, first_seen_at) where status <> 'resolved';

-- Old reports stay in agent_notifications as history; error rows older than 90 days go.
select cron.schedule(
  'site-agent-retention',
  '30 3 * * *',
  $$
  delete from public.agent_health_checks where created_at < now() - interval '30 days';
  delete from public.agent_audit_log     where created_at < now() - interval '180 days';
  delete from public.agent_ai_calls      where created_at < now() - interval '400 days';
  delete from public.agent_notifications where created_at < now() - interval '365 days';
  delete from public.agent_site_errors   where last_seen_at < now() - interval '90 days' and status in ('ignored', 'fixed', 'needs_human');
  update public.agent_approvals set status = 'expired'
    where status = 'pending' and created_at < now() - interval '7 days';
  $$
);
