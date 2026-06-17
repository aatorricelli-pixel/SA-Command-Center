create extension if not exists postgis;
create extension if not exists pgcrypto;

create table if not exists public.live_incidents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  category text not null default 'general',
  severity text not null default 'stable',
  status text not null default 'investigating',
  incident_time timestamptz not null default now(),
  source_name text,
  source_url text,
  location_name text,
  province text,
  location geometry(Point, 4326) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint live_incidents_severity_check check (severity in ('stable', 'warning', 'critical')),
  constraint live_incidents_status_check check (status in ('active', 'investigating', 'resolved')),
  constraint live_incidents_category_check check (
    category in (
      'general',
      'natural_disaster',
      'infrastructure',
      'traffic',
      'financial',
      'geopolitical'
    )
  )
);

create index if not exists live_incidents_location_gix
  on public.live_incidents
  using gist (location);

create index if not exists live_incidents_status_time_idx
  on public.live_incidents (status, incident_time desc);

create index if not exists live_incidents_category_idx
  on public.live_incidents (category);

create index if not exists live_incidents_province_idx
  on public.live_incidents (province);
