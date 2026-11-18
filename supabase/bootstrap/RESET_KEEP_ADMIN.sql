begin;

delete from auth.users u
using public.profiles p
where p.user_id = u.id
  and p.role = 'student';

commit;
