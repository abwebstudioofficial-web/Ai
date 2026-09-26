-- =============================================================================
-- Site Agent: schedules (pg_cron)
-- =============================================================================
-- BEFORE running this migration, store the project URL in Supabase Vault
-- (SQL editor, run once; the schema migration already generated site_agent_internal_secret):
--
--   select vault.create_secret('https://<project-ref>.supabase.co', 'site_agent_project_url');
--
-- All times are UTC. 03:00 UTC = 08:00 in Pakistan (Asia/Karachi, UTC+5).
-- To move the morning check, change '0 3 * * *' below (e.g. '0 2 * * *' = 07:00 PKT).
-- Re-running cron.schedule with the same job name updates the existing job.
-- =============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- Morning check (08:00 PKT): rule-based checks + report to Telegram. No AI unless a NEW problem is found.
select cron.schedule(
  'site-agent-daily',
  '0 3 * * *',
  $$ select public.agent_invoke('site-agent-cron', '{"job":"daily"}'::jsonb) $$
);

-- Quick uptime / critical-rule monitor every 15 minutes (no AI unless something new breaks).
select cron.schedule(
  'site-agent-monitor',
  '*/15 * * * *',
  $$ select public.agent_invoke('site-agent-cron', '{"job":"monitor"}'::jsonb) $$
);

-- Safety net: resumes chat answers that were interrupted (e.g. an Edge Function
-- hit its time limit). Only calls the worker when there is something to do.
select cron.schedule(
  'site-agent-sweep',
  '* * * * *',
  $$
  select public.agent_invoke('site-agent-worker', '{"sweep":true}'::jsonb)
  where exists (
    select 1 from public.agent_runs
    where (status = 'queued' and queued_at < now() - interval '20 seconds')
       or (status = 'running' and lease_until < now())
  )
  $$
);

-- Housekeeping: keep history tables small.
select cron.schedule(
  'site-agent-retention',
  '30 3 * * *',
  $$
  delete from public.agent_health_checks where created_at < now() - interval '30 days';
  delete from public.agent_audit_log     where created_at < now() - interval '180 days';
  delete from public.agent_ai_calls      where created_at < now() - interval '400 days';
  delete from public.agent_notifications where created_at < now() - interval '365 days';
  update public.agent_approvals set status = 'expired'
    where status = 'pending' and created_at < now() - interval '7 days';
  $$
);
