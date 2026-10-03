alter table public.templates
  add column if not exists description text,
  add column if not exists cover_url text,
  add column if not exists preview_video_url text,
  add column if not exists source_video_url text,
  add column if not exists generation_mode text not null default 'legacy',
  add column if not exists required_photo_count integer not null default 1,
  add column if not exists photo_rules jsonb not null default '[]'::jsonb,
  add column if not exists available_resolutions jsonb not null default '["720p"]'::jsonb;

alter table public.orders
  add column if not exists selected_resolution text,
  add column if not exists provider_request_id text,
  add column if not exists provider_status_url text;

create index if not exists orders_provider_request_idx
  on public.orders(provider_request_id)
  where provider_request_id is not null;

update public.templates
   set is_active = false
 where slug <> 'dance_with_dog';

insert into public.templates (
  slug,
  title,
  description,
  video_prompt,
  photo_prompt,
  price_rub,
  is_active,
  cover_url,
  preview_video_url,
  source_video_url,
  generation_mode,
  required_photo_count,
  photo_rules,
  available_resolutions,
  photo_model,
  video_model,
  aspect_ratio,
  duration,
  resolution
) values (
  'dance_with_dog',
  'Танец с собачкой',
  'Замените героев трендового танца фотографиями двух людей и питомца.',
  'swap the video''s main character to the attached characters and his clother.',
  '',
  605,
  true,
  'https://tg-miniapp-liart.vercel.app/assets/templates/dance-with-dog-cover.jpg',
  'https://tg-miniapp-liart.vercel.app/assets/templates/dance-with-dog-preview.mp4',
  'https://tg-miniapp-liart.vercel.app/assets/templates/dance-with-dog-source.mp4',
  'genjutsu_motion_template',
  3,
  '["Человек слева", "Человек справа", "Питомец"]'::jsonb,
  '["480p", "720p", "1080p"]'::jsonb,
  'none',
  'genjutsu_motion',
  '9:16',
  19,
  '480p'
)
on conflict (slug) do update set
  title = excluded.title,
  description = excluded.description,
  video_prompt = excluded.video_prompt,
  photo_prompt = excluded.photo_prompt,
  price_rub = excluded.price_rub,
  is_active = excluded.is_active,
  cover_url = excluded.cover_url,
  preview_video_url = excluded.preview_video_url,
  source_video_url = excluded.source_video_url,
  generation_mode = excluded.generation_mode,
  required_photo_count = excluded.required_photo_count,
  photo_rules = excluded.photo_rules,
  available_resolutions = excluded.available_resolutions,
  photo_model = excluded.photo_model,
  video_model = excluded.video_model,
  aspect_ratio = excluded.aspect_ratio,
  duration = excluded.duration,
  resolution = excluded.resolution;
