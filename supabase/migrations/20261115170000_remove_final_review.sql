update public.application_reviews
set status = 'approved'
where status = 'final_approved';

alter table public.application_reviews
  drop constraint if exists application_reviews_status_check;

alter table public.application_reviews
  add constraint application_reviews_status_check
  check (status in ('draft', 'submitted', 'changes_requested', 'approved', 'denied'));
