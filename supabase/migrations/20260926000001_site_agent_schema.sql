-- =============================================================================
-- Site Agent: tables, security, helpers and starter watch rules
-- =============================================================================
-- Safe to re-run: every object is created with IF NOT EXISTS / OR REPLACE and
-- seed rows use ON CONFLICT DO NOTHING.
--
-- Nothing in here touches your existing business tables. The agent only READS
-- them (through watch rules and the agent_container_view helper view).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Settings (single source of truth for the business timezone)
-- -----------------------------------------------------------------------------
create table if not exists public.agent_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

insert into public.agent_settings (key, value) values
  ('timezone', '"Asia/Karachi"'::jsonb)
on conflict (key) do nothing;

-- "Today" in the business timezone. Watch rules use this instead of current_date
-- (the database itself runs in UTC).
create or replace function public.agent_today()
returns date
language sql
stable
set search_path = ''
as $$
  select (now() at time zone coalesce(
    (select value #>> '{}' from public.agent_settings where key = 'timezone'),
    'UTC'
  ))::date
$$;

-- -----------------------------------------------------------------------------
-- Who is allowed to use the agent
-- -----------------------------------------------------------------------------
-- Anyone listed here is an agent admin. In addition, agent_is_admin() also
-- accepts users that your app already treats as admins (profiles.role = 'admin'
-- or user_roles.role = 'admin') when those tables exist.
create table if not exists public.agent_admins (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now()
);

create or replace function public.agent_is_admin(uid uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  found boolean := false;
begin
  if uid is null then
    return false;
  end if;

  if exists (select 1 from public.agent_admins where user_id = uid) then
    return true;
  end if;

  if to_regclass('public.profiles') is not null then
    execute 'select exists (select 1 from public.profiles where id = $1 and role::text = ''admin'')'
      into found using uid;
    if found then return true; end if;
  end if;

  if to_regclass('public.user_roles') is not null then
    execute 'select exists (select 1 from public.user_roles where user_id = $1 and role::text = ''admin'')'
      into found using uid;
    if found then return true; end if;
  end if;

  return false;
end;
$$;

revoke all on function public.agent_is_admin(uuid) from public, anon;
grant execute on function public.agent_is_admin(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Conversations, messages and runs
-- -----------------------------------------------------------------------------
create table if not exists public.agent_conversations (
  id           uuid primary key default gen_random_uuid(),
  title        text not null default 'New conversation',
  source       text not null default 'web' check (source in ('web', 'telegram', 'system')),
  external_id  text,                       -- e.g. Telegram chat id
  created_by   uuid references auth.users (id) on delete set null,
  archived     boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists agent_conversations_updated_idx on public.agent_conversations (updated_at desc);
create index if not exists agent_conversations_external_idx on public.agent_conversations (source, external_id);

-- One row per API-level message. `content` holds the exact content blocks sent to
-- / received from the Claude API (text, tool_use, tool_result, thinking, ...),
-- so a conversation can be replayed verbatim. `display_text` is what the UI shows
-- for user messages (without the hidden context header).
create table if not exists public.agent_messages (
  id               bigint generated always as identity primary key,
  conversation_id  uuid not null references public.agent_conversations (id) on delete cascade,
  run_id           uuid,
  role             text not null check (role in ('user', 'assistant')),
  content          jsonb not null,
  display_text     text,
  created_at       timestamptz not null default now()
);
create index if not exists agent_messages_conversation_idx on public.agent_messages (conversation_id, id);

create table if not exists public.agent_runs (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.agent_conversations (id) on delete cascade,
  kind             text not null default 'chat'
                   check (kind in ('chat', 'daily_check', 'monitor_investigate', 'approval_followup')),
  status           text not null default 'queued'
                   check (status in ('queued', 'running', 'done', 'error', 'cancelled')),
  turns            integer not null default 0,
  attempts         integer not null default 0,
  api_failures     integer not null default 0,   -- consecutive temporary Claude API errors
  lease_until      timestamptz,
  queued_at        timestamptz not null default now(),
  usage            jsonb not null default '{}'::jsonb,
  result_text      text,
  error            text,
  created_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  finished_at      timestamptz
);
create index if not exists agent_runs_active_idx on public.agent_runs (status, queued_at)
  where status in ('queued', 'running');
-- Only one active run per conversation (keeps the message history well-formed).
create unique index if not exists agent_runs_one_active_per_conversation
  on public.agent_runs (conversation_id) where status in ('queued', 'running');

-- -----------------------------------------------------------------------------
-- Alerts, approvals, audit log
-- -----------------------------------------------------------------------------
create table if not exists public.agent_alerts (
  id               bigint generated always as identity primary key,
  severity         text not null check (severity in ('info', 'warning', 'critical')),
  category         text not null default 'general',
  title            text not null,
  body             text,
  dedupe_key       text,
  status           text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  occurrences      integer not null default 1,
  source           text not null default 'agent' check (source in ('agent', 'monitor', 'daily_check', 'system')),
  run_id           uuid,
  conversation_id  uuid references public.agent_conversations (id) on delete set null,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  notified_at      timestamptz,
  resolved_at      timestamptz,
  resolution_note  text
);
create index if not exists agent_alerts_status_idx on public.agent_alerts (status, last_seen_at desc);
create unique index if not exists agent_alerts_open_dedupe
  on public.agent_alerts (dedupe_key) where status <> 'resolved' and dedupe_key is not null;

create table if not exists public.agent_approvals (
  id               bigint generated always as identity primary key,
  run_id           uuid,
  conversation_id  uuid references public.agent_conversations (id) on delete set null,
  tool_name        text not null,
  tool_input       jsonb not null,
  reason           text not null,
  status           text not null default 'pending'
                   check (status in ('pending', 'approved', 'rejected', 'executed', 'failed', 'expired')),
  result           text,
  decided_by       uuid references auth.users (id) on delete set null,
  decided_via      text,
  decision_note    text,
  decided_at       timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists agent_approvals_status_idx on public.agent_approvals (status, created_at desc);

create table if not exists public.agent_audit_log (
  id               bigint generated always as identity primary key,
  run_id           uuid,
  conversation_id  uuid,
  tool_name        text not null,
  input            jsonb,
  outcome          text not null check (outcome in ('ok', 'error', 'pending_approval', 'blocked')),
  is_write         boolean not null default false,
  result_preview   text,
  duration_ms      integer,
  created_at       timestamptz not null default now()
);
create index if not exists agent_audit_log_created_idx on public.agent_audit_log (created_at desc);

-- -----------------------------------------------------------------------------
-- Long-term memory and watch rules
-- -----------------------------------------------------------------------------
create table if not exists public.agent_memory (
  key         text primary key,
  content     text not null,
  updated_by  text not null default 'agent',
  updated_at  timestamptz not null default now()
);

-- A watch rule is a read-only SELECT. Every row it returns is one "problem".
-- The agent runs all enabled rules at every morning check (and critical ones in
-- the 15-minute monitor) and can add / edit rules itself.
create table if not exists public.agent_watch_rules (
  id           bigint generated always as identity primary key,
  name         text not null unique,
  description  text not null,
  category     text not null default 'general',
  severity     text not null default 'warning' check (severity in ('info', 'warning', 'critical')),
  sql          text not null,
  enabled      boolean not null default true,
  last_run_at  timestamptz,
  last_count   integer,
  last_error   text,
  created_by   text not null default 'seed',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.agent_health_checks (
  id           bigint generated always as identity primary key,
  batch_id     uuid not null,
  job          text not null,
  check_name   text not null,
  status       text not null check (status in ('ok', 'warn', 'fail', 'skipped')),
  summary      text not null,
  details      jsonb,
  duration_ms  integer,
  created_at   timestamptz not null default now()
);
create index if not exists agent_health_checks_created_idx on public.agent_health_checks (created_at desc);
create index if not exists agent_health_checks_batch_idx on public.agent_health_checks (batch_id);

-- -----------------------------------------------------------------------------
-- Row Level Security: admins can READ everything from the browser.
-- All writes go through the Edge Functions (service role / direct DB), never
-- from the browser.
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'agent_settings', 'agent_admins', 'agent_conversations', 'agent_messages', 'agent_runs',
    'agent_alerts', 'agent_approvals', 'agent_audit_log', 'agent_memory',
    'agent_watch_rules', 'agent_health_checks'
  ] loop
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

-- Live updates in the admin panel.
do $$
declare
  t text;
begin
  foreach t in array array['agent_messages', 'agent_runs', 'agent_alerts', 'agent_approvals', 'agent_conversations'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception
      when duplicate_object then null;   -- already in the publication
      when undefined_object then null;   -- publication missing (e.g. local dev without realtime)
    end;
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- Safe casting helpers (bad data returns NULL instead of breaking a query)
-- -----------------------------------------------------------------------------
create or replace function public.agent_try_date(v text)
returns date language plpgsql stable set search_path = '' as $$
begin
  if v is null or btrim(v) = '' then return null; end if;
  return v::date;
exception when others then
  return null;
end;
$$;

create or replace function public.agent_try_timestamptz(v text)
returns timestamptz language plpgsql stable set search_path = '' as $$
begin
  if v is null or btrim(v) = '' then return null; end if;
  return v::timestamptz;
exception when others then
  return null;
end;
$$;

create or replace function public.agent_try_numeric(v text)
returns numeric language plpgsql immutable set search_path = '' as $$
begin
  if v is null or btrim(v) = '' then return null; end if;
  return v::numeric;
exception when others then
  return null;
end;
$$;

create or replace function public.agent_try_bool(v text)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
  if v is null or btrim(v) = '' then return null; end if;
  return v::boolean;
exception when others then
  return null;
end;
$$;

-- -----------------------------------------------------------------------------
-- One row per container (containers live as a JSON array inside orders).
-- Makes ETA / transit analysis much easier for the agent and for watch rules.
-- -----------------------------------------------------------------------------
create or replace view public.agent_container_view
with (security_invoker = true) as
select
  o.id                                                 as order_id,
  o.order_number,
  o.customer_id,
  o.shipment_type,
  o.domestic_category,
  o.priority                                           as order_priority,
  o.origin                                             as order_origin,
  o.destination                                        as order_destination,
  o.eta                                                as order_eta,
  o.created_date                                       as order_created_date,
  coalesce(o.cancelled, false)                         as order_cancelled,
  x ->> 'id'                                           as container_id,
  nullif(x ->> 'containerNumber', '')                  as container_number,
  public.agent_try_numeric(x ->> 'stageIndex')::int    as stage_index,
  -- Stage names come from the web app (IMPORT_STAGES / DOMESTIC_STAGES / STAGES in index.html).
  (case
     when o.shipment_type = 'Import'   then array['Confirmed','Picked Up','In Transit','Under Offloading','Delivered','Completed']
     when o.shipment_type = 'Domestic' then array['Confirmed','Picked Up','In Transit','Under Offloading','Delivered']
     else                                   array['Confirmed','Picked Up','In Transit','Delivered']
   end)[coalesce(public.agent_try_numeric(x ->> 'stageIndex')::int, 0) + 1] as stage_name,
  coalesce(public.agent_try_bool(x ->> 'cancelled'), false) as cancelled,
  nullif(x ->> 'destination', '')                      as destination,
  nullif(x ->> 'transporter', '')                      as transporter,
  nullif(x ->> 'vehiclePlate', '')                     as vehicle_plate,
  nullif(x ->> 'vehicleSize', '')                      as vehicle_size,
  nullif(x ->> 'driverName', '')                       as driver_name,
  nullif(x ->> 'biltyNumber', '')                      as bilty_number,
  nullif(x ->> 'movementThrough', '')                  as movement_through,
  public.agent_try_date(x ->> 'loadingDate')           as loading_date,
  public.agent_try_timestamptz(x ->> 'dispatchAt')     as dispatch_at,
  public.agent_try_timestamptz(x ->> 'podArrivalAt')   as pod_arrival_at,
  public.agent_try_timestamptz(x ->> 'podOffloadingAt') as pod_offloading_at,
  public.agent_try_date(x ->> 'deliveredDate')         as delivered_date,
  public.agent_try_date(x ->> 'emptyReturnDate')       as empty_return_date,
  nullif(x ->> 'emptyReturnLocation', '')              as empty_return_location,
  nullif(x ->> 'transporterBillNo', '')                as transporter_bill_no,
  public.agent_try_numeric(x ->> 'freightAmount')      as freight_amount,
  public.agent_try_numeric(x ->> 'amount')             as amount,
  -- delivered = has a delivered date, or has reached the Delivered/Completed stage
  (public.agent_try_date(x ->> 'deliveredDate') is not null
    or coalesce(public.agent_try_numeric(x ->> 'stageIndex')::int, 0) >=
       case when o.shipment_type in ('Import', 'Domestic') then 4 else 3 end) as is_delivered,
  x                                                    as raw
from public.orders o
cross join lateral jsonb_array_elements(
  case when jsonb_typeof(o.containers) = 'array' then o.containers else '[]'::jsonb end
) as x;

revoke all on public.agent_container_view from anon, authenticated;

-- -----------------------------------------------------------------------------
-- Calling Edge Functions from pg_cron (used by the cron migration).
-- Reads the project URL + internal secret from Supabase Vault.
-- -----------------------------------------------------------------------------
create or replace function public.agent_invoke(fn text, body jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  base_url text;
  secret   text;
  req_id   bigint;
begin
  select decrypted_secret into base_url from vault.decrypted_secrets where name = 'site_agent_project_url';
  select decrypted_secret into secret   from vault.decrypted_secrets where name = 'site_agent_internal_secret';
  if base_url is null or secret is null then
    raise exception 'Vault secrets site_agent_project_url / site_agent_internal_secret are missing';
  end if;

  select net.http_post(
    url := rtrim(base_url, '/') || '/functions/v1/' || fn,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-agent-secret', secret),
    body := body,
    timeout_milliseconds := 10000
  ) into req_id;
  return req_id;
end;
$$;

revoke all on function public.agent_invoke(text, jsonb) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Seed: what the agent knows on day one
-- -----------------------------------------------------------------------------
insert into public.agent_memory (key, content, updated_by) values
(
  'business',
  'LogistiX: logistics / transport company in Pakistan (amounts in PKR). Core tables: orders (one per job; the '
  || 'containers JSON array holds per-truck/container tracking), customers, senders, transporters, drivers, vehicles, '
  || 'routes, invoices, contracts + contract_groups (customer rate contracts), fuel_prices (daily fuel price), '
  || 'fuel_cards, fuel_card_swaps, fuel_allocations, fuel_customers, profiles (roles: admin, staff, customer, '
  || 'dispatcher, receiver, data_entry, finance_manager, bill_checker).',
  'seed'
),
(
  'orders-and-stages',
  'Shipment types: Import, Domestic, Export. Container stageIndex (0-based) by type - Import: Confirmed, Picked Up, '
  || 'In Transit, Under Offloading, Delivered, Completed (empty container returned). Domestic: Confirmed, Picked Up, '
  || 'In Transit, Under Offloading, Delivered. Export: Confirmed, Picked Up, In Transit, Delivered. '
  || 'orders.eta is a date. Real tracking is per container inside orders.containers (stageIndex, loadingDate, '
  || 'dispatchAt, podArrivalAt, deliveredDate, cancelled, transporter, vehiclePlate, destination, biltyNumber, '
  || 'emptyReturnDate, transporter bill fields). Use public.agent_container_view (one row per container, typed, with '
  || 'stage_name and is_delivered) for analysis. orders.delivered_date / orders.stage_index are rarely filled - judge '
  || 'delivery from the containers.',
  'seed'
),
(
  'website-and-code',
  'The web app is the GitHub repo abwebstudioofficial-web/logistix: a single-file app (index.html, plus '
  || 'fleet_drivers.html) using React 18 UMD + in-browser Babel + Tailwind CDN, hosted on GitHub Pages - anything '
  || 'merged into main goes live immediately. Rules: never push to main; one small focused PR per fix from a '
  || 'maint/... branch based on the latest main; the owner reviews and merges. Other Claude sessions also change this '
  || 'repo - check WORKING_ON.md and open PRs first and never overwrite their work. Code constraints that caused real '
  || 'bugs: the Supabase client is the custom createLiteClient (only select, upsert, update, delete, eq, order, range, '
  || 'maybeSingle - NO .insert(), NO .limit(); use .upsert() and .range()); all React hooks must stay above any early '
  || 'return in a component (or the page goes blank); SortTh must stay defined at module scope.',
  'seed'
),
(
  'database-rules',
  'Schema changes only as recorded migrations (db_migration). Never modify, delete or bulk-edit live data without the '
  || 'owner''s explicit approval. Do not change the existing Edge Functions (fetch-hicetane-price, '
  || 'fetch-pso-diesel-price) or the existing pg_cron schedules (fetch-hicetane-price-daily 02:00 UTC = 07:00 PKT, '
  || 'fetch-hicetane-price-retry 02:30 UTC, fetch-pso-diesel-price-daily 06:00 UTC = 11:00 PKT) without asking first.',
  'seed'
),
(
  'data-snapshot-2026-09-26',
  'At setup: ~1,530 orders (almost all Domestic: "Finished Goods (FG)" and "Wrapping Materials"). ~1,527 containers '
  || 'are still at stage 0 "Confirmed" with loading dates Jan-Jun 2026 and no delivery date - most likely historical '
  || 'data imported without progress. Ask the owner before treating them as real open shipments or updating them.',
  'seed'
)
on conflict (key) do nothing;

insert into public.agent_watch_rules (name, category, severity, description, sql) values
(
  'orders_past_eta', 'orders', 'warning',
  'Orders whose ETA has passed while at least one container is still not delivered (and the order is not cancelled).',
  $sql$select o.id, o.order_number, c.name as customer, o.shipment_type, o.destination, o.eta,
       public.agent_today() - o.eta as days_late,
       (select string_agg(distinct v.stage_name, ', ') from public.agent_container_view v
         where v.order_id = o.id and not v.is_delivered and not v.cancelled) as open_container_stages
from public.orders o
left join public.customers c on c.id = o.customer_id
where o.eta < public.agent_today()
  and not coalesce(o.cancelled, false)
  and o.delivered_date is null
  and (
    not exists (select 1 from public.agent_container_view c where c.order_id = o.id)
    or exists (select 1 from public.agent_container_view c
               where c.order_id = o.id and not c.is_delivered and not c.cancelled)
  )
order by o.eta$sql$
),
(
  'orders_due_today_or_tomorrow', 'orders', 'info',
  'Orders with an ETA of today or tomorrow that still have undelivered containers (heads-up list).',
  $sql$select o.id, o.order_number, c.name as customer, o.shipment_type, o.destination, o.eta
from public.orders o
left join public.customers c on c.id = o.customer_id
where o.eta between public.agent_today() and public.agent_today() + 1
  and not coalesce(o.cancelled, false)
  and o.delivered_date is null
  and (
    not exists (select 1 from public.agent_container_view c where c.order_id = o.id)
    or exists (select 1 from public.agent_container_view c
               where c.order_id = o.id and not c.is_delivered and not c.cancelled)
  )
order by o.eta$sql$
),
(
  'containers_in_transit_over_7_days', 'orders', 'warning',
  'Containers at "Picked Up" or "In Transit" for more than 7 days since dispatch/loading (possibly stuck, or the status was never updated).',
  $sql$select order_number, shipment_type, container_id, stage_name, bilty_number, transporter, vehicle_plate,
       destination, coalesce(dispatch_at::date, loading_date) as since,
       public.agent_today() - coalesce(dispatch_at::date, loading_date) as days
from public.agent_container_view
where stage_index in (1, 2)
  and not is_delivered and not cancelled and not order_cancelled
  and coalesce(dispatch_at::date, loading_date) < public.agent_today() - 7
order by since$sql$
),
(
  'containers_not_started_after_loading_date', 'orders', 'info',
  'Containers still at "Confirmed" more than 7 days after their loading date (never picked up - or old data that was never updated).',
  $sql$select order_number, shipment_type, container_id, bilty_number, transporter, destination, loading_date,
       public.agent_today() - loading_date as days_since_loading
from public.agent_container_view
where coalesce(stage_index, 0) = 0
  and not is_delivered and not cancelled and not order_cancelled
  and loading_date < public.agent_today() - 7
order by loading_date$sql$
),
(
  'eta_before_order_date', 'data_quality', 'info',
  'Orders whose ETA is earlier than the date the order was created (data entry mistake).',
  $sql$select id, order_number, created_date, eta
from public.orders
where eta is not null and created_date is not null and eta < created_date$sql$
),
(
  'duplicate_bilty_numbers', 'data_quality', 'info',
  'The same bilty number is used on more than one container.',
  $sql$select bilty_number, count(*) as containers, array_agg(distinct order_number) as orders
from public.agent_container_view
where bilty_number is not null
group by bilty_number
having count(*) > 1
order by count(*) desc$sql$
),
(
  'driver_documents_expiring', 'fleet', 'warning',
  'Driver licence or medical expires within 30 days (or already expired).',
  $sql$select id, name, phone, license_expiry, med_expiry
from public.drivers
where license_expiry < public.agent_today() + 30
   or med_expiry < public.agent_today() + 30
order by least(coalesce(license_expiry, 'infinity'::date), coalesce(med_expiry, 'infinity'::date))$sql$
),
(
  'vehicle_documents_expiring', 'fleet', 'warning',
  'Vehicle insurance or registration expires within 30 days (or already expired).',
  $sql$select id, plate, insurance_expiry, reg_expiry, status
from public.vehicles
where insurance_expiry < public.agent_today() + 30
   or reg_expiry < public.agent_today() + 30
order by least(coalesce(insurance_expiry, 'infinity'::date), coalesce(reg_expiry, 'infinity'::date))$sql$
),
(
  'vehicle_service_due', 'fleet', 'warning',
  'Vehicles whose odometer has reached the next maintenance reading.',
  $sql$select id, plate, odometer, next_maintenance, last_service
from public.vehicles
where coalesce(next_maintenance, 0) > 0
  and coalesce(odometer, 0) >= next_maintenance$sql$
),
(
  'invoices_overdue', 'finance', 'warning',
  'Invoices past their due date that are not marked paid / cancelled.',
  $sql$select i.id, i.invoice_number, c.name as customer, i.total, i.due, i.status,
       public.agent_today() - i.due as days_overdue
from public.invoices i
left join public.customers c on c.id = i.customer_id
where i.due < public.agent_today()
  and lower(coalesce(i.status, '')) not in ('paid', 'cancelled', 'canceled', 'void')
order by i.due$sql$
),
(
  'contracts_expiring', 'finance', 'warning',
  'Customer contracts that expire within 30 days (or already expired).',
  $sql$select cg.id, cg.contract_title, c.name as customer, cg.expiry_date
from public.contract_groups cg
left join public.customers c on c.id = cg.customer_id
where cg.expiry_date < public.agent_today() + 30
order by cg.expiry_date$sql$
),
(
  'fuel_price_feed_stale', 'integrations', 'critical',
  'The daily diesel price has not been updated for more than 2 days (the fetch-pso-diesel-price job may be broken).',
  $sql$select max(effective_date) as latest_price_date,
       public.agent_today() - max(effective_date) as days_old
from public.fuel_prices
having max(effective_date) is null or max(effective_date) < public.agent_today() - 2$sql$
)
on conflict (name) do nothing;
