import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smallDemo = process.argv.includes('--small-demo');
const demoMarker = smallDemo ? 'school-quota-demo-20-2026' : 'school-quota-demo-2026';
const firstStudentId = smallDemo ? 99201 : 99001;
const draftCount = smallDemo ? 4 : 0;
const studentCount = smallDemo ? 20 : 100;
const pendingReviewCount = smallDemo ? 4 : 30;
const approvedCount = smallDemo ? 4 : 10;
const deniedCount = smallDemo ? 4 : 10;
const applicationCount = draftCount + pendingReviewCount + approvedCount + deniedCount;
const profileOnlyCount = studentCount - applicationCount;
const applicationStartIndex = smallDemo ? profileOnlyCount : 0;
const photoFixtureCount = 10;
const bucket = 'application-documents';
const subjectsByPlan = [
  ['วิทยาศาสตร์', 'คณิตศาสตร์'],
  ['คณิตศาสตร์', 'ภาษาอังกฤษ'],
  ['ภาษาอังกฤษ'],
  ['ภาษาอังกฤษ', 'ภาษาไทย'],
  ['ภาษาอังกฤษ', 'ภาษาไทย'],
  ['ภาษาไทย', 'สังคมศึกษาฯ'],
  [],
  [],
  []
];
const maleNames = ['กิตติ', 'ธนกฤต', 'ภาคิน', 'นที', 'ปัณณวิชญ์', 'ภูมิ', 'ณัฐพงศ์', 'ธีรภัทร', 'ปุณณวิช', 'พีรวิชญ์'];
const femaleNames = ['กัญญา', 'พิมพ์ชนก', 'ณิชกานต์', 'ปวีณ์ธิดา', 'ธัญชนก', 'อริสา', 'ณัฐธิดา', 'ชลธิชา', 'กมลชนก', 'ปาริชาติ'];
const surnames = ['ใจดี', 'แสงทอง', 'สุขสันต์', 'บุญช่วย', 'ศรีสวัสดิ์', 'คำมี', 'จันทร์หอม', 'แก้วมณี', 'อินทร์รักษา', 'พูนผล'];
const rooms = ['MEP', 'SMTE', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

function createRandom(seed) {
  let state = 2166136261;
  for (const character of seed) {
    state = Math.imul(state ^ character.charCodeAt(0), 16777619) >>> 0;
  }
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function csvCell(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function makeStudents(seed) {
  const random = createRandom(seed);
  const pick = (items) => items[Math.floor(random() * items.length)];
  return Array.from({ length: studentCount }, (_, index) => {
    const studentId = String(firstStudentId + index);
    const isFemale = random() >= 0.5;
    const prefix = isFemale ? 'ด.ญ.' : 'ด.ช.';
    const firstName = pick(isFemale ? femaleNames : maleNames);
    const surname = pick(surnames);
    const month = 1 + Math.floor(random() * 12);
    const day = 1 + Math.floor(random() * 28);
    const year = 2552 + Math.floor(random() * 3);
    const dateOfBirth = `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
    const fullName = `${prefix} ${firstName} ${surname} [DEMO]`;
    const classRoom = pick(rooms);
    const seatNumber = String(1 + Math.floor(random() * 40));
    const authEmail = `student-${studentId}@login.schoolquota.invalid`;
    return {
      studentId,
      prefix,
      firstName,
      surname,
      fullName,
      dateOfBirth,
      authEmail,
      classRoom,
      seatNumber,
      userId: null
    };
  });
}

function makeApplication(student, index, seed, reviewerId) {
  const random = createRandom(`${seed}:${student.studentId}`);
  const status = index < draftCount
    ? 'draft'
    : index < draftCount + pendingReviewCount
      ? 'submitted'
      : index < draftCount + pendingReviewCount + approvedCount
        ? 'approved'
        : 'denied';
  const firstChoice = Math.floor(random() * subjectsByPlan.length);
  const choices = [firstChoice];
  if (random() > 0.35) {
    let secondChoice = Math.floor(random() * subjectsByPlan.length);
    while (secondChoice === firstChoice) {
      secondChoice = Math.floor(random() * subjectsByPlan.length);
    }
    choices.push(secondChoice);
  }
  const subjects = [...new Set(choices.flatMap((choice) => subjectsByPlan[choice]))];
  const scores = {};
  for (const subject of subjects) {
    for (let term = 0; term < 5; term += 1) {
      scores[`${subject}-${term}`] = (2 + random() * 2).toFixed(2);
    }
    scores[`average:${subject}`] = (2.5 + random() * 1.5).toFixed(2);
  }
  const pathFor = (kind) => `${student.userId}/${kind}/demo-${student.studentId}-${kind}.png`;
  const documentPaths = status === 'draft'
    ? {}
    : { photo: pathFor('photo'), transcript: pathFor('transcript'), conduct: pathFor('conduct') };
  const submittedAt = status === 'draft' ? null : new Date().toISOString();
  const reviewedAt = status === 'submitted' ? null : submittedAt;
  return {
    application: {
      user_id: student.userId,
      form_data: {
        demo_seed: demoMarker,
        prefix: student.prefix,
        applicant_name: `${student.firstName} ${student.surname}`,
        class_room: student.classRoom,
        seat_number: student.seatNumber,
        total_gpa: (2.5 + random() * 1.5).toFixed(2),
        address: {
          house: `บ้านทดสอบ ${student.studentId}`,
          moo: String(1 + Math.floor(random() * 12)),
          road: 'ถนนตัวอย่าง',
          subdistrict: 'ตำบลทดสอบ',
          district: 'อำเภอทดสอบ',
          province: 'จังหวัดทดสอบ',
          phone: '0000000000'
        },
        choices,
        scores
      },
      document_paths: documentPaths,
      updated_at: new Date().toISOString()
    },
    review: {
      user_id: student.userId,
      status,
      reason: status === 'denied' ? 'ไม่ผ่านเกณฑ์ตัวอย่าง (ข้อมูลทดสอบ)' : null,
      submitted_at: submittedAt,
      reviewed_at: reviewedAt,
      reviewed_by: reviewedAt ? reviewerId : null
    }
  };
}

async function getProjectUrl() {
  if (process.env.SUPABASE_URL) {
    return process.env.SUPABASE_URL.replace(/\/+$/, '');
  }
  const clientSource = await readFile(path.join(root, 'supabase-client.js'), 'utf8');
  const match = clientSource.match(/const SUPABASE_URL = '([^']+)'/);
  if (!match) {
    throw new Error('Set SUPABASE_URL because it could not be read from supabase-client.js');
  }
  return match[1];
}

function makeApi(baseUrl, serviceRoleKey) {
  async function request(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers
      }
    });
    const text = await response.text();
    let result = null;
    if (text) {
      try {
        result = JSON.parse(text);
      } catch {
        result = text;
      }
    }
    if (!response.ok) {
      throw new Error(`Supabase request failed (${response.status}): ${typeof result === 'string' ? result : JSON.stringify(result)}`);
    }
    return result;
  }

  return {
    auth: (endpoint, options = {}) => request(`${baseUrl}/auth/v1${endpoint}`, options),
    rest: (endpoint, options = {}) => request(`${baseUrl}/rest/v1/${endpoint}`, options),
    async upload(objectPath, contents) {
      const encodedPath = objectPath.split('/').map(encodeURIComponent).join('/');
      const response = await fetch(`${baseUrl}/storage/v1/object/${bucket}/${encodedPath}`, {
        method: 'POST',
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          'Content-Type': 'image/png',
          'x-upsert': 'true'
        },
        body: contents
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Storage upload failed (${response.status}): ${detail}`);
      }
    }
  };
}

async function listAuthUsers(api) {
  const users = [];
  for (let page = 1; ; page += 1) {
    const result = await api.auth(`/admin/users?page=${page}&per_page=1000`);
    const pageUsers = result.users || [];
    users.push(...pageUsers);
    if (pageUsers.length < 1000) {
      return users;
    }
  }
}

function inFilter(values) {
  return `in.(${values.join(',')})`;
}

async function checkExistingData(api, students, authUsers) {
  const usersByEmail = new Map(authUsers.map((user) => [user.email.toLowerCase(), user]));
  for (const student of students) {
    const existing = usersByEmail.get(student.authEmail);
    if (existing && existing.user_metadata?.demo_seed !== demoMarker) {
      throw new Error(`Refusing to overwrite an existing non-demo Auth user for student ${student.studentId}`);
    }
    student.userId = existing?.id || null;
  }

  const ids = students.map((student) => student.studentId);
  const profiles = await api.rest(`profiles?select=user_id,student_id,full_name&student_id=${encodeURIComponent(inFilter(ids))}`);
  const profilesByStudentId = new Map(profiles.map((profile) => [profile.student_id, profile]));
  for (const student of students) {
    const profile = profilesByStudentId.get(student.studentId);
    if (!profile) {
      continue;
    }
    const existing = usersByEmail.get(student.authEmail);
    if (!existing || profile.user_id !== existing.id || !profile.full_name.endsWith(' [DEMO]')) {
      throw new Error(`Refusing to overwrite existing profile for student ${student.studentId}`);
    }
  }

  const existingUserIds = profiles.map((profile) => profile.user_id);
  if (existingUserIds.length) {
    const filter = encodeURIComponent(inFilter(existingUserIds));
    const applications = await api.rest(`applications?select=user_id,form_data&user_id=${filter}`);
    const appByUser = new Map(applications.map((application) => [application.user_id, application]));
    const applicationUserIds = new Set(
      students.slice(applicationStartIndex, applicationStartIndex + applicationCount)
        .map((student) => student.userId)
        .filter(Boolean)
    );
    for (const application of applications) {
      if (application.form_data?.demo_seed !== demoMarker) {
        throw new Error(`Refusing to overwrite a non-demo application for user ${application.user_id}`);
      }
      if (!applicationUserIds.has(application.user_id)) {
        throw new Error(`Expected profile-only demo student ${application.user_id} to have no application`);
      }
    }
    const reviews = await api.rest(`application_reviews?select=user_id&user_id=${filter}`);
    for (const review of reviews) {
      if (!appByUser.has(review.user_id)) {
        throw new Error(`Refusing to overwrite an unmarked review for user ${review.user_id}`);
      }
    }
  }
  return usersByEmail;
}

async function provisionAuthUsers(api, students, usersByEmail) {
  for (const [index, student] of students.entries()) {
    const body = {
      email: student.authEmail,
      password: student.dateOfBirth,
      email_confirm: true,
      user_metadata: { demo_seed: demoMarker, student_id: student.studentId }
    };
    const existing = usersByEmail.get(student.authEmail);
    const result = existing
      ? await api.auth(`/admin/users/${encodeURIComponent(existing.id)}`, { method: 'PUT', body: JSON.stringify(body) })
      : await api.auth('/admin/users', { method: 'POST', body: JSON.stringify(body) });
    student.userId = result.user?.id || result.id;
    if (!student.userId) {
      throw new Error(`Supabase Auth did not return a user ID for student ${student.studentId}`);
    }
    if ((index + 1) % 25 === 0) {
      console.log(`Provisioned ${index + 1}/${students.length} demo accounts`);
    }
  }
}

async function seed() {
  const seedValue = process.env.DEMO_SEED || (smallDemo ? 'taphanhin-quota-20-2569' : 'taphanhin-quota-2569');
  const students = makeStudents(seedValue);
  const fixtureDirectory = path.join(root, 'test-data', 'demo-documents');
  const fixtureNames = [
    ...Array.from({ length: photoFixtureCount }, (_, index) => `avatar-${String(index + 1).padStart(2, '0')}.png`),
    'transcript.png',
    'conduct.png'
  ];
  const fixtures = new Map();
  for (const name of fixtureNames) {
    fixtures.set(name, await readFile(path.join(fixtureDirectory, name)));
  }

  if (process.argv.includes('--dry-run')) {
    const generated = students.slice(applicationStartIndex, applicationStartIndex + applicationCount).map((student, index) => {
      student.userId = `dry-run-${student.studentId}`;
      return makeApplication(student, index, seedValue, null);
    });
    const statusCounts = { draft: 0, submitted: 0, approved: 0, denied: 0 };
    let documentCount = 0;
    for (const item of generated) {
      statusCounts[item.review.status] += 1;
      const pathCount = Object.keys(item.application.document_paths).length;
      documentCount += pathCount;
      if (pathCount !== (item.review.status === 'draft' ? 0 : 3)) {
        throw new Error(`Unexpected document count for status ${item.review.status}.`);
      }
      if (
        (item.review.status === 'draft' && (item.review.submitted_at !== null || item.review.reviewed_at !== null))
        || (item.review.status === 'submitted' && (item.review.submitted_at === null || item.review.reviewed_at !== null))
        || (['approved', 'denied'].includes(item.review.status) && (item.review.submitted_at === null || item.review.reviewed_at === null))
      ) {
        throw new Error(`Unexpected review timestamp for status ${item.review.status}.`);
      }
    }
    if (
      statusCounts.draft !== draftCount
      || statusCounts.submitted !== pendingReviewCount
      || statusCounts.approved !== approvedCount
      || statusCounts.denied !== deniedCount
    ) {
      throw new Error(`Unexpected review status counts: ${JSON.stringify(statusCounts)}`);
    }
    console.log(`Dry run: ${students.length} students, ${profileOnlyCount} profile-only, ${statusCounts.draft} draft, ${statusCounts.submitted} awaiting review, ${statusCounts.approved} approved, ${statusCounts.denied} denied, ${documentCount} documents.`);
    console.log(`Generated ${fixtureNames.length} synthetic image fixtures. No network calls were made.`);
    return;
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error('Set SUPABASE_SERVICE_ROLE_KEY in the local environment; never put it in source code or the browser.');
  }
  const api = makeApi(await getProjectUrl(), serviceRoleKey);
  const authUsers = await listAuthUsers(api);
  const usersByEmail = await checkExistingData(api, students, authUsers);
  await provisionAuthUsers(api, students, usersByEmail);

  const profiles = students.map((student) => ({
    user_id: student.userId,
    role: 'student',
    student_id: student.studentId,
    full_name: student.fullName,
    class_room: student.classRoom,
    seat_number: student.seatNumber
  }));
  await api.rest('profiles?on_conflict=user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(profiles)
  });

  const staffProfiles = await api.rest(
    `profiles?select=user_id&role=${encodeURIComponent(inFilter(['teacher', 'admin']))}&order=created_at.asc&limit=1`
  );
  const reviewerId = staffProfiles[0]?.user_id || null;
  const generated = students.slice(applicationStartIndex, applicationStartIndex + applicationCount).map((student, index) =>
    makeApplication(student, index, seedValue, reviewerId)
  );
  for (let index = 0; index < generated.length; index += 1) {
    if (!generated[index].application.document_paths.photo) {
      continue;
    }
    const student = students[applicationStartIndex + index];
    const avatarNumber = (index % photoFixtureCount) + 1;
    const uploads = [
      [generated[index].application.document_paths.photo, fixtures.get(`avatar-${String(avatarNumber).padStart(2, '0')}.png`)],
      [generated[index].application.document_paths.transcript, fixtures.get('transcript.png')],
      [generated[index].application.document_paths.conduct, fixtures.get('conduct.png')]
    ];
    for (const [objectPath, contents] of uploads) {
      await api.upload(objectPath, contents);
    }
  }

  await api.rest('applications?on_conflict=user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(generated.map((item) => item.application))
  });
  await api.rest('application_reviews?on_conflict=user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(generated.map((item) => item.review))
  });

  const csv = [
    ['student_id', 'full_name', 'date_of_birth', 'auth_alias'].map(csvCell).join(','),
    ...students.map((student) => [student.studentId, student.fullName, student.dateOfBirth, student.authEmail].map(csvCell).join(','))
  ].join('\r\n');
  await writeFile(path.join(root, 'test-data', 'demo-student-logins.csv'), `\uFEFF${csv}`, 'utf8');
  console.log(`Seed complete: ${students.length} demo students; ${profileOnlyCount} profile-only; ${draftCount} draft; ${pendingReviewCount} pending review; ${approvedCount} approved; ${deniedCount} denied; ${(pendingReviewCount + approvedCount + deniedCount) * 3} documents uploaded.`);
  console.log('Demo login credentials were written to test-data/demo-student-logins.csv. Keep this file private to the test environment.');
}

seed().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
