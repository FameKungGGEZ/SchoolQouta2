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
