create table public.admission_schedule_announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 1 and 160),
  content text not null check (length(btrim(content)) between 1 and 1200),
  start_date date not null,
  end_date date not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint admission_schedule_date_order check (end_date >= start_date)
);

create index admission_schedule_dates_idx
  on public.admission_schedule_announcements (start_date, end_date, sort_order);

alter table public.admission_schedule_announcements enable row level security;

create policy "Admission schedule is public"
  on public.admission_schedule_announcements for select
  using (true);

create policy "School staff manage admission schedule"
  on public.admission_schedule_announcements for all to authenticated
  using (public.is_school_staff())
  with check (public.is_school_staff());

grant select on public.admission_schedule_announcements to anon, authenticated;
grant insert, update, delete on public.admission_schedule_announcements to authenticated;
