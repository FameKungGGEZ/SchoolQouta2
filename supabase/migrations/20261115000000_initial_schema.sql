create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('student', 'teacher', 'admin')),
  student_id text unique,
  full_name text not null,
  class_room text,
  seat_number text,
  created_at timestamptz not null default now(),
  constraint profiles_student_id_format check (
    student_id is null or student_id ~ '^[0-9]{5}$'
  ),
  constraint profiles_student_id_by_role check (
    (role = 'student' and student_id is not null)
    or (role <> 'student' and student_id is null)
  )
);

create table public.applications (
  user_id uuid primary key references public.profiles (user_id) on delete cascade,
  form_data jsonb not null default '{}'::jsonb,
  document_paths jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.application_reviews (
  user_id uuid primary key references public.profiles (user_id) on delete cascade,
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'changes_requested', 'approved', 'denied', 'final_approved')),
  reason text,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles (user_id) on delete set null
);

create index applications_updated_at_idx on public.applications (updated_at desc);
create index application_reviews_status_idx on public.application_reviews (status);

create or replace function public.is_school_staff()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles
    where user_id = auth.uid()
      and role in ('teacher', 'admin')
  );
$$;

revoke all on function public.is_school_staff() from public;
grant execute on function public.is_school_staff() to authenticated;

create or replace function public.can_edit_application()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles
    where user_id = auth.uid() and role = 'student'
  )
  and (
    not exists (
      select 1 from public.application_reviews
      where user_id = auth.uid()
    )
    or exists (
      select 1 from public.application_reviews
      where user_id = auth.uid() and status in ('draft', 'changes_requested')
    )
  );
$$;

revoke all on function public.can_edit_application() from public;
grant execute on function public.can_edit_application() to authenticated;

alter table public.profiles enable row level security;
alter table public.applications enable row level security;
alter table public.application_reviews enable row level security;

create policy "Profiles are visible to their owner and staff"
  on public.profiles for select to authenticated
  using (user_id = auth.uid() or public.is_school_staff());

create policy "Students can view their own application"
  on public.applications for select to authenticated
  using (user_id = auth.uid() or public.is_school_staff());

create policy "Students can create their own application"
  on public.applications for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.profiles
      where user_id = auth.uid() and role = 'student'
    )
  );

create policy "Students can edit a draft or requested changes"
  on public.applications for update to authenticated
  using (
    user_id = auth.uid()
    and public.can_edit_application()
  )
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.profiles
      where user_id = auth.uid() and role = 'student'
    )
  );

create policy "Staff can manage applications"
  on public.applications for all to authenticated
  using (public.is_school_staff())
  with check (public.is_school_staff());

create policy "Users can view their own review"
  on public.application_reviews for select to authenticated
  using (user_id = auth.uid() or public.is_school_staff());

create policy "Staff can manage application reviews"
  on public.application_reviews for all to authenticated
  using (public.is_school_staff())
  with check (public.is_school_staff());

grant select on public.profiles to authenticated;
grant select, insert, update on public.applications to authenticated;
grant select, update on public.application_reviews to authenticated;

create or replace function public.submit_application()
returns void
language plpgsql
security definer
set search_path = public, storage, pg_temp
as $$
declare
  applicant_id uuid := auth.uid();
  application_row public.applications%rowtype;
  review_status text;
  required_document text;
begin
  if applicant_id is null then
    raise exception 'Authentication required';
  end if;

  if not exists (
    select 1 from public.profiles
    where user_id = applicant_id and role = 'student'
  ) then
    raise exception 'Student account required';
  end if;

  select * into application_row
  from public.applications
  where user_id = applicant_id;

  if not found then
    raise exception 'Application not found';
  end if;

  if coalesce(application_row.form_data->>'applicant_name', '') = '' then
    raise exception 'Application details are incomplete';
  end if;

  if jsonb_typeof(application_row.form_data->'choices') is distinct from 'array' then
    raise exception 'Application details are incomplete';
  end if;

  if jsonb_array_length(application_row.form_data->'choices') not between 1 and 2 then
    raise exception 'Application details are incomplete';
  end if;

  foreach required_document in array array['photo', 'transcript', 'conduct'] loop
    if coalesce(application_row.document_paths->>required_document, '') not like (applicant_id::text || '/%') then
      raise exception 'Required document is missing: %', required_document;
    end if;
    if not exists (
      select 1 from storage.objects
      where bucket_id = 'application-documents'
        and name = application_row.document_paths->>required_document
    ) then
      raise exception 'Required document was not uploaded: %', required_document;
    end if;
  end loop;

  select status into review_status
  from public.application_reviews
  where user_id = applicant_id
  for update;

  if review_status is not null and review_status not in ('draft', 'changes_requested') then
    raise exception 'Application cannot be submitted in its current state';
  end if;

  insert into public.application_reviews (user_id, status, reason, submitted_at, reviewed_at, reviewed_by)
  values (applicant_id, 'submitted', null, now(), null, null)
  on conflict (user_id) do update
    set status = 'submitted',
        reason = null,
        submitted_at = excluded.submitted_at,
        reviewed_at = null,
        reviewed_by = null;
end;
$$;

revoke all on function public.submit_application() from public;
grant execute on function public.submit_application() to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'application-documents',
  'application-documents',
  false,
  20971520,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy "Students upload documents to their own folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'application-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.can_edit_application()
  );

create policy "Students and staff read application documents"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'application-documents'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.is_school_staff()
    )
  );

create policy "Students update their own documents"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'application-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.can_edit_application()
  )
  with check (
    bucket_id = 'application-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.can_edit_application()
  );

create policy "Students delete their own documents"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'application-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.can_edit_application()
  );
