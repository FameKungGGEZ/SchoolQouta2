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
