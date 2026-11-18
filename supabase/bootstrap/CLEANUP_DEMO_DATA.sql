-- Run manually as postgres in the Supabase SQL Editor.
-- If this reports files, remove those exact objects through the Storage API
-- or Dashboard, then rerun this transaction.
begin;

do $check_schema$
begin
  if to_regclass('public.profiles') is null
    or to_regclass('public.applications') is null
    or to_regclass('public.application_reviews') is null
  then
    raise exception 'SchoolQouta2 tables are missing from this database'
      using hint = 'Open the Supabase project used by the website. For a new project, apply the SchoolQouta2 schema first.';
  end if;
end
$check_schema$;

create temporary table schoolquota_demo_cleanup_targets on commit drop as
select u.id
from auth.users u
join public.profiles p on p.user_id = u.id
where p.role = 'student'
  and u.raw_user_meta_data->>'demo_seed' in (
    'school-quota-demo-2026',
    'school-quota-demo-20-2026'
  );

do $cleanup$
declare
  remaining_files bigint;
  removed_accounts bigint;
begin
  select count(*) into remaining_files
  from storage.objects o
  join schoolquota_demo_cleanup_targets t
    on split_part(o.name, '/', 1) = t.id::text
  where o.bucket_id = 'application-documents';

  if remaining_files > 0 then
    raise exception 'Remove % demo files using the Storage API before deleting accounts', remaining_files;
  end if;

  -- Foreign keys cascade from Auth to the profile, application and review.
  delete from auth.users u
  using schoolquota_demo_cleanup_targets t, public.profiles p
  where u.id = t.id
    and p.user_id = u.id
    and p.role = 'student'
    and u.raw_user_meta_data->>'demo_seed' in (
      'school-quota-demo-2026',
      'school-quota-demo-20-2026'
    );

  get diagnostics removed_accounts = row_count;
  raise notice 'Deleted % demo student accounts', removed_accounts;
end
$cleanup$;

commit;
