-- Hibi Cafe monthly reporting: settings, delivery log and month-end scheduler.
create table if not exists public.monthly_report_settings (
  id smallint primary key default 1 check (id = 1),
  automatic_enabled boolean not null default true,
  recipients text[] not null default array['djohargamboa@gmail.com']::text[],
  timezone text not null default 'Asia/Manila',
  updated_at timestamptz not null default now(),
  updated_by uuid null
);

insert into public.monthly_report_settings (id, automatic_enabled, recipients, timezone)
values (1, true, array['djohargamboa@gmail.com']::text[], 'Asia/Manila')
on conflict (id) do nothing;

create table if not exists public.monthly_report_log (
  id uuid primary key default gen_random_uuid(),
  report_month text not null check (report_month ~ '^\d{4}-\d{2}$'),
  trigger_type text not null check (trigger_type in ('automatic','manual','download')),
  status text not null check (status in ('generating','sent','failed','downloaded')),
  recipients text[] not null default '{}'::text[],
  filename text,
  resend_id text,
  error_message text,
  summary jsonb not null default '{}'::jsonb,
  sent_by uuid,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists monthly_report_log_month_idx
  on public.monthly_report_log (report_month, created_at desc);

create unique index if not exists monthly_report_log_auto_guard
  on public.monthly_report_log (report_month)
  where trigger_type = 'automatic' and status in ('generating','sent');

alter table public.monthly_report_settings enable row level security;
alter table public.monthly_report_log enable row level security;

drop policy if exists "superusers read monthly report settings" on public.monthly_report_settings;
create policy "superusers read monthly report settings"
  on public.monthly_report_settings for select to authenticated
  using (public.hibi_is_superuser());

drop policy if exists "superusers update monthly report settings" on public.monthly_report_settings;
create policy "superusers update monthly report settings"
  on public.monthly_report_settings for update to authenticated
  using (public.hibi_is_superuser())
  with check (public.hibi_is_superuser());

drop policy if exists "superusers insert monthly report settings" on public.monthly_report_settings;
create policy "superusers insert monthly report settings"
  on public.monthly_report_settings for insert to authenticated
  with check (public.hibi_is_superuser());

drop policy if exists "superusers read monthly report log" on public.monthly_report_log;
create policy "superusers read monthly report log"
  on public.monthly_report_log for select to authenticated
  using (public.hibi_is_superuser());

grant select, insert, update on public.monthly_report_settings to authenticated;
grant select on public.monthly_report_log to authenticated;

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

select cron.unschedule(jobid)
from cron.job
where jobname = 'hibi-monthly-report-daily-check';

-- 16:20 UTC = 00:20 Asia/Manila. The Edge Function only sends when Manila day = 1.
select cron.schedule(
  'hibi-monthly-report-daily-check',
  '20 16 * * *',
  $$
  select net.http_post(
    url := 'https://ysdnxwvkqyqojrelhcbu.supabase.co/functions/v1/monthly-report',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{"mode":"scheduled"}'::jsonb
  );
  $$
);
