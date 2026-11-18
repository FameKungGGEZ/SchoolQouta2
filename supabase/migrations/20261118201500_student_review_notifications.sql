create policy "Students receive their own review notifications"
  on realtime.messages for select to authenticated
  using (
    extension = 'broadcast'
    and realtime.topic() = 'student-review:' || (select auth.uid())::text
  );

create function public.notify_student_review_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is distinct from old.status or new.reason is distinct from old.reason then
    perform realtime.send(
      '{}'::jsonb,
      'review-changed',
      'student-review:' || new.user_id::text,
      true
    );
  end if;
  return new;
end;
$$;

revoke all on function public.notify_student_review_change() from public;

create trigger notify_student_review_change
  after update of status, reason on public.application_reviews
  for each row execute function public.notify_student_review_change();
