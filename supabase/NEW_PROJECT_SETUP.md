# เตรียม Supabase สำหรับโรงเรียน/ลูกค้าใหม่

ไฟล์ใน `supabase/migrations/` เป็น migration ทั้งชุดของเว็บ เรียงตามเวลา ตั้งแต่สร้างตารางผู้ใช้ ใบสมัคร ผลตรวจ, Storage bucket และ RLS ไปจนถึง RPC สำหรับส่งใบสมัคร/เลขลำดับ และประกาศกำหนดการ ใช้กับ Supabase project เปล่าโดยรัน `db push` ครั้งเดียว ระบบจะ apply ทุก migration ที่ยังไม่มีใน project นั้น

## 1. ตั้งค่าเว็บให้ชี้ไป project ใหม่

สร้าง Supabase project ของโรงเรียนลูกค้า แล้วนำ Project URL และ Publishable key มาแทนค่า `SUPABASE_URL` และ `SUPABASE_PUBLISHABLE_KEY` ที่ต้นไฟล์ `supabase-client.js` ค่า publishable key ใช้ในหน้าเว็บได้ ห้ามนำ Secret หรือ service-role key ไปใส่ในเว็บ

## 2. สร้าง schema และ Storage

ติดตั้ง Supabase CLI และเข้าสู่ระบบ จากโฟลเดอร์โปรเจกต์นี้รัน:

```powershell
npx supabase login
npx supabase link --project-ref <PROJECT_REF_ของลูกค้า>
npx supabase db push
```

ตรวจ target project ที่ CLI แสดงก่อนยืนยันทุกครั้ง คำสั่งนี้ apply ไฟล์ใน `supabase/migrations/` ตามลำดับ และสร้างโครงสร้างฐานข้อมูล/Storage ของเว็บครบ ไม่ได้คัดลอกข้อมูลนักเรียนจาก project ทดสอบ

หากต้องการรันเป็น SQL ก้อนเดียว ให้เปิด `supabase/bootstrap/FINAL_MIGRATION.sql` แล้วรันใน SQL Editor ของ **project ใหม่ที่ยังว่างเท่านั้น** ไฟล์นี้รวม migration timestamped ทั้งชุดไว้แล้ว เลือกใช้วิธีนี้หรือ `supabase db push` เพียงวิธีเดียวใน project เดียว

## 3. ติดตั้งระบบนำเข้านักเรียน

ฟังก์ชันนี้ใช้ service-role key ฝั่ง server เพื่อสร้างบัญชี Auth จึงต้อง deploy Edge Function และเก็บ key เป็น Supabase secret เท่านั้น:

```powershell
npx supabase functions deploy import-students
npx supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY_ของลูกค้า>
```

อย่าส่ง key นี้เข้า Git, แชต หรือไฟล์เว็บ

## 4. สร้างบัญชี Admin

1. ใน Supabase project ใหม่ เปิด **Authentication → Users → Add user** สร้างบัญชีด้วยอีเมลและรหัสผ่านของผู้ดูแล
2. เปิด `supabase/bootstrap/ADMIN_MIGRATION.sql` แทน `REPLACE_WITH_ADMIN_EMAIL` และ `REPLACE_WITH_ADMIN_NAME` ด้วยข้อมูลผู้ดูแล โดยไม่ใส่รหัสผ่าน
3. รันไฟล์นั้นใน **SQL Editor** ของ project ใหม่ เพื่อเชื่อม Auth user กับ `public.profiles` และกำหนด role เป็น `admin`

ไฟล์ SQL แอดมินแยกจาก migration schema โดยตั้งใจ เพราะรหัสผ่าน/ผู้ใช้ Auth เป็นความลับเฉพาะของโรงเรียนและไม่ควรถูกเก็บหรือสร้างจาก Git migration ทั่วไป ไฟล์นี้จะปฏิเสธถ้า Auth user ยังไม่มี หรือบัญชีนั้นถูกใช้เป็นบัญชีนักเรียนแล้ว

## 5. ตั้งค่า Auth และเปิดเว็บ

เพิ่ม URL ที่ใช้จริง (เช่น Vercel และ Local) ใน **Authentication → URL Configuration → Redirect URLs** จากนั้น deploy เว็บตามปกติ นักเรียนและเจ้าหน้าที่เริ่มต้นด้วยข้อมูลของ project ใหม่; ใช้การนำเข้ารายชื่อนักเรียนในหลังบ้านเพื่อสร้างบัญชีนักเรียน

ข้อมูลตัวอย่างและบัญชีทดสอบของ project เก่าจะไม่ถูกส่งไป project ลูกค้าด้วย migration นี้
