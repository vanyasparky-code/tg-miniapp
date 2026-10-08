alter table public.custom_generations
  drop constraint if exists custom_generations_model_key_check,
  drop constraint if exists custom_generations_resolution_check,
  drop constraint if exists custom_generations_source_duration_seconds_check,
  drop constraint if exists custom_generations_billed_seconds_check,
  drop constraint if exists custom_generations_duration_check,
  drop constraint if exists custom_generations_aspect_ratio_check,
  drop constraint if exists custom_generations_bitrate_mode_check,
  drop constraint if exists custom_generations_output_format_check;

alter table public.custom_generations
  alter column video_url drop not null,
  alter column source_duration_seconds set default 0,
  add column if not exists duration integer not null default 5,
  add column if not exists aspect_ratio text not null default '16:9',
  add column if not exists bitrate_mode text not null default 'high',
  add column if not exists output_format text not null default 'mp4',
  add column if not exists generate_audio boolean not null default true;

alter table public.custom_generations
  add constraint custom_generations_model_key_check check (
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
  add constraint custom_generations_resolution_check check (
    resolution in ('480p', '720p', '1080p', '4k')
  ),
  add constraint custom_generations_source_duration_seconds_check check (
    source_duration_seconds >= 0
  ),
  add constraint custom_generations_billed_seconds_check check (
    billed_seconds >= 4
  ),
  add constraint custom_generations_duration_check check (
    duration between 4 and 30
  ),
  add constraint custom_generations_aspect_ratio_check check (
    aspect_ratio in ('16:9', '4:3', '1:1', '3:4', '9:16', '21:9')
  ),
  add constraint custom_generations_bitrate_mode_check check (
    bitrate_mode in ('standard', 'high')
  ),
  add constraint custom_generations_output_format_check check (
    output_format in ('mp4', 'mov')
  );

update public.templates
set
  generation_mode = 'seedance_2_5_edit_template',
  video_model = 'seedance_2_5_edit',
  price_rub = 1,
  duration = 25,
  resolution = '480p',
  available_resolutions = '["480p", "720p", "1080p"]'::jsonb
where slug = 'popstar';
