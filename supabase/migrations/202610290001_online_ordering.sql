-- Hibi Cafe online ordering support
alter table public.pos_orders
  add column if not exists customer_name text,
  add column if not exists customer_phone text,
  add column if not exists tracking_code text,
  add column if not exists payment_proof_url text,
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists pos_orders_tracking_code_uidx
  on public.pos_orders (tracking_code)
  where tracking_code is not null;

create sequence if not exists public.hibi_pos_order_number_seq;
select setval(
  'public.hibi_pos_order_number_seq',
  greatest(coalesce((select max(order_number) from public.pos_orders), 0) + 1, 1),
  false
);

create or replace function public.next_hibi_order_number()
returns integer
language sql
security definer
set search_path = public
as $$
  select nextval('public.hibi_pos_order_number_seq')::integer;
$$;

revoke all on function public.next_hibi_order_number() from public, anon, authenticated;
grant execute on function public.next_hibi_order_number() to service_role;

create or replace function public.touch_pos_order_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists pos_orders_touch_updated_at on public.pos_orders;
create trigger pos_orders_touch_updated_at
before update on public.pos_orders
for each row execute function public.touch_pos_order_updated_at();
