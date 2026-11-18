-- Run manually in the SQL Editor of a dedicated SchoolQouta2 project.
-- Replace the UUID below with the Auth user ID of the admin account to keep.
-- That account must have an admin or teacher profile.
begin;

do $reset$
declare
  keep_user_id constant uuid := '00000000-0000-0000-0000-000000000000';
begin
  if to_regclass('public.profiles') is null
    or to_regclass('public.applications') is null
    or to_regclass('public.application_reviews') is null
    or to_regclass('public.admission_schedule_announcements') is null
  then
    raise exception 'SchoolQouta2 tables are missing from this database'
      using hint = 'Open the Supabase project used by your website and check that its schema is installed.';
  end if;

  if not exists (
    select 1
    from auth.users u
    join public.profiles p on p.user_id = u.id
    where u.id = keep_user_id and p.role in ('admin', 'teacher')
  ) then
    raise exception 'The account to keep is not a SchoolQouta2 staff account'
      using hint = 'Set keep_user_id to the UUID of the admin or teacher account you use for the back office.';
  end if;

  if exists (select 1 from storage.objects where bucket_id = 'application-documents') then
    raise exception 'Application files still exist'
      using hint = 'Empty the application-documents bucket through the Storage Dashboard or API, then run this file again.';
  end if;

  delete from public.application_reviews;
  delete from public.applications;
  delete from public.admission_schedule_announcements;
  delete from auth.users where id <> keep_user_id;

  if (select count(*) from auth.users) <> 1
    or (select count(*) from public.profiles) <> 1
    or not exists (select 1 from public.profiles where user_id = keep_user_id)
  then
    raise exception 'Reset did not leave exactly the selected staff account';
  end if;
end
$reset$;

commit;
