create extension if not exists pgcrypto;

create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id text unique,
  username text,
  first_name text,
  last_name text,
  balance_tokens bigint not null default 0 check (balance_tokens >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.token_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete restrict,
  telegram_user_id text not null,
  package_id text not null,
  tokens integer not null check (tokens > 0),
  amount_rub numeric(12, 2) not null check (amount_rub > 0),
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed', 'cancelled')),
  robokassa_inv_id text unique,
  payment_url text,
  paid_at timestamptz,
  provider_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete restrict,
  amount_tokens bigint not null check (amount_tokens <> 0),
  kind text not null check (kind in ('purchase', 'generation', 'refund', 'bonus', 'adjustment')),
  reference_type text,
  reference_id text,
  idempotency_key text not null unique,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.generation_charges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete restrict,
  order_id uuid,
  generation_id text,
  model_id text not null,
  provider_cost_usd numeric(14, 6) not null check (provider_cost_usd > 0),
  usd_rub_rate numeric(12, 4) not null check (usd_rub_rate > 0),
  provider_cost_rub numeric(14, 2) not null check (provider_cost_rub > 0),
  markup_multiplier numeric(8, 4) not null default 3 check (markup_multiplier = 3),
  retail_price_rub numeric(14, 2) not null check (retail_price_rub > 0),
  charged_tokens bigint not null check (charged_tokens > 0),
  status text not null default 'quoted' check (status in ('quoted', 'charged', 'refunded', 'failed')),
  pricing_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (generation_id)
);

create index if not exists token_payments_user_created_idx
  on public.token_payments(user_id, created_at desc);

create index if not exists wallet_transactions_user_created_idx
  on public.wallet_transactions(user_id, created_at desc);

create index if not exists generation_charges_user_created_idx
  on public.generation_charges(user_id, created_at desc);

alter table public.app_users enable row level security;
alter table public.token_payments enable row level security;
alter table public.wallet_transactions enable row level security;
alter table public.generation_charges enable row level security;

revoke all on public.app_users from anon, authenticated;
revoke all on public.token_payments from anon, authenticated;
revoke all on public.wallet_transactions from anon, authenticated;
revoke all on public.generation_charges from anon, authenticated;

create or replace function public.charge_generation_tokens(
  p_user_id uuid,
  p_order_id uuid,
  p_generation_id text,
  p_model_id text,
  p_provider_cost_usd numeric,
  p_usd_rub_rate numeric,
  p_provider_cost_rub numeric,
  p_retail_price_rub numeric,
  p_charged_tokens bigint,
  p_pricing_snapshot jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  current_balance bigint;
  transaction_inserted integer;
begin
  if p_provider_cost_usd <= 0 or p_usd_rub_rate <= 0 or
     p_provider_cost_rub <= 0 or p_retail_price_rub <= 0 or
     p_charged_tokens <= 0 then
    raise exception 'Invalid generation pricing values';
  end if;

  if p_generation_id is null and p_order_id is null then
    raise exception 'Generation or order reference is required';
  end if;

  select balance_tokens
    into current_balance
    from public.app_users
   where id = p_user_id
   for update;

  if not found then
    raise exception 'Platform user not found: %', p_user_id;
  end if;

  if current_balance < p_charged_tokens then
    raise exception 'Insufficient token balance';
  end if;

  insert into public.wallet_transactions (
    user_id,
    amount_tokens,
    kind,
    reference_type,
    reference_id,
    idempotency_key,
    metadata
  ) values (
    p_user_id,
    -p_charged_tokens,
    'generation',
    'generation',
    coalesce(p_generation_id, p_order_id::text),
    'generation:' || coalesce(p_generation_id, p_order_id::text),
    jsonb_build_object(
      'model_id', p_model_id,
      'provider_cost_usd', p_provider_cost_usd,
      'retail_price_rub', p_retail_price_rub,
      'multiplier', 3
    )
  )
  on conflict (idempotency_key) do nothing;

  get diagnostics transaction_inserted = row_count;

  if transaction_inserted = 0 then
    return current_balance;
  end if;

  insert into public.generation_charges (
    user_id,
    order_id,
    generation_id,
    model_id,
    provider_cost_usd,
    usd_rub_rate,
    provider_cost_rub,
    markup_multiplier,
    retail_price_rub,
    charged_tokens,
    status,
    pricing_snapshot
  ) values (
    p_user_id,
    p_order_id,
    p_generation_id,
    p_model_id,
    p_provider_cost_usd,
    p_usd_rub_rate,
    p_provider_cost_rub,
    3,
    p_retail_price_rub,
    p_charged_tokens,
    'charged',
    coalesce(p_pricing_snapshot, '{}'::jsonb)
  );

  update public.app_users
     set balance_tokens = balance_tokens - p_charged_tokens,
         updated_at = now()
   where id = p_user_id
   returning balance_tokens into current_balance;

  return current_balance;
end;
$$;

revoke all on function public.charge_generation_tokens(
  uuid, uuid, text, text, numeric, numeric, numeric, numeric, bigint, jsonb
) from public, anon, authenticated;

grant execute on function public.charge_generation_tokens(
  uuid, uuid, text, text, numeric, numeric, numeric, numeric, bigint, jsonb
) to service_role;

create or replace function public.complete_token_payment(
  p_payment_id uuid,
  p_inv_id text,
  p_provider_payload jsonb default '{}'::jsonb
)
returns table (
  new_balance bigint,
  already_processed boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  payment_record public.token_payments%rowtype;
  transaction_inserted integer;
begin
  select *
    into payment_record
    from public.token_payments
   where id = p_payment_id
   for update;

  if not found then
    raise exception 'Token payment not found: %', p_payment_id;
  end if;

  if payment_record.robokassa_inv_id is distinct from p_inv_id then
    raise exception 'Robokassa invoice mismatch for payment %', p_payment_id;
  end if;

  if payment_record.status = 'paid' then
    return query
      select balance_tokens, true
        from public.app_users
       where id = payment_record.user_id;
    return;
  end if;

  update public.token_payments
     set status = 'paid',
         paid_at = now(),
         provider_payload = coalesce(p_provider_payload, '{}'::jsonb),
         updated_at = now()
   where id = payment_record.id;

  insert into public.wallet_transactions (
    user_id,
    amount_tokens,
    kind,
    reference_type,
    reference_id,
    idempotency_key,
    metadata
  ) values (
    payment_record.user_id,
    payment_record.tokens,
    'purchase',
    'token_payment',
    payment_record.id::text,
    'robokassa:' || payment_record.id::text,
    jsonb_build_object('robokassa_inv_id', p_inv_id)
  )
  on conflict (idempotency_key) do nothing;

  get diagnostics transaction_inserted = row_count;

  if transaction_inserted = 1 then
    update public.app_users
       set balance_tokens = balance_tokens + payment_record.tokens,
           updated_at = now()
     where id = payment_record.user_id
     returning balance_tokens into new_balance;

    already_processed := false;
    return next;
    return;
  end if;

  return query
    select balance_tokens, true
      from public.app_users
     where id = payment_record.user_id;
end;
$$;

revoke all on function public.complete_token_payment(uuid, text, jsonb)
  from public, anon, authenticated;

grant execute on function public.complete_token_payment(uuid, text, jsonb)
  to service_role;
