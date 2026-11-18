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
