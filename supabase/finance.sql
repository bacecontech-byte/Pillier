-- Financeiro module — expenses ledger + per-company finance settings.
-- Run once in the Supabase SQL editor. RLS mirrors the company-scoped pattern
-- used elsewhere (see rls.sql): a user only sees rows for a company they belong
-- to (company_members). The client is offline-first and falls back to
-- localStorage, so the app works before this migration is applied — running it
-- turns on cross-device sync and the daily-nudge cron.

-- ── Expenses ledger ─────────────────────────────────────────────────────────
create table if not exists expenses (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id) on delete cascade,
  project      text,
  vendor       text,
  category     text,
  subcategory  text,
  amount       numeric(14,2) not null default 0,
  currency     text default 'BRL',
  method       text,
  note         text,
  receipt_url  text,
  ocr          boolean default false,
  status       text default 'pending',      -- 'pending' | 'reviewed'
  created_by   text,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);
-- If the table already exists from an earlier run, add the new column in place.
alter table expenses add column if not exists subcategory text;
create index if not exists expenses_company_created_idx on expenses (company_id, created_at desc);
create index if not exists expenses_company_status_idx  on expenses (company_id, status);

-- ── Per-company finance settings (budget + nudge automation) ────────────────
create table if not exists finance_settings (
  company_id     uuid primary key references companies(id) on delete cascade,
  budget_monthly numeric(14,2) default 0,
  nudge_enabled  boolean default false,
  nudge_time     text default '17:30',
  updated_at     timestamptz default now()
);

alter table expenses         enable row level security;
alter table finance_settings enable row level security;

-- Helper already defined in rls.sql: is_member(company_id uuid) returns boolean.
-- Recreate defensively in case finance.sql is run standalone.
create or replace function is_member(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from company_members m where m.company_id = cid and m.user_id = auth.uid());
$$;

drop policy if exists expenses_select on expenses;
drop policy if exists expenses_insert on expenses;
drop policy if exists expenses_update on expenses;
drop policy if exists expenses_delete on expenses;
create policy expenses_select on expenses for select using (is_member(company_id));
create policy expenses_insert on expenses for insert with check (is_member(company_id));
create policy expenses_update on expenses for update using (is_member(company_id)) with check (is_member(company_id));
create policy expenses_delete on expenses for delete using (is_member(company_id));

drop policy if exists finset_select on finance_settings;
drop policy if exists finset_upsert on finance_settings;
drop policy if exists finset_update on finance_settings;
create policy finset_select on finance_settings for select using (is_member(company_id));
create policy finset_upsert on finance_settings for insert with check (is_member(company_id));
create policy finset_update on finance_settings for update using (is_member(company_id)) with check (is_member(company_id));

-- ── Receipt image storage ───────────────────────────────────────────────────
-- Public bucket so receipt_url is a durable link. Files are namespaced by
-- company id with an unguessable timestamped name. Any signed-in member of the
-- app can upload; reads are public (needed to render the stored URL).
insert into storage.buckets (id, name, public)
  values ('receipts', 'receipts', true)
  on conflict (id) do nothing;

drop policy if exists receipts_read   on storage.objects;
drop policy if exists receipts_insert on storage.objects;
drop policy if exists receipts_update on storage.objects;
create policy receipts_read   on storage.objects for select using (bucket_id = 'receipts');
create policy receipts_insert on storage.objects for insert to authenticated with check (bucket_id = 'receipts');
create policy receipts_update on storage.objects for update to authenticated using (bucket_id = 'receipts') with check (bucket_id = 'receipts');
