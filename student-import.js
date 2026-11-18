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

  function parseCsv(text) {
    const source = String(text || '').replace(/^\ufeff/, '');
    const matrix = [];
    let row = [];
    let value = '';
    let quoted = false;
    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      if (quoted && char === '"' && source[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') {
        quoted = !quoted;
      } else if (!quoted && char === ',') {
        row.push(value); value = '';
      } else if (!quoted && (char === '\n' || char === '\r')) {
        if (char === '\r' && source[index + 1] === '\n') index += 1;
        row.push(value); value = '';
        if (row.some((cell) => String(cell).trim())) matrix.push(row);
        row = [];
      } else {
        value += char;
      }
    }
    row.push(value);
    if (row.some((cell) => String(cell).trim())) matrix.push(row);
    if (quoted) throw new Error('ไฟล์ CSV มีเครื่องหมายอัญประกาศไม่ครบ');
    return matrix;
  }

  function formatBirthDate(day, month, year) {
    const numericYear = Number(year);
    const buddhistYear = numericYear < 2400 ? numericYear + 543 : numericYear;
    return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${buddhistYear}`;
  }

  function normalizeDate(value, date1904) {
    const raw = String(value || '').trim();
    if ((typeof value === 'number' || /^\d{4,5}$/.test(raw)) && window.XLSX) {
      const date = XLSX.SSF.parse_date_code(Number(value), { date1904 });
      if (date) return formatBirthDate(date.d, date.m, date.y);
    }
    let match = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
    if (match) {
      return formatBirthDate(match[1], match[2], match[3]);
    }
    match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match) {
      return formatBirthDate(match[3], match[2], match[1]);
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
      const birthDate = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(row.date_of_birth);
      if (!birthDate) {
        problems.push('วันเกิดไม่ถูกต้อง');
      } else {
        const day = Number(birthDate[1]);
        const month = Number(birthDate[2]);
        const year = Number(birthDate[3]) - 543;
        const daysInMonth = month >= 1 && month <= 12 ? new Date(year, month, 0).getDate() : 0;
        if (year < 2400 - 543 || year > 2700 - 543 || day < 1 || day > daysInMonth) {
          problems.push('วันเกิดไม่ถูกต้อง');
        }
      }
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
    setMessage(rowIssues.length
      ? `พบข้อผิดพลาด ${rowIssues.length} แถว กรุณาแก้ไฟล์ก่อนนำเข้า`
      : `อ่านได้ ${rows.length} รายการ · วันเกิดจะใช้เป็นรหัสผ่านเข้าสู่ระบบ`);
  }

  window.downloadStudentImportTemplate = function () {
    if (!window.XLSX) {
      setMessage('โหลดตัวสร้างไฟล์ Excel ไม่สำเร็จ กรุณารีเฟรชหน้าแล้วลองใหม่');
      return;
    }
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ['รหัสประจำตัว', 'คำนำหน้า', 'ชื่อ', 'สกุล', 'วันเกิด', 'ห้อง', 'เลขที่'],
      ['99999', 'ด.ช.', 'ตัวอย่าง', 'นักเรียน', '01/01/2553', 'MEP', '1']
    ]);
    sheet['!cols'] = [{ wch: 16 }, { wch: 12 }, { wch: 18 }, { wch: 18 }, { wch: 16 }, { wch: 12 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(workbook, sheet, 'นักเรียน');
    XLSX.writeFile(workbook, 'ตัวอย่างนำเข้าข้อมูลนักเรียน.xlsx');
  };

  window.handleStudentImportFile = function (input) {
    const file = input.files?.[0];
    if (!file) return;
    rows = [];
    $('importPreview').classList.add('hidden');
    setMessage('กำลังอ่านไฟล์…');
    if (!window.XLSX) {
      setMessage('โหลดตัวอ่าน Excel ไม่สำเร็จ กรุณารีเฟรชหน้าแล้วลองใหม่');
      return;
    }
    const isCsv = /\.csv$/i.test(file.name) || /csv/i.test(file.type);
    const reader = new FileReader();
    reader.onerror = () => setMessage('อ่านไฟล์ไม่สำเร็จ');
    reader.onload = () => {
      try {
        let matrix;
        let date1904 = false;
        if (isCsv) {
          matrix = parseCsv(reader.result);
        } else {
          const workbook = XLSX.read(reader.result, { type: 'array', cellDates: false });
          date1904 = workbook.Workbook?.WBProps?.date1904 === true;
          const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
          matrix = XLSX.utils.sheet_to_json(firstSheet, { header: 1, raw: true, defval: '' });
        }
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
          date_of_birth: normalizeDate(getValue(cells, 'date_of_birth'), date1904),
          class_room: String(getValue(cells, 'class_room')).trim(),
          seat_number: String(getValue(cells, 'seat_number')).trim()
        })).filter((row) => row.student_id || row.given_name || row.surname);
        if (!rows.length) throw new Error('ไม่พบแถวข้อมูลนักเรียน');
        renderPreview();
        if (!rowIssues.length) window.submitStudentImportFile();
      } catch (error) {
        rows = [];
        setMessage(error.message || 'อ่านไฟล์ไม่สำเร็จ');
      }
    };
    if (/\.csv$/i.test(file.name) || /csv/i.test(file.type)) reader.readAsText(file, 'utf-8');
    else reader.readAsArrayBuffer(file);
  };

  window.submitStudentImportFile = async function () {
    if (!rows.length || rowIssues.length) return;
    if (rows.length > 500) {
      setMessage('นำเข้าได้ไม่เกิน 500 รายการต่อครั้ง');
      return;
    }
    if (!window.confirm(`ตรวจสอบตัวอย่างข้อมูลแล้วหรือยัง?\nยืนยันนำเข้าหรือปรับปรุงบัญชีนักเรียน ${rows.length} รายการ? วันเกิดจะถูกตั้งเป็นรหัสผ่านของแต่ละคน`)) {
      setMessage('ยกเลิกการนำเข้าแล้ว หากต้องการนำเข้าให้เลือกไฟล์อีกครั้ง');
      $('excelFile').value = '';
      return;
    }
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
    }
  };
})();
