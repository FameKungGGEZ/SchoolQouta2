(function () {
  const $ = (id) => document.getElementById(id);
  let rows = [];
  let rowIssues = [];

  const aliases = {
    student_id: ['รหัสประจำตัว', 'รหัสนักเรียน', 'เลขประจำตัว', 'studentid'],
    prefix: ['คำนำหน้า', 'prefix'],
    given_name: ['ชื่อ', 'ชื่อจริง', 'firstname', 'givenname'],
    surname: ['สกุล', 'นามสกุล', 'lastname', 'surname'],
    date_of_birth: ['วันเกิด', 'วันเดือนปีเกิด', 'dateofbirth', 'dob'],
    class_room: ['ห้อง', 'ห้องเรียน', 'class', 'classroom'],
    seat_number: ['เลขที่', 'ที่', 'seat', 'seatnumber']
  };
  const normalizeHeader = (value) => String(value || '').replace(/^\ufeff/, '').replace(/[\s_\-\.]/g, '').toLowerCase();
  const safeText = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);

  function normalizeDate(value) {
    if (typeof value === 'number' && window.XLSX) {
      const date = XLSX.SSF.parse_date_code(value);
      if (date) return `${String(date.d).padStart(2, '0')}/${String(date.m).padStart(2, '0')}/${date.y + 543}`;
    }
    const raw = String(value || '').trim();
    if (/^\d{4,5}$/.test(raw) && window.XLSX) {
      const date = XLSX.SSF.parse_date_code(Number(raw));
      if (date) return `${String(date.d).padStart(2, '0')}/${String(date.m).padStart(2, '0')}/${date.y + 543}`;
    }
    let match = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
    if (match) {
      let year = Number(match[3]);
      if (year < 2400) year += 543;
      return `${match[1].padStart(2, '0')}/${match[2].padStart(2, '0')}/${year}`;
    }
    match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match) {
      let year = Number(match[1]);
      if (year < 2400) year += 543;
      return `${match[3].padStart(2, '0')}/${match[2].padStart(2, '0')}/${year}`;
    }
    return raw;
  }

  function setMessage(message) {
    if ($('importResult')) $('importResult').textContent = message;
  }

  function validateRows() {
    const seen = new Set();
    rowIssues = [];
    rows.forEach((row, index) => {
      const problems = [];
      if (!/^\d{5}$/.test(row.student_id)) problems.push('รหัสต้องมี 5 หลัก');
      if (seen.has(row.student_id)) problems.push('รหัสซ้ำในไฟล์');
      if (row.student_id) seen.add(row.student_id);
      if (!row.given_name || !row.surname) problems.push('ชื่อ/สกุลไม่ครบ');
      if (!/^\d{2}\/\d{2}\/\d{4}$/.test(row.date_of_birth)) problems.push('วันเกิดไม่ถูกต้อง');
      if (problems.length) rowIssues.push(`แถว ${index + 2}: ${problems.join(', ')}`);
    });
  }

  function renderPreview() {
    validateRows();
    const preview = $('importPreview');
    if (!preview) return;
    const sample = rows.slice(0, 5);
    preview.innerHTML = `<b>ตัวอย่างข้อมูล ${sample.length} จาก ${rows.length} รายการ</b><div class="import-table-wrap"><table class="import-table"><thead><tr><th>รหัส</th><th>ชื่อ - สกุล</th><th>ห้อง</th><th>สถานะข้อมูล</th></tr></thead><tbody>${sample.map((row, index) => `<tr><td>${safeText(row.student_id)}</td><td>${safeText(`${row.prefix} ${row.given_name} ${row.surname}`.trim())}</td><td>${safeText(row.class_room || '—')}</td><td>${safeText(rowIssues.find((issue) => issue.startsWith(`แถว ${index + 2}:`)) || 'พร้อมนำเข้า')}</td></tr>`).join('')}</tbody></table></div>`;
    preview.classList.remove('hidden');
    $('importSubmitButton').disabled = rowIssues.length > 0;
    setMessage(rowIssues.length
      ? `พบข้อผิดพลาด ${rowIssues.length} แถว กรุณาแก้ไฟล์ก่อนนำเข้า`
      : `อ่านได้ ${rows.length} รายการ · วันเกิดจะใช้เป็นรหัสผ่านเข้าสู่ระบบ`);
  }

  window.downloadStudentImportTemplate = function () {
    const csv = 'รหัสประจำตัว,คำนำหน้า,ชื่อ,สกุล,วันเกิด,ห้อง,เลขที่\n99999,ด.ช.,ตัวอย่าง,นักเรียน,01/01/2553,MEP,1';
    const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'ตัวอย่างนำเข้าข้อมูลนักเรียน.csv';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  window.handleStudentImportFile = function (input) {
    const file = input.files?.[0];
    if (!file) return;
    rows = [];
    $('importSubmitButton').disabled = true;
    $('importPreview').classList.add('hidden');
    setMessage('กำลังอ่านไฟล์…');
    if (!window.XLSX) {
      setMessage('โหลดตัวอ่าน Excel ไม่สำเร็จ กรุณารีเฟรชหน้าแล้วลองใหม่');
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setMessage('อ่านไฟล์ไม่สำเร็จ');
    reader.onload = () => {
      try {
        const workbook = XLSX.read(reader.result, { type: 'array', cellDates: false });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const matrix = XLSX.utils.sheet_to_json(firstSheet, { header: 1, raw: true, defval: '' });
        if (matrix.length < 2) throw new Error('ไฟล์ไม่มีแถวข้อมูล');
        const headers = matrix[0].map(normalizeHeader);
        const missing = ['student_id', 'given_name', 'surname', 'date_of_birth']
          .filter((key) => !headers.some((header) => aliases[key].some((alias) => normalizeHeader(alias) === header)));
        if (missing.length) throw new Error('ไม่พบหัวตารางที่จำเป็น: รหัสประจำตัว, ชื่อ, สกุล, วันเกิด');
        const getValue = (cells, field) => {
          const index = headers.findIndex((header) => aliases[field].some((alias) => normalizeHeader(alias) === header));
          return index < 0 ? '' : cells[index] ?? '';
        };
        rows = matrix.slice(1).map((cells) => ({
          student_id: (() => { const value = getValue(cells, 'student_id'); return typeof value === 'number' ? String(value).padStart(5, '0') : String(value).trim(); })(),
          prefix: String(getValue(cells, 'prefix')).trim(),
          given_name: String(getValue(cells, 'given_name')).trim(),
          surname: String(getValue(cells, 'surname')).trim(),
          date_of_birth: normalizeDate(getValue(cells, 'date_of_birth')),
          class_room: String(getValue(cells, 'class_room')).trim(),
          seat_number: String(getValue(cells, 'seat_number')).trim()
        })).filter((row) => row.student_id || row.given_name || row.surname);
        if (!rows.length) throw new Error('ไม่พบแถวข้อมูลนักเรียน');
        renderPreview();
      } catch (error) {
        rows = [];
        setMessage(error.message || 'อ่านไฟล์ไม่สำเร็จ');
      }
    };
    reader.readAsArrayBuffer(file);
  };

  window.submitStudentImportFile = async function () {
    if (!rows.length || rowIssues.length) return;
    if (rows.length > 500) {
      setMessage('นำเข้าได้ไม่เกิน 500 รายการต่อครั้ง');
      return;
    }
    if (!window.confirm(`ยืนยันนำเข้าหรือปรับปรุงบัญชีนักเรียน ${rows.length} รายการ? วันเกิดจะถูกตั้งเป็นรหัสผ่านของแต่ละคน`)) return;
    const button = $('importSubmitButton');
    button.disabled = true;
    button.textContent = 'กำลังนำเข้า…';
    setMessage('กำลังบันทึกบัญชีและข้อมูลนักเรียน…');
    try {
      const result = await window.importStudentRows(rows);
      const failures = result.failed || [];
      setMessage(`นำเข้าใหม่ ${result.imported || 0} คน · ปรับปรุง ${result.updated || 0} คน · ไม่สำเร็จ ${failures.length} รายการ${failures.length ? ` · ${failures.map((item) => `แถว ${item.row_number}: ${item.message}`).join(' | ')}` : ''}`);
      if (!failures.length) {
        rows = [];
        $('importPreview').classList.add('hidden');
        $('excelFile').value = '';
        if (window.refreshImportedStudentList) await window.refreshImportedStudentList();
      }
    } catch (error) {
      const body = error.importResponseInfo || {};
      const failed = body.failed || [];
      setMessage((body.error || error.message || 'นำเข้าไม่สำเร็จ')
        + (failed.length ? ` · ${failed.map((item) => `แถว ${item.row_number}: ${item.issues?.join(', ') || item.message}`).join(' | ')}` : ''));
    } finally {
      button.textContent = 'นำเข้านักเรียน';
      button.disabled = !rows.length || rowIssues.length > 0;
    }
  };
})();
