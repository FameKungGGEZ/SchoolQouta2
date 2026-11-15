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
