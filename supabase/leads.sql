-- Resources ebook leads — captured by /api/lead (server-side, service key).
-- Run once in the Supabase SQL editor.
--
-- RLS is ON with NO policies: the anon/public key can neither read nor write
-- this table. Only the service key (used by /api/lead, which bypasses RLS)
-- writes here, and you read it from the Supabase dashboard / SQL editor.

create table if not exists leads (
  id            uuid primary key default gen_random_uuid(),
  name          text,
  email         text,
  company       text,
  report_id     text,
  report_title  text,
  lang          text,
  source        text default 'resources',
  ip            text,
  user_agent    text,
  created_at    timestamptz default now()
);

create index if not exists leads_created_idx on leads (created_at desc);
create index if not exists leads_email_idx   on leads (email);

alter table leads enable row level security;
-- (No policies on purpose — public keys get nothing; the service key bypasses RLS.)
