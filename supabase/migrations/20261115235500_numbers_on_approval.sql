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
