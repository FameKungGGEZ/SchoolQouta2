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
