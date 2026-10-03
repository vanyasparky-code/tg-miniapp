create table if not exists public.support_message_routes (
  id uuid primary key default gen_random_uuid(),
  operator_chat_id text not null,
  operator_message_id bigint not null,
  user_chat_id text not null,
  user_telegram_id text,
  username text,
  created_at timestamptz not null default now(),
  unique (operator_chat_id, operator_message_id)
);

create index if not exists support_message_routes_user_idx
  on public.support_message_routes(user_chat_id, created_at desc);

alter table public.support_message_routes enable row level security;

revoke all on table public.support_message_routes from anon, authenticated;
grant all on table public.support_message_routes to service_role;
