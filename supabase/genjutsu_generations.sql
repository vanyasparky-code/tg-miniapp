create table if not exists public.custom_generations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete restrict,
  telegram_user_id text not null,
  model_key text not null check (
    model_key in (
      'genjutsu_motion',
      'genjutsu_object',
      'genjutsu_restyle',
      'seedance_2_reference',
      'seedance_2_5_text',
      'seedance_2_5_image',
      'seedance_2_5_reference',
      'seedance_2_5_edit'
    )
  ),
  model_id text not null,
  status text not null default 'queued' check (
    status in ('queued', 'processing', 'completed', 'failed', 'subscription_required')
  ),
  prompt text,
  video_url text,
  image_urls jsonb not null default '[]'::jsonb,
  resolution text not null check (resolution in ('480p', '720p', '1080p', '4k')),
  preset_id text,
  duration integer not null default 5 check (duration between 4 and 30),
  aspect_ratio text not null default '16:9' check (
    aspect_ratio in ('16:9', '4:3', '1:1', '3:4', '9:16', '21:9')
  ),
  bitrate_mode text not null default 'high' check (
    bitrate_mode in ('standard', 'high')
  ),
  output_format text not null default 'mp4' check (
    output_format in ('mp4', 'mov')
  ),
  generate_audio boolean not null default true,
  source_duration_seconds numeric(10, 3) not null default 0 check (
    source_duration_seconds >= 0
  ),
  source_width integer,
  source_height integer,
  source_size_bytes bigint,
  billed_seconds integer not null check (billed_seconds >= 4),
  provider_cost_usd numeric(14, 6) not null check (provider_cost_usd > 0),
  usd_rub_rate numeric(12, 4) not null check (usd_rub_rate > 0),
  markup_multiplier numeric(8, 4) not null default 2 check (markup_multiplier = 2),
  retail_price_rub numeric(14, 2) not null check (retail_price_rub > 0),
  charged_tokens bigint not null check (charged_tokens > 0),
  provider_request_id text,
  provider_status_url text,
  result_url text,
  error_message text,
  bot_prepare_message_sent boolean not null default false,
  bot_message_sent boolean not null default false,
  bot_message_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists custom_generations_user_created_idx
  on public.custom_generations(user_id, created_at desc);

create index if not exists custom_generations_queue_idx
  on public.custom_generations(status, created_at asc);

create unique index if not exists custom_generations_provider_request_idx
  on public.custom_generations(provider_request_id)
  where provider_request_id is not null;

alter table public.custom_generations enable row level security;

revoke all on table public.custom_generations from public, anon, authenticated;
grant all on table public.custom_generations to service_role;

update storage.buckets
   set file_size_limit = 209715200
 where id = 'media';
