-- Run this once in the NEW project's Supabase SQL Editor, after creating the
-- administrator account under Authentication > Users.
-- Replace both values below. Never put the password in this file.
do $$
declare
  admin_email text := 'REPLACE_WITH_ADMIN_EMAIL';
  admin_full_name text := 'REPLACE_WITH_ADMIN_NAME';
  admin_user_id uuid;
begin
  if admin_email = 'REPLACE_WITH_ADMIN_EMAIL'
     or length(btrim(admin_full_name)) = 0 then
    raise exception 'Replace admin_email and admin_full_name before running this script';
  end if;

  select id into admin_user_id
  from auth.users
  where lower(email) = lower(btrim(admin_email));

  if admin_user_id is null then
    raise exception 'No Auth user found for %. Create the user in Authentication first.', admin_email;
  end if;

  if exists (
    select 1 from public.profiles
    where user_id = admin_user_id and role = 'student'
  ) then
    raise exception 'This Auth user already belongs to a student profile. Use a separate Auth account for the administrator.';
  end if;

  insert into public.profiles (user_id, role, student_id, full_name, class_room, seat_number)
  values (admin_user_id, 'admin', null, btrim(admin_full_name), null, null)
  on conflict (user_id) do update
    set role = 'admin',
        student_id = null,
        full_name = excluded.full_name,
        class_room = null,
        seat_number = null;
end;
$$;
