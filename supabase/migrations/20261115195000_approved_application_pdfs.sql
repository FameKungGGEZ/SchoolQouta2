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
