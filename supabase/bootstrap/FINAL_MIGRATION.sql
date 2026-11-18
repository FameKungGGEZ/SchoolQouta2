-- FINAL MIGRATION — complete schema snapshot for a NEW, EMPTY Supabase project.
-- This file consolidates the timestamped migrations below for a one-time SQL Editor install.
-- Choose either this snapshot OR `supabase db push`; never run both on the same project.
-- It creates schema, functions, RLS policies, the private Storage bucket, and schedule announcements.
-- It does not copy student rows, Auth users, or Storage files from the test project.

begin;

-- ===== 20261115000000_initial_schema.sql =====
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

-- ===== 20261115170000_remove_final_review.sql =====
update public.application_reviews
set status = 'approved'
where status = 'final_approved';

alter table public.application_reviews
  drop constraint if exists application_reviews_status_check;

alter table public.application_reviews
  add constraint application_reviews_status_check
  check (status in ('draft', 'submitted', 'changes_requested', 'approved', 'denied'));

-- ===== 20261115195000_approved_application_pdfs.sql =====
drop policy if exists "Staff upload application PDFs" on storage.objects;
create policy "Staff upload application PDFs"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'application-documents'
    and public.is_school_staff()
    and (storage.foldername(name))[2] = 'application'
    and array_length(storage.foldername(name), 1) = 2
    and right(lower(name), 4) = '.pdf'
    and exists (
      select 1
      from public.profiles
      where user_id::text = (storage.foldername(name))[1]
        and role = 'student'
    )
  );

drop policy if exists "Staff delete application PDFs" on storage.objects;
create policy "Staff delete application PDFs"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'application-documents'
    and public.is_school_staff()
    and (storage.foldername(name))[2] = 'application'
    and array_length(storage.foldername(name), 1) = 2
    and right(lower(name), 4) = '.pdf'
  );

create or replace function public.approve_application_with_pdf(
  p_target_user_id uuid,
  p_pdf_path text
)
returns text
language plpgsql
security definer
set search_path = public, storage, pg_temp
as $$
declare
  current_status text;
  old_pdf_path text;
begin
  if not public.is_school_staff() then
    raise exception 'School staff account required';
  end if;

  if split_part(p_pdf_path, '/', 1) <> p_target_user_id::text
     or split_part(p_pdf_path, '/', 2) <> 'application'
     or array_length(string_to_array(p_pdf_path, '/'), 1) <> 3
     or right(lower(p_pdf_path), 4) <> '.pdf' then
    raise exception 'Invalid application PDF path';
  end if;

  if not exists (
    select 1
    from storage.objects
    where bucket_id = 'application-documents'
      and name = p_pdf_path
  ) then
    raise exception 'Application PDF was not uploaded';
  end if;

  select status into current_status
  from public.application_reviews
  where user_id = p_target_user_id
  for update;

  if not found or current_status <> 'submitted' then
    raise exception 'Application is not awaiting review';
  end if;

  select document_paths->>'application_pdf' into old_pdf_path
  from public.applications
  where user_id = p_target_user_id
  for update;

  if not found then
    raise exception 'Application not found';
  end if;

  update public.applications
  set document_paths = jsonb_set(
        coalesce(document_paths, '{}'::jsonb),
        '{application_pdf}',
        to_jsonb(p_pdf_path),
        true
      ),
      updated_at = now()
  where user_id = p_target_user_id;

  update public.application_reviews
  set status = 'approved',
      reason = null,
      reviewed_by = auth.uid(),
      reviewed_at = now()
  where user_id = p_target_user_id;

  return old_pdf_path;
end;
$$;

revoke all on function public.approve_application_with_pdf(uuid, text) from public;
grant execute on function public.approve_application_with_pdf(uuid, text) to authenticated;

create or replace function public.reject_application(
  p_target_user_id uuid,
  p_reason text
)
returns text
language plpgsql
security definer
set search_path = public, storage, pg_temp
as $$
declare
  current_status text;
  old_pdf_path text;
begin
  if not public.is_school_staff() then
    raise exception 'School staff account required';
  end if;

  if nullif(trim(p_reason), '') is null then
    raise exception 'A review reason is required';
  end if;

  select status into current_status
  from public.application_reviews
  where user_id = p_target_user_id
  for update;

  if not found or current_status <> 'submitted' then
    raise exception 'Application is not awaiting review';
  end if;

  select document_paths->>'application_pdf' into old_pdf_path
  from public.applications
  where user_id = p_target_user_id
  for update;

  if not found then
    raise exception 'Application not found';
  end if;

  update public.applications
  set document_paths = coalesce(document_paths, '{}'::jsonb) - 'application_pdf',
      updated_at = now()
  where user_id = p_target_user_id;

  update public.application_reviews
  set status = 'changes_requested',
      reason = trim(p_reason),
      reviewed_by = auth.uid(),
      reviewed_at = now()
  where user_id = p_target_user_id;

  return old_pdf_path;
end;
$$;

revoke all on function public.reject_application(uuid, text) from public;
grant execute on function public.reject_application(uuid, text) to authenticated;

create or replace function public.store_approved_application_pdf(
  p_target_user_id uuid,
  p_pdf_path text
)
returns text
language plpgsql
security definer
set search_path = public, storage, pg_temp
as $$
declare
  current_status text;
  current_pdf_path text;
begin
  if not public.is_school_staff() then
    raise exception 'School staff account required';
  end if;

  if split_part(p_pdf_path, '/', 1) <> p_target_user_id::text
     or split_part(p_pdf_path, '/', 2) <> 'application'
     or array_length(string_to_array(p_pdf_path, '/'), 1) <> 3
     or right(lower(p_pdf_path), 4) <> '.pdf' then
    raise exception 'Invalid application PDF path';
  end if;

  if not exists (
    select 1
    from storage.objects
    where bucket_id = 'application-documents'
      and name = p_pdf_path
  ) then
    raise exception 'Application PDF was not uploaded';
  end if;

  select status into current_status
  from public.application_reviews
  where user_id = p_target_user_id
  for update;

  if not found or current_status <> 'approved' then
    raise exception 'Only approved applications can store a PDF';
  end if;

  select document_paths->>'application_pdf' into current_pdf_path
  from public.applications
  where user_id = p_target_user_id
  for update;

  if not found then
    raise exception 'Application not found';
  end if;

  if current_pdf_path is not null then
    return current_pdf_path;
  end if;

  update public.applications
  set document_paths = jsonb_set(
        coalesce(document_paths, '{}'::jsonb),
        '{application_pdf}',
        to_jsonb(p_pdf_path),
        true
      ),
      updated_at = now()
  where user_id = p_target_user_id;

  return p_pdf_path;
end;
$$;

revoke all on function public.store_approved_application_pdf(uuid, text) from public;
grant execute on function public.store_approved_application_pdf(uuid, text) to authenticated;

-- ===== 20261115220000_require_complete_application.sql =====
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

  if coalesce(btrim(application_row.form_data->>'applicant_name'), '') = ''
     or coalesce(btrim(application_row.form_data->>'class_room'), '') = ''
     or coalesce(btrim(application_row.form_data->>'seat_number'), '') = ''
     or coalesce(btrim(application_row.form_data->>'total_gpa'), '') = ''
     or coalesce(btrim(application_row.form_data #>> '{address,house}'), '') = ''
     or coalesce(btrim(application_row.form_data #>> '{address,subdistrict}'), '') = ''
     or coalesce(btrim(application_row.form_data #>> '{address,district}'), '') = ''
     or coalesce(btrim(application_row.form_data #>> '{address,province}'), '') = ''
     or coalesce(btrim(application_row.form_data #>> '{address,phone}'), '') = '' then
    raise exception 'Application details are incomplete';
  end if;

  if jsonb_typeof(application_row.form_data->'choices') is distinct from 'array' then
    raise exception 'Choose two study plans before submitting';
  end if;
  if jsonb_array_length(application_row.form_data->'choices') <> 2 then
    raise exception 'Choose two study plans before submitting';
  end if;

  if jsonb_typeof(application_row.form_data->'scores') is distinct from 'object' then
    raise exception 'All subject scores are required';
  end if;
  if exists (
    select 1
    from jsonb_each_text(application_row.form_data->'scores') as score(key, value)
    where btrim(coalesce(score.value, '')) = ''
  ) then
    raise exception 'All subject scores are required';
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

-- ===== 20261115230000_submit_application_with_pdf.sql =====
drop function if exists public.submit_application();

create or replace function public.submit_application(p_pdf_path text)
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
  where user_id = applicant_id
  for update;

  if not found then
    raise exception 'Application not found';
  end if;

  if coalesce(btrim(application_row.form_data->>'applicant_name'), '') = ''
     or coalesce(btrim(application_row.form_data->>'class_room'), '') = ''
     or coalesce(btrim(application_row.form_data->>'seat_number'), '') = ''
     or coalesce(btrim(application_row.form_data->>'total_gpa'), '') = ''
     or coalesce(btrim(application_row.form_data #>> '{address,house}'), '') = ''
     or coalesce(btrim(application_row.form_data #>> '{address,subdistrict}'), '') = ''
     or coalesce(btrim(application_row.form_data #>> '{address,district}'), '') = ''
     or coalesce(btrim(application_row.form_data #>> '{address,province}'), '') = ''
     or coalesce(btrim(application_row.form_data #>> '{address,phone}'), '') = '' then
    raise exception 'Application details are incomplete';
  end if;

  if jsonb_typeof(application_row.form_data->'choices') is distinct from 'array' then
    raise exception 'Choose two study plans before submitting';
  end if;
  if jsonb_array_length(application_row.form_data->'choices') <> 2 then
    raise exception 'Choose two study plans before submitting';
  end if;

  if jsonb_typeof(application_row.form_data->'scores') is distinct from 'object' then
    raise exception 'All subject scores are required';
  end if;
  if exists (
    select 1
    from jsonb_each_text(application_row.form_data->'scores') as score(key, value)
    where btrim(coalesce(score.value, '')) = ''
  ) then
    raise exception 'All subject scores are required';
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

  if split_part(coalesce(p_pdf_path, ''), '/', 1) <> applicant_id::text
     or split_part(p_pdf_path, '/', 2) <> 'application'
     or array_length(string_to_array(p_pdf_path, '/'), 1) <> 3
     or right(lower(p_pdf_path), 4) <> '.pdf' then
    raise exception 'A valid application PDF is required';
  end if;
  if not exists (
    select 1 from storage.objects
    where bucket_id = 'application-documents'
      and name = p_pdf_path
  ) then
    raise exception 'Application PDF was not uploaded';
  end if;

  select status into review_status
  from public.application_reviews
  where user_id = applicant_id
  for update;

  if review_status is not null and review_status not in ('draft', 'changes_requested') then
    raise exception 'Application cannot be submitted in its current state';
  end if;

  update public.applications
  set document_paths = jsonb_set(
        coalesce(document_paths, '{}'::jsonb),
        '{application_pdf}',
        to_jsonb(p_pdf_path),
        true
      ),
      updated_at = now()
  where user_id = applicant_id;

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

revoke all on function public.submit_application(text) from public;
grant execute on function public.submit_application(text) to authenticated;

-- ===== 20261115233000_store_submitted_application_pdf.sql =====
create or replace function public.store_submitted_application_pdf(
  p_target_user_id uuid,
  p_pdf_path text
)
returns text
language plpgsql
security definer
set search_path = public, storage, pg_temp
as $$
declare
  current_status text;
  current_pdf_path text;
begin
  if not public.is_school_staff() then
    raise exception 'School staff account required';
  end if;

  if split_part(coalesce(p_pdf_path, ''), '/', 1) <> p_target_user_id::text
     or split_part(p_pdf_path, '/', 2) <> 'application'
     or array_length(string_to_array(p_pdf_path, '/'), 1) <> 3
     or right(lower(p_pdf_path), 4) <> '.pdf' then
    raise exception 'Invalid application PDF path';
  end if;

  if not exists (
    select 1 from storage.objects
    where bucket_id = 'application-documents'
      and name = p_pdf_path
  ) then
    raise exception 'Application PDF was not uploaded';
  end if;

  select status into current_status
  from public.application_reviews
  where user_id = p_target_user_id
  for update;

  if not found or current_status <> 'submitted' then
    raise exception 'Application is not awaiting review';
  end if;

  select document_paths->>'application_pdf' into current_pdf_path
  from public.applications
  where user_id = p_target_user_id
  for update;

  if not found then
    raise exception 'Application not found';
  end if;

  if current_pdf_path is not null then
    return current_pdf_path;
  end if;

  update public.applications
  set document_paths = jsonb_set(
        coalesce(document_paths, '{}'::jsonb),
        '{application_pdf}',
        to_jsonb(p_pdf_path),
        true
      ),
      updated_at = now()
  where user_id = p_target_user_id;

  return p_pdf_path;
end;
$$;

revoke all on function public.store_submitted_application_pdf(uuid, text) from public;
grant execute on function public.store_submitted_application_pdf(uuid, text) to authenticated;

-- ===== 20261115234000_fix_application_pdf_storage_policies.sql =====
-- Keep generated application PDFs in the applicant's private folder while
-- allowing authenticated school staff to backfill and remove those PDFs.
drop policy if exists "Staff upload application PDFs" on storage.objects;
drop policy if exists "Staff delete application PDFs" on storage.objects;
drop policy if exists "School staff upload PDF applications" on storage.objects;
drop policy if exists "School staff delete PDF applications" on storage.objects;

create policy "School staff upload PDF applications"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'application-documents'
    and public.is_school_staff()
    and (storage.foldername(name))[2] = 'application'
    and array_length(storage.foldername(name), 1) = 2
    and array_length(string_to_array(name, '/'), 1) = 3
    and right(lower(name), 4) = '.pdf'
  );

create policy "School staff delete PDF applications"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'application-documents'
    and public.is_school_staff()
    and (storage.foldername(name))[2] = 'application'
    and array_length(storage.foldername(name), 1) = 2
    and array_length(string_to_array(name, '/'), 1) = 3
    and right(lower(name), 4) = '.pdf'
  );

-- ===== 20261115235000_application_number.sql =====
create sequence if not exists public.application_number_seq;

alter table public.applications
  add column if not exists application_number bigint;

create unique index if not exists applications_application_number_key
  on public.applications (application_number)
  where application_number is not null;

with missing_numbers as (
  select
    a.user_id,
    coalesce((select max(application_number) from public.applications), 0)
      + row_number() over (order by r.submitted_at nulls last, p.student_id)::bigint as application_number
  from public.applications a
  join public.application_reviews r on r.user_id = a.user_id
  join public.profiles p on p.user_id = a.user_id
  where a.application_number is null
    and r.status in ('submitted', 'changes_requested', 'approved', 'denied')
    and r.submitted_at is not null
)
update public.applications a
set application_number = missing_numbers.application_number
from missing_numbers
where a.user_id = missing_numbers.user_id;

select setval(
  'public.application_number_seq',
  coalesce((select max(application_number) from public.applications), 0) + 1,
  false
);

create or replace function public.reserve_application_number()
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  applicant_id uuid := auth.uid();
  assigned_number bigint;
begin
  if applicant_id is null or not exists (
    select 1 from public.profiles
    where user_id = applicant_id and role = 'student'
  ) then
    raise exception 'Student account required';
  end if;

  select application_number into assigned_number
  from public.applications
  where user_id = applicant_id
  for update;

  if not found then
    raise exception 'Application not found';
  end if;

  if assigned_number is null then
    assigned_number := nextval('public.application_number_seq');
    update public.applications
    set application_number = assigned_number,
        updated_at = now()
    where user_id = applicant_id;
  end if;

  return assigned_number;
end;
$$;

revoke all on function public.reserve_application_number() from public;
grant execute on function public.reserve_application_number() to authenticated;

-- ===== 20261115235500_numbers_on_approval.sql =====
drop index if exists public.applications_application_number_key;

update public.applications
set application_number = null;

with approved_numbers as (
  select
    a.user_id,
    row_number() over (order by r.reviewed_at nulls last, p.student_id)::bigint as application_number
  from public.applications a
  join public.application_reviews r on r.user_id = a.user_id
  join public.profiles p on p.user_id = a.user_id
  where r.status = 'approved'
)
update public.applications a
set application_number = approved_numbers.application_number
from approved_numbers
where a.user_id = approved_numbers.user_id;

create unique index applications_application_number_key
  on public.applications (application_number)
  where application_number is not null;

drop function if exists public.reserve_application_number();

create or replace function public.reserve_review_application_number(p_target_user_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  assigned_number bigint;
  current_status text;
begin
  if not public.is_school_staff() then
    raise exception 'School staff account required';
  end if;

  lock table public.applications in exclusive mode;

  select status into current_status
  from public.application_reviews
  where user_id = p_target_user_id
  for update;

  if not found or current_status <> 'submitted' then
    raise exception 'Application is not awaiting review';
  end if;

  select application_number into assigned_number
  from public.applications
  where user_id = p_target_user_id
  for update;

  if not found then
    raise exception 'Application not found';
  end if;

  if assigned_number is null then
    select coalesce(max(application_number), 0) + 1 into assigned_number
    from public.applications;

    update public.applications
    set application_number = assigned_number,
        updated_at = now()
    where user_id = p_target_user_id;
  end if;

  return assigned_number;
end;
$$;

create or replace function public.release_review_application_number(p_target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_school_staff() then
    raise exception 'School staff account required';
  end if;

  update public.applications a
  set application_number = null,
      updated_at = now()
  where a.user_id = p_target_user_id
    and exists (
      select 1 from public.application_reviews r
      where r.user_id = a.user_id and r.status = 'submitted'
    );
end;
$$;

revoke all on function public.reserve_review_application_number(uuid) from public;
revoke all on function public.release_review_application_number(uuid) from public;
grant execute on function public.reserve_review_application_number(uuid) to authenticated;
grant execute on function public.release_review_application_number(uuid) to authenticated;

-- ===== 20261116120000_admission_schedule_announcements.sql =====
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


-- ===== 20261118190000_student_cancel_submission.sql =====
create or replace function public.cancel_application_submission()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  applicant_id uuid := auth.uid();
  application_row public.applications%rowtype;
  review_status text;
  old_pdf_path text;
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
  where user_id = applicant_id
  for update;

  if not found then
    raise exception 'Application not found';
  end if;

  select status into review_status
  from public.application_reviews
  where user_id = applicant_id
  for update;

  if not found or review_status <> 'submitted' then
    raise exception 'Only an application awaiting review can be cancelled';
  end if;

  old_pdf_path := application_row.document_paths->>'application_pdf';

  update public.application_reviews
  set status = 'draft',
      reason = null,
      submitted_at = null,
      reviewed_at = null,
      reviewed_by = null
  where user_id = applicant_id;

  update public.applications
  set document_paths = coalesce(document_paths, '{}'::jsonb) - 'application_pdf',
      updated_at = now()
  where user_id = applicant_id;

  return old_pdf_path;
end;
$$;

revoke all on function public.cancel_application_submission() from public;
grant execute on function public.cancel_application_submission() to authenticated;

-- ===== 20261118201500_student_review_notifications.sql =====
create policy "Students receive their own review notifications"
  on realtime.messages for select to authenticated
  using (
    extension = 'broadcast'
    and realtime.topic() = 'student-review:' || (select auth.uid())::text
  );

create function public.notify_student_review_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is distinct from old.status or new.reason is distinct from old.reason then
    perform realtime.send(
      '{}'::jsonb,
      'review-changed',
      'student-review:' || new.user_id::text,
      true
    );
  end if;
  return new;
end;
$$;

revoke all on function public.notify_student_review_change() from public;

create trigger notify_student_review_change
  after update of status, reason on public.application_reviews
  for each row execute function public.notify_student_review_change();

commit;
