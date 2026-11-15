import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type StudentRow = {
  student_id: string;
  prefix: string;
  given_name: string;
  surname: string;
  date_of_birth: string;
  class_room: string;
  seat_number: string;
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function validDateOfBirth(value: string) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) return false;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (year < 2400 || year > 2700 || month < 1 || month > 12 || day < 1) return false;
  const gregorianYear = year >= 2400 ? year - 543 : year;
  const daysInMonth = new Date(gregorianYear, month, 0).getDate();
  return day <= daysInMonth;
}

function normalizeRow(input: StudentRow) {
  return {
    student_id: String(input.student_id || '').trim(),
    prefix: String(input.prefix || '').trim(),
    given_name: String(input.given_name || '').trim(),
    surname: String(input.surname || '').trim(),
    date_of_birth: String(input.date_of_birth || '').trim(),
    class_room: String(input.class_room || '').trim(),
    seat_number: String(input.seat_number || '').trim(),
  };
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return response({ error: 'ใช้ได้เฉพาะคำขอ POST' }, 405);

  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return response({ error: 'กรุณาเข้าสู่ระบบผู้ดูแล' }, 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !serviceKey || !anonKey) return response({ error: 'ระบบนำเข้ายังตั้งค่าไม่ครบ' }, 503);

  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await callerClient.auth.getUser();
  if (authError || !authData.user) return response({ error: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' }, 401);

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: staff, error: staffError } = await admin
    .from('profiles')
    .select('role')
    .eq('user_id', authData.user.id)
    .maybeSingle();
  if (staffError || !staff || !['teacher', 'admin'].includes(staff.role)) {
    return response({ error: 'บัญชีนี้ไม่มีสิทธิ์นำเข้าข้อมูลนักเรียน' }, 403);
  }

  let body: { students?: StudentRow[] };
  try {
    body = await request.json();
  } catch {
    return response({ error: 'อ่านข้อมูลไฟล์ไม่สำเร็จ' }, 400);
  }
  if (!Array.isArray(body.students) || body.students.length === 0 || body.students.length > 500) {
    return response({ error: 'ไฟล์ต้องมีนักเรียน 1–500 คนต่อครั้ง' }, 400);
  }

  const seen = new Set<string>();
  const rows = body.students.map(normalizeRow);
  const validation = rows.map((row, index) => {
    const issues: string[] = [];
    if (!/^\d{5}$/.test(row.student_id)) issues.push('รหัสนักเรียนต้องมี 5 หลัก');
    else if (seen.has(row.student_id)) issues.push('รหัสซ้ำในไฟล์');
    if (row.student_id) seen.add(row.student_id);
    if (!row.given_name || !row.surname) issues.push('ต้องระบุชื่อและนามสกุล');
    if (!validDateOfBirth(row.date_of_birth)) issues.push('วันเกิดต้องเป็น วว/ดด/ปปปป');
    if (row.class_room.length > 80 || row.seat_number.length > 20) issues.push('ข้อมูลห้องหรือเลขที่ยาวเกินกำหนด');
    return { row, row_number: index + 2, issues };
  });
  const invalid = validation.filter((item) => item.issues.length);
  if (invalid.length) {
    return response({
      error: 'มีข้อมูลไม่ถูกต้อง กรุณาแก้ไขก่อนนำเข้า',
      failed: invalid.map(({ row_number, issues }) => ({ row_number, issues })),
    }, 422);
  }

  const studentIds = rows.map((row) => row.student_id);
  const { data: existingProfiles, error: profileLookupError } = await admin
    .from('profiles')
    .select('user_id, student_id, role')
    .in('student_id', studentIds);
  if (profileLookupError) return response({ error: 'ตรวจรหัสนักเรียนเดิมไม่สำเร็จ' }, 500);
  const profileById = new Map((existingProfiles || []).map((profile) => [profile.student_id, profile]));

  let imported = 0;
  let updated = 0;
  const failures: Array<{ row_number: number; message: string }> = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const rowNumber = index + 2;
    const email = `student-${row.student_id}@login.schoolquota.invalid`;
    const password = row.date_of_birth;
    const fullName = `${row.prefix ? `${row.prefix} ` : ''}${row.given_name} ${row.surname}`.trim();
    const existing = profileById.get(row.student_id);
    if (existing && existing.role !== 'student') {
      failures.push({ row_number: rowNumber, message: 'รหัสนี้ถูกใช้กับบัญชีเจ้าหน้าที่' });
      continue;
    }

    let userId = existing?.user_id;
    let createdUser = false;
    try {
      if (userId) {
        const { error } = await admin.auth.admin.updateUserById(userId, {
          password,
          user_metadata: { full_name: fullName, student_id: row.student_id },
        });
        if (error) throw error;
      } else {
        const { data, error } = await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { full_name: fullName, student_id: row.student_id },
        });
        if (error || !data.user) throw error || new Error('สร้างบัญชีนักเรียนไม่สำเร็จ');
        userId = data.user.id;
        createdUser = true;
      }

      const { error: saveProfileError } = await admin.from('profiles').upsert({
        user_id: userId,
        role: 'student',
        student_id: row.student_id,
        full_name: fullName,
        class_room: row.class_room || null,
        seat_number: row.seat_number || null,
      }, { onConflict: 'user_id' });
      if (saveProfileError) throw saveProfileError;

      const { error: applicationError } = await admin.from('applications').upsert({
        user_id: userId,
        form_data: {},
        document_paths: {},
      }, { onConflict: 'user_id', ignoreDuplicates: true });
      if (applicationError) throw applicationError;
      const { error: reviewError } = await admin.from('application_reviews').upsert({
        user_id: userId,
        status: 'draft',
      }, { onConflict: 'user_id', ignoreDuplicates: true });
      if (reviewError) throw reviewError;

      if (existing) updated += 1;
      else imported += 1;
    } catch (error) {
      if (createdUser && userId) await admin.auth.admin.deleteUser(userId);
      failures.push({ row_number: rowNumber, message: 'บันทึกไม่สำเร็จ ตรวจว่ารหัสนักเรียนนี้มีบัญชีซ้ำหรือไม่' });
      console.error('Student import row failed', rowNumber, error instanceof Error ? error.message : 'unknown error');
    }
  }

  return response({ imported, updated, failed: failures });
});
