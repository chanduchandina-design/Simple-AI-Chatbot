-- Run this script once in the Supabase SQL Editor for this project.
-- Browser sessions are scoped by a signed, HTTP-only cookie. Only the API
-- server uses the service-role key; direct browser access is intentionally off.

create table if not exists public.chat_conversations (
  id uuid primary key,
  owner_id uuid not null,
  title text not null,
  messages jsonb not null default '[]'::jsonb
    check (jsonb_typeof(messages) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists chat_conversations_owner_updated_idx
  on public.chat_conversations (owner_id, updated_at desc);

alter table public.chat_conversations enable row level security;

revoke all on table public.chat_conversations from anon, authenticated;
grant select, insert, update
  on table public.chat_conversations to service_role;

notify pgrst, 'reload schema';
