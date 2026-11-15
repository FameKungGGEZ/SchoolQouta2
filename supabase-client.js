(function () {
  const SUPABASE_URL = 'https://gvkwltjcbiweuzaalbuw.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_04CGBG01cVYkj-l6-2qK_g_vXfRrIzP';
  const STORAGE_BUCKET = 'application-documents';
  const PDF_JS_CDN_BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/';
  const client = window.supabase && window.supabase.createClient
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY)
    : null;
  const state = {
    user: null,
    profile: null,
    application: null,
    review: null,
    queue: []
  };
  const reviewSettingsKey = 'schoolquota.review-settings';
  let reviewTabCount = 2;
  let reviewDistribution = 'balanced';
  let currentReviewTab = 0;
  let reviewQueueIndex = 0;
  let activeReviewQueue = [];
  let reviewPreviewRequest = 0;
  let reviewPreviewStudent = null;
  let reviewDocumentUrls = {};
  let reviewDocumentErrors = {};
  let currentReviewDocument = 'application';
  let reviewModalMode = 'review';
  const submittedPdfJobs = new Map();
  const submittedPdfRetryAfter = new Map();
  let staffQueueRefreshTimer = null;
  let staffQueueRefreshPending = false;
  let reviewDocumentLoads = {};
  let pdfViewerSource = '';
  let pdfViewerZoom = 100;
  let pdfViewerIsPdf = false;
  let pdfViewerScrollY = 0;
  const reviewSeenDocuments = new Map();
  let pdfJsLibraryPromise = null;
  let pdfJsWorkerPromise = null;
  let pdfJsLoadingSource = '';
  let pdfJsLoadingTask = null;
  let pdfJsLoadingPromise = null;
  let pdfJsDocument = null;
  let pdfJsDocumentSource = '';
  let pdfJsRenderRequest = 0;
  let pdfJsRenderTasks = [];
  let pdfJsPageObserver = null;
  const documentLabels = {
    application: 'ใบสมัคร',
    application_pdf: 'ใบสมัคร PDF',
    photo: 'รูปถ่าย',
    transcript: 'ปพ.1',
    conduct: 'ใบรับรองความประพฤติ'
  };
  const originalClosePdfViewer = window.closePdfViewer;

  function reportError(message, error) {
    console.error(message, error);
    toast(message);
  }

  function lockPdfViewerBackground() {
    if (document.documentElement.classList.contains('pdf-viewer-open')) {
      return;
    }
    pdfViewerScrollY = window.scrollY;
    document.documentElement.classList.add('pdf-viewer-open');
    document.body.classList.add('pdf-viewer-open');
    document.body.style.setProperty('--locked-scroll-y', `-${pdfViewerScrollY}px`);
  }

  function unlockPdfViewerBackground() {
    if (!document.documentElement.classList.contains('pdf-viewer-open')) {
      return;
    }
    document.documentElement.classList.remove('pdf-viewer-open');
    document.body.classList.remove('pdf-viewer-open');
    document.body.style.removeProperty('--locked-scroll-y');
    window.scrollTo(0, pdfViewerScrollY);
  }

  function requireClient() {
    if (!client) {
      throw new Error('Supabase SDK failed to load');
    }
    return client;
  }

  function isStaff() {
    return state.profile && (state.profile.role === 'admin' || state.profile.role === 'teacher');
  }

  function displayStatus(status) {
    return ({
      draft: 'กำลังกรอก',
      submitted: 'รอตรวจ',
      changes_requested: 'แก้ไขเอกสาร',
      approved: 'ผ่าน',
      denied: 'ไม่ผ่าน'
    })[status] || 'ยังไม่ได้ส่ง';
  }

  function setFormValue(id, value) {
    const element = $(id);
    if (element && value !== undefined && value !== null) {
      element.value = value;
    }
  }

  function getSubmissionMissingItems() {
    const form = currentFormData();
    const missing = [];
    if (!form.applicant_name) missing.push('ชื่อ-สกุล');
    if (!form.class_room) missing.push('ห้องเรียน');
    if (!form.seat_number) missing.push('เลขที่');
    if (!form.total_gpa) missing.push('เกรดเฉลี่ย 5 ภาคเรียน');
    if (!form.address.house) missing.push('บ้านเลขที่');
    if (!form.address.subdistrict) missing.push('ตำบล');
    if (!form.address.district) missing.push('อำเภอ');
    if (!form.address.province) missing.push('จังหวัด');
    if (!form.address.phone) missing.push('โทรศัพท์');
    if (selected.length !== 2) missing.push('เลือกแผนการเรียนให้ครบ 2 อันดับ');
    if (Array.from(document.querySelectorAll('#scoreArea [data-score], #scoreArea [data-average]')).some((input) => !String(input.value || '').trim())) {
      missing.push('กรอกคะแนนรายวิชาให้ครบ');
    }
    const paths = state.application && state.application.document_paths || {};
    if (!paths.photo) missing.push('รูปถ่าย');
    if (!paths.transcript) missing.push('ปพ.1');
    if (!paths.conduct) missing.push('ใบรับรองความประพฤติ');
    return missing;
  }

  function refreshSubmitApplicationButton() {
    const button = $('submitApplicationButton');
    if (!button) return;
    const missing = getSubmissionMissingItems();
    button.disabled = missing.length > 0 || !$('confirmAccuracy')?.checked;
    button.title = missing.length ? `ยังกรอกไม่ครบ: ${missing.join(' · ')}` : '';
  }

  function currentFormData() {
    const scores = {};
    document.querySelectorAll('[data-score], [data-average]').forEach((input) => {
      const key = input.dataset.score || `average:${input.dataset.average}`;
      scores[key] = input.value;
    });
    return {
      prefix: $('prefix').value,
      applicant_name: $('applicantName').value.trim(),
      class_room: $('classRoom').value,
      seat_number: $('studentSeat').value.trim(),
      total_gpa: $('totalGpa').value.trim(),
      address: {
        house: $('addrHouse').value.trim(),
        moo: $('addrMoo').value.trim(),
        road: $('addrRoad').value.trim(),
        subdistrict: $('addrSubdistrict').value.trim(),
        district: $('addrDistrict').value.trim(),
        province: $('addrProvince').value.trim(),
        phone: $('addrPhone').value.trim()
      },
      choices: selected.slice(),
      scores
    };
  }

  function fillForm(data) {
    const value = data || {};
    const profileName = state.profile.full_name || '';
    const prefixMatch = profileName.match(/^(ด\.ช\.|ด\.ญ\.|นาย|นางสาว)\s*/);
    setFormValue('prefix', value.prefix || (prefixMatch && prefixMatch[1]) || 'ด.ช.');
    setFormValue('applicantName', value.applicant_name || profileName.replace(/^(ด\.ช\.|ด\.ญ\.|นาย|นางสาว)\s*/, ''));
    setFormValue('classRoom', value.class_room || state.profile.class_room || '');
    setFormValue('studentSeat', value.seat_number || state.profile.seat_number || '');
    setFormValue('totalGpa', value.total_gpa || '');
    const address = value.address || {};
    setFormValue('addrHouse', address.house || '');
    setFormValue('addrMoo', address.moo || '');
    setFormValue('addrRoad', address.road || '');
    setFormValue('addrSubdistrict', address.subdistrict || '');
    setFormValue('addrDistrict', address.district || '');
    setFormValue('addrProvince', address.province || '');
    setFormValue('addrPhone', address.phone || '');
    selected = Array.isArray(value.choices) ? value.choices.filter((choice) => Number.isInteger(choice) && plans[choice]) : [];
    renderPlans();
    Object.keys(value.scores || {}).forEach((key) => {
      if (key.indexOf('average:') === 0) {
        document.querySelectorAll(`[data-average="${CSS.escape(key.slice(8))}"]`).forEach((input) => { input.value = value.scores[key]; });
      } else {
        document.querySelectorAll(`[data-score="${CSS.escape(key)}"]`).forEach((input) => { input.value = value.scores[key]; });
      }
    });
  }

  async function loadProfile(user) {
    const { data, error } = await requireClient()
      .from('profiles')
      .select('user_id, role, student_id, full_name, class_room, seat_number')
      .eq('user_id', user.id)
      .single();
    if (error) {
      throw error;
    }
    state.user = user;
    state.profile = data;
    window.schoolStudentId = data.student_id;
    return data;
  }

  async function loadStudentApplication() {
    const db = requireClient();
    const { data: application, error } = await db
      .from('applications')
      .select('user_id, form_data, document_paths, application_number, updated_at')
      .eq('user_id', state.user.id)
      .maybeSingle();
    if (error) {
      throw error;
    }
    if (application) {
      state.application = application;
    } else {
      const { data: created, error: insertError } = await db
        .from('applications')
        .insert({ user_id: state.user.id, form_data: {}, document_paths: {} })
        .select('user_id, form_data, document_paths, application_number, updated_at')
        .single();
      if (insertError) {
        throw insertError;
      }
      state.application = created;
    }
    const { data: review, error: reviewError } = await db
      .from('application_reviews')
      .select('status, reason, submitted_at')
      .eq('user_id', state.user.id)
      .maybeSingle();
    if (reviewError) {
      throw reviewError;
    }
    state.review = review;
    fillForm(state.application.form_data);
    saved.transcript = Boolean(state.application.document_paths.transcript);
    saved.conduct = Boolean(state.application.document_paths.conduct);
    $('studentStatus').textContent = displayStatus(review && review.status);
    $('studentNo').textContent = state.profile.student_id;
    $('reviewStudentId').textContent = state.profile.student_id || '—';
    const readonlyNumber = document.querySelector('#personal input.readonly');
    if (readonlyNumber) {
      readonlyNumber.value = state.profile.student_id || '';
    }
    const photoPath = state.application.document_paths.photo;
    if (photoPath) {
      const { data: signed, error: signedError } = await db.storage.from(STORAGE_BUCKET).createSignedUrl(photoPath, 3600);
      if (signedError) {
        throw signedError;
      }
      photoUrl = signed.signedUrl;
      $('reviewPhotoImage').src = photoUrl;
      $('photoPreview').innerHTML = `<img src="${photoUrl}" alt="รูปผู้สมัคร"><input id="photoFile" type="file" accept="image/*" onchange="previewPhoto(this)">`;
    }
    updateTracking();
    refreshReview();
  }

  function updateTracking() {
    const status = state.review && state.review.status;
    const badge = $('trackBadge');
    badge.textContent = displayStatus(status);
    badge.className = `badge ${status === 'approved' ? 'ok' : status === 'denied' ? 'no' : 'wait'}`;
    $('trackingMessage').textContent = state.review && state.review.reason
      ? `ครูแจ้งให้แก้ไข: ${state.review.reason}`
      : status === 'submitted'
        ? 'ส่งใบสมัครแล้ว · กำลังรอครูตรวจสอบ'
        : status === 'approved'
          ? 'ครูตรวจเอกสารผ่านแล้ว ดาวน์โหลดใบสมัคร PDF ที่บันทึกไว้เพื่อนำไปลงนาม'
          : 'เมื่อส่งใบสมัครแล้ว ระบบจะแสดงผลการตรวจและเหตุผลกรณีต้องแก้ไขที่นี่';
    $('downloadApp').classList.toggle('hidden', status !== 'approved');
  }

  async function signIn(email, password, expectedRole) {
    const db = requireClient();
    const { data, error } = await db.auth.signInWithPassword({ email, password });
    if (error) {
      throw error;
    }
    try {
      const profile = await loadProfile(data.user);
      if (expectedRole === 'student' && profile.role !== 'student') {
        throw new Error('บัญชีนี้ไม่ได้กำหนดเป็นบัญชีนักเรียน');
      }
      if (expectedRole === 'staff' && !isStaff()) {
        throw new Error('บัญชีนี้ไม่ได้กำหนดเป็นบัญชีครูหรือผู้ดูแล');
      }
      if (expectedRole === 'student') {
        await loadStudentApplication();
        studentLoggedIn = true;
        showStudentHome();
        refreshSubmitApplicationButton();
        refreshReview();
      } else {
        await loadAdminData();
        hideViews();
        $('adminApp').classList.remove('hidden');
        history.replaceState({}, '', location.protocol === 'file:' ? '#admin' : '/admin');
        renderRows();
        renderQueue();
        startStaffQueueRefresh();
      }
    } catch (loadError) {
      await db.auth.signOut();
      state.user = null;
      state.profile = null;
      throw loadError;
    }
  }

  function filePath(file, kind) {
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100) || 'document';
    return `${state.user.id}/${kind}/${crypto.randomUUID()}-${safeName}`;
  }

  async function persistApplication(formData, documentPaths) {
    const { data, error } = await requireClient()
      .from('applications')
      .upsert({
        user_id: state.user.id,
        form_data: formData,
        document_paths: documentPaths,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' })
      .select('user_id, form_data, document_paths, application_number, updated_at')
      .single();
    if (error) {
      throw error;
    }
    state.application = data;
    return data;
  }

  async function uploadFile(kind, file) {
    const db = requireClient();
    const oldPath = state.application.document_paths[kind];
    const path = filePath(file, kind);
    const { error: uploadError } = await db.storage.from(STORAGE_BUCKET).upload(path, file, {
      contentType: file.type || 'application/octet-stream',
      upsert: false
    });
    if (uploadError) {
      throw uploadError;
    }
    const documentPaths = Object.assign({}, state.application.document_paths, { [kind]: path });
    try {
      await persistApplication(state.application.form_data, documentPaths);
    } catch (error) {
      const { error: cleanupError } = await db.storage.from(STORAGE_BUCKET).remove([path]);
      if (cleanupError) {
        console.error('Failed to remove an unreferenced upload', cleanupError);
      }
      throw error;
    }
    if (oldPath) {
      const { error: removeError } = await db.storage.from(STORAGE_BUCKET).remove([oldPath]);
      if (removeError) {
        reportError('บันทึกไฟล์ใหม่แล้ว แต่ลบไฟล์เดิมไม่สำเร็จ', removeError);
      }
    }
  }

  async function loadAdminData() {
    const db = requireClient();
    const { data: profiles, error: profileError } = await db
      .from('profiles')
      .select('user_id, student_id, full_name, class_room, seat_number')
      .eq('role', 'student')
      .order('student_id');
    if (profileError) {
      throw profileError;
    }
    const ids = profiles.map((profile) => profile.user_id);
    let applications = [];
    let reviews = [];
    if (ids.length) {
      const [{ data: appData, error: appError }, { data: reviewData, error: reviewError }] = await Promise.all([
        db.from('applications').select('user_id, form_data, document_paths, application_number, updated_at').in('user_id', ids),
        db.from('application_reviews').select('user_id, status, reason, submitted_at').in('user_id', ids)
      ]);
      if (appError) {
        throw appError;
      }
      if (reviewError) {
        throw reviewError;
      }
      applications = appData;
      reviews = reviewData;
    }
    const appByUser = new Map(applications.map((application) => [application.user_id, application]));
    const reviewByUser = new Map(reviews.map((review) => [review.user_id, review]));
    state.queue = profiles.map((profile) => {
      const application = appByUser.get(profile.user_id);
      const review = reviewByUser.get(profile.user_id);
      const formData = application && application.form_data || {};
      return {
        id: profile.student_id,
        user_id: profile.user_id,
        name: formData.applicant_name
          ? `${formData.prefix || ''} ${formData.applicant_name}`.trim()
          : profile.full_name,
        room: `ม.3/${formData.class_room || profile.class_room || '—'}`,
        choices: Array.isArray(formData.choices) ? formData.choices : [],
        status: displayStatus(review && review.status),
        review_status: review && review.status,
        reason: review && review.reason,
        submitted_at: review && review.submitted_at,
        application,
        document_paths: application && application.document_paths || {}
      };
    });
    students.splice(0, students.length, ...state.queue);
    const submitted = state.queue.filter((student) => student.review_status && student.review_status !== 'draft').length;
    const metrics = document.querySelectorAll('#allStudents .metric b');
    metrics[0].textContent = String(profiles.length);
    metrics[1].textContent = String(submitted);
    metrics[2].textContent = String(state.queue.filter((student) => student.review_status === 'submitted').length);
    metrics[3].textContent = String(state.queue.filter((student) => student.review_status === 'approved').length);
    preloadPdfViewer().catch((error) => console.error('Failed to preload PDF viewer', error));
  }

  function startStaffQueueRefresh() {
    if (staffQueueRefreshTimer) {
      window.clearInterval(staffQueueRefreshTimer);
    }
    staffQueueRefreshTimer = window.setInterval(async () => {
      if (!isStaff() || document.hidden || staffQueueRefreshPending) return;
      staffQueueRefreshPending = true;
      const selectedUserId = reviewPreviewStudent?.user_id
        || activeReviewQueue[reviewQueueIndex]?.user_id;
      const viewerOpen = !$('pdfViewer')?.classList.contains('hidden');
      try {
        await loadAdminData();
        renderRows();
        window.renderQueue();
        if (selectedUserId) {
          const selectedIndex = activeReviewQueue.findIndex((student) => student.user_id === selectedUserId);
          if (selectedIndex >= 0) {
            reviewQueueIndex = selectedIndex;
            if (viewerOpen) {
              window.showReviewStudent(activeReviewQueue[selectedIndex], currentReviewDocument);
            } else {
              window.renderQueue();
            }
          }
        }
      } catch (error) {
        console.error('ไม่สามารถรีเฟรชคิวตรวจเอกสารได้', error);
      } finally {
        staffQueueRefreshPending = false;
      }
    }, 5000);
    backfillSubmittedApplicationPdfs();
  }

  async function backfillSubmittedApplicationPdfs() {
    const missing = state.queue.filter((student) =>
      student.review_status === 'submitted' && !student.document_paths.application_pdf
    );
    for (let index = 0; index < missing.length; index += 2) {
      await Promise.allSettled(missing.slice(index, index + 2).map((student) => ensureSubmittedApplicationPdf(student)));
    }
    renderRows();
    window.renderQueue();
  }

  function pendingReviewStudents() {
    return students.filter((student) => student.status === 'รอตรวจ' || student.status === 'ส่งแล้ว');
  }

  function getReviewTabIndex(student, index) {
    const plan = Array.isArray(student.choices) ? student.choices[0] : null;
    if (reviewDistribution === 'by_plan' && Number.isInteger(plan)) {
      return plan % reviewTabCount;
    }
    const studentId = String(student.id || '');
    return /^\d+$/.test(studentId) ? Number(studentId) % reviewTabCount : index % reviewTabCount;
  }

  function renderReviewTabsNav(queue = pendingReviewStudents()) {
    const container = $('reviewTabsNav');
    if (!container) {
      throw new Error('Review tab navigation container is missing');
    }
    const counts = Array.from({ length: reviewTabCount }, () => 0);
    queue.forEach((student, index) => {
      counts[getReviewTabIndex(student, index)] += 1;
    });
    const reviewPaneActive = $('documentReview').classList.contains('active');
    container.replaceChildren();
    for (let index = 0; index < reviewTabCount; index += 1) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `navitem${reviewPaneActive && index === currentReviewTab ? ' active' : ''}`;
      button.dataset.admin = 'documentReview';
      button.dataset.reviewTab = String(index);
      button.textContent = `ตรวจเอกสาร ${index + 1} (${counts[index]})`;
      button.addEventListener('click', () => {
        currentReviewTab = index;
        reviewQueueIndex = 0;
        window.adminTab(button);
        window.renderQueue();
      });
      container.append(button);
    }
  }

  function loadReviewSettings() {
    try {
      const raw = window.localStorage.getItem(reviewSettingsKey);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved.tabCount !== undefined) {
          if (!Number.isInteger(saved.tabCount) || saved.tabCount < 1 || saved.tabCount > 10) {
            throw new Error('Saved document-review tab count must be between 1 and 10.');
          }
          reviewTabCount = saved.tabCount;
        }
        if (saved.distribution !== undefined) {
          if (!['balanced', 'by_plan'].includes(saved.distribution)) {
            throw new Error('Saved document-review distribution is invalid.');
          }
          reviewDistribution = saved.distribution;
        }
      }
    } catch (error) {
      reportError('อ่านการตั้งค่าแท็บตรวจเอกสารไม่สำเร็จ', error);
    }
    $('reviewTabCount').value = String(reviewTabCount);
    $('reviewDistribution').value = reviewDistribution;
  }

  window.saveReviewSettings = function () {
    const tabCount = Number($('reviewTabCount').value);
    if (!Number.isInteger(tabCount) || tabCount < 1 || tabCount > 10) {
      toast('จำนวนแท็บตรวจเอกสารต้องอยู่ระหว่าง 1 ถึง 10');
      return;
    }
    const distribution = $('reviewDistribution').value;
    if (!['balanced', 'by_plan'].includes(distribution)) {
      toast('เลือกรูปแบบการกระจายนักเรียนให้ถูกต้อง');
      return;
    }
    try {
      window.localStorage.setItem(reviewSettingsKey, JSON.stringify({ tabCount, distribution }));
    } catch (error) {
      reportError('บันทึกการตั้งค่าแท็บตรวจเอกสารไม่สำเร็จ', error);
      return;
    }
    reviewTabCount = tabCount;
    reviewDistribution = distribution;
    currentReviewTab = Math.min(currentReviewTab, reviewTabCount - 1);
    reviewQueueIndex = 0;
    renderReviewTabsNav();
    window.renderQueue();
    toast('บันทึกการตั้งค่าแท็บตรวจเอกสารแล้ว');
  };

  async function uploadApplicationPdf(student, pdfBlob) {
    const path = `${student.user_id}/application/${crypto.randomUUID()}-application.pdf`;
    const { error } = await requireClient().storage.from(STORAGE_BUCKET).upload(path, pdfBlob, {
      contentType: 'application/pdf',
      upsert: false
    });
    if (error) {
      throw error;
    }
    return path;
  }

  async function removeApplicationPdf(path, failureMessage) {
    if (!path) {
      return null;
    }
    const { error } = await requireClient().storage.from(STORAGE_BUCKET).remove([path]);
    if (error) {
      console.error(failureMessage, error);
    }
    return error || null;
  }

  async function createApplicationPdfForStudent(student, photoUrl) {
    let signedPhotoUrl = photoUrl || '';
    const photoPath = student.document_paths && student.document_paths.photo;
    if (!signedPhotoUrl && photoPath) {
      const { data, error } = await requireClient().storage.from(STORAGE_BUCKET).createSignedUrl(photoPath, 300);
      if (error) {
        throw error;
      }
      signedPhotoUrl = data.signedUrl;
    }
    const photoDataUrl = signedPhotoUrl ? await fetchImageDataUrl(signedPhotoUrl) : '';
    return generateApplicationPdf(student, photoDataUrl);
  }

  async function approveApplicationWithPdf(student, pdfBlob, existingPath = '') {
    const db = requireClient();
    const path = existingPath || await uploadApplicationPdf(student, pdfBlob);
    let oldPath;
    try {
      const { data, error } = await db.rpc('approve_application_with_pdf', {
        p_target_user_id: student.user_id,
        p_pdf_path: path
      });
      if (error) {
        throw error;
      }
      oldPath = data;
    } catch (error) {
      if (!existingPath) {
        const cleanupError = await removeApplicationPdf(path, 'อนุมัติไม่สำเร็จ และลบ PDF ชั่วคราวไม่สำเร็จ');
        if (cleanupError) {
          reportError('อนุมัติไม่สำเร็จ และลบ PDF ชั่วคราวไม่สำเร็จ', cleanupError);
        }
      }
      throw error;
    }
    if (oldPath && oldPath !== path) {
      return removeApplicationPdf(oldPath, 'อนุมัติแล้ว แต่ลบใบสมัคร PDF ฉบับเก่าไม่สำเร็จ');
    }
    return null;
  }

  async function rejectApplication(student, reason) {
    const { data: oldPath, error } = await requireClient().rpc('reject_application', {
      p_target_user_id: student.user_id,
      p_reason: reason
    });
    if (error) {
      throw error;
    }
    return removeApplicationPdf(oldPath, 'บันทึกผลไม่ผ่านแล้ว แต่ลบใบสมัคร PDF ไม่สำเร็จ');
  }

  async function submitApplicationWithPdf(student, pdfBlob) {
    const db = requireClient();
    const path = await uploadApplicationPdf(student, pdfBlob);
    try {
      const { error } = await db.rpc('submit_application', { p_pdf_path: path });
      if (error) throw error;
      return path;
    } catch (error) {
      const cleanupError = await removeApplicationPdf(path, 'ส่งใบสมัครไม่สำเร็จ และลบ PDF ชั่วคราวไม่สำเร็จ');
      if (cleanupError) {
        reportError('ส่งใบสมัครไม่สำเร็จ และลบ PDF ชั่วคราวไม่สำเร็จ', cleanupError);
      }
      throw error;
    }
  }

  async function storeSubmittedApplicationPdf(student) {
    const pdfBlob = await createApplicationPdfForStudent(student, '');
    const path = await uploadApplicationPdf(student, pdfBlob);
    try {
      const { data: savedPath, error } = await requireClient().rpc('store_submitted_application_pdf', {
        p_target_user_id: student.user_id,
        p_pdf_path: path
      });
      if (error) throw error;
      if (savedPath !== path) {
        const cleanupError = await removeApplicationPdf(path, 'ผูกใบสมัคร PDF แล้ว แต่ลบไฟล์ซ้ำไม่สำเร็จ');
        if (cleanupError) reportError('ผูกใบสมัคร PDF แล้ว แต่ลบไฟล์ซ้ำไม่สำเร็จ', cleanupError);
      }
      return savedPath;
    } catch (error) {
      const cleanupError = await removeApplicationPdf(path, 'บันทึก PDF รอตรวจไม่สำเร็จ และลบไฟล์ชั่วคราวไม่สำเร็จ');
      if (cleanupError) reportError('บันทึก PDF รอตรวจไม่สำเร็จ และลบไฟล์ชั่วคราวไม่สำเร็จ', cleanupError);
      throw error;
    }
  }

  function ensureSubmittedApplicationPdf(student) {
    if (!student || student.review_status !== 'submitted' || student.document_paths.application_pdf) return Promise.resolve(null);
    if (submittedPdfJobs.has(student.user_id)) return submittedPdfJobs.get(student.user_id);
    if ((submittedPdfRetryAfter.get(student.user_id) || 0) > Date.now()) return Promise.resolve(null);
    const job = storeSubmittedApplicationPdf(student);
    submittedPdfJobs.set(student.user_id, job);
    job.then((path) => {
      submittedPdfRetryAfter.delete(student.user_id);
      const current = state.queue.find((item) => item.user_id === student.user_id);
      if (current && path) {
        current.document_paths.application_pdf = path;
        if (current.application) {
          current.application.document_paths = Object.assign({}, current.application.document_paths, { application_pdf: path });
        }
      }
      if (reviewPreviewStudent?.user_id === student.user_id && path) {
        reviewPreviewStudent.document_paths.application_pdf = path;
        if (reviewPreviewStudent.application) {
          reviewPreviewStudent.application.document_paths = Object.assign({}, reviewPreviewStudent.application.document_paths, { application_pdf: path });
        }
        renderRows();
        renderReviewDocument();
      }
    }).catch((error) => {
      submittedPdfRetryAfter.set(student.user_id, Date.now() + 60_000);
      if (reviewPreviewStudent?.user_id === student.user_id && currentReviewDocument === 'application') {
        showPdfViewerMessage('สร้างและบันทึกใบสมัคร PDF ไม่สำเร็จ');
      }
      reportError('สร้างและบันทึกใบสมัคร PDF ไม่สำเร็จ', error);
    }).finally(() => submittedPdfJobs.delete(student.user_id));
    return job;
  }

  async function storePdfForApprovedApplication(student) {
    const pdfBlob = await createApplicationPdfForStudent(student, '');
    const path = await uploadApplicationPdf(student, pdfBlob);
    try {
      const { data: savedPath, error } = await requireClient().rpc('store_approved_application_pdf', {
        p_target_user_id: student.user_id,
        p_pdf_path: path
      });
      if (error) {
        throw error;
      }
      if (savedPath !== path) {
        const cleanupError = await removeApplicationPdf(path, 'สร้าง PDF แล้ว แต่ลบไฟล์ซ้ำไม่สำเร็จ');
        if (cleanupError) {
          reportError('สร้าง PDF แล้ว แต่ลบไฟล์ซ้ำไม่สำเร็จ', cleanupError);
        }
      }
      return savedPath;
    } catch (error) {
      const cleanupError = await removeApplicationPdf(path, 'สร้าง PDF ไม่สำเร็จ และลบไฟล์ชั่วคราวไม่สำเร็จ');
      if (cleanupError) {
        reportError('สร้าง PDF ไม่สำเร็จ และลบไฟล์ชั่วคราวไม่สำเร็จ', cleanupError);
      }
      throw error;
    }
  }

  window.studentLogin = async function () {
    const studentId = $('loginId').value.trim();
    const dateOfBirth = $('loginDob').value.trim();
    if (!/^\d{5}$/.test(studentId) || !/^\d{2}\/\d{2}\/\d{4}$/.test(dateOfBirth)) {
      toast('กรุณากรอกเลขประจำตัว 5 หลักและวันเกิดรูปแบบ วว/ดด/ปปปป');
      return;
    }
    try {
      const authEmail = `student-${studentId}@login.schoolquota.invalid`;
      await signIn(authEmail, dateOfBirth, 'student');
    } catch (error) {
      reportError(error.message === 'Invalid login credentials' ? 'เลขประจำตัวหรือวันเกิดไม่ถูกต้อง' : 'เข้าสู่ระบบนักเรียนไม่สำเร็จ', error);
    }
  };

  window.adminLogin = async function () {
    const email = $('adminEmail').value.trim();
    const password = $('adminPassword').value;
    if (!email || !password) {
      toast('กรุณากรอกอีเมลและรหัสผ่าน');
      return;
    }
    try {
      await signIn(email, password, 'staff');
    } catch (error) {
      reportError(error.message === 'Invalid login credentials' ? 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' : 'เข้าสู่ระบบผู้ดูแลไม่สำเร็จ', error);
    }
  };

  window.logout = async function () {
    try {
      if (staffQueueRefreshTimer) {
        window.clearInterval(staffQueueRefreshTimer);
        staffQueueRefreshTimer = null;
      }
      const { error } = await requireClient().auth.signOut();
      if (error) {
        throw error;
      }
      state.user = null;
      state.profile = null;
      state.application = null;
      state.review = null;
      studentLoggedIn = false;
      showLanding();
    } catch (error) {
      reportError('ออกจากระบบไม่สำเร็จ', error);
    }
  };

  window.previewPhoto = function (input) {
    const file = input.files && input.files[0];
    if (!file) {
      return;
    }
    if (!file.type.startsWith('image/')) {
      toast('รูปถ่ายต้องเป็นไฟล์รูปภาพ');
      input.value = '';
      return;
    }
    if (photoUrl.startsWith('blob:')) {
      URL.revokeObjectURL(photoUrl);
    }
    photoUrl = URL.createObjectURL(file);
    $('photoPreview').querySelector('img')?.remove();
    const image = document.createElement('img');
    image.src = photoUrl;
    image.alt = 'รูปผู้สมัคร';
    $('photoPreview').prepend(image);
    refreshReview();
  };

  window.savePersonal = async function () {
    if (!state.user || !state.application) {
      toast('กรุณาเข้าสู่ระบบก่อนบันทึกข้อมูล');
      return;
    }
    try {
      const formData = currentFormData();
      const photoFile = $('photoFile').files && $('photoFile').files[0];
      await persistApplication(formData, state.application.document_paths);
      if (photoFile) {
        await uploadFile('photo', photoFile);
      }
      toast('บันทึกข้อมูลส่วนตัวแล้ว');
      refreshReview();
      refreshSubmitApplicationButton();
    } catch (error) {
      reportError('บันทึกข้อมูลส่วนตัวไม่สำเร็จ', error);
    }
  };

  window.saveDoc = async function (kind) {
    const file = files[kind];
    if (!file) {
      toast('กรุณาเลือกไฟล์ก่อนบันทึก');
      return;
    }
    if (!['transcript', 'conduct'].includes(kind)) {
      toast('ไม่รู้จักประเภทเอกสารนี้');
      return;
    }
    try {
      await uploadFile(kind, file);
      saved[kind] = true;
      toast('บันทึกเอกสารแล้ว');
      refreshReview();
      refreshSubmitApplicationButton();
    } catch (error) {
      reportError('บันทึกเอกสารไม่สำเร็จ', error);
    }
  };

  window.viewStudentFile = async function (kind, studentOverride) {
    const application = studentOverride ? studentOverride.application : state.application;
    const path = application && application.document_paths[kind];
    if (!path) {
      toast('ยังไม่มีเอกสารที่บันทึก');
      return;
    }
    try {
      const { data, error } = await requireClient().storage.from(STORAGE_BUCKET).createSignedUrl(path, 300);
      if (error) {
        throw error;
      }
      window.closePdfViewer();
      ensurePdfModalControls();
      $('reviewPdfControls').classList.add('hidden');
      $('pdfViewer').classList.remove('review-mode');
      $('pdfViewer').classList.add('reader-mode');
      $('pdfViewerTitle').textContent = documentLabels[kind] || 'เอกสาร';
      $('pdfViewerMeta').textContent = studentOverride
        ? `เลขประจำตัว ${studentOverride.id} · ${studentOverride.room}`
        : '';
      pdfViewerZoom = 100;
      $('pdfZoomLabel').textContent = '100%';
      setPdfViewerSource(data.signedUrl, /\.pdf$/i.test(path));
      $('pdfViewer').classList.remove('hidden');
      lockPdfViewerBackground();
    } catch (error) {
      reportError('เปิดเอกสารไม่สำเร็จ', error);
    }
  };

  window.submitApplication = function () {
    if (!$('confirmAccuracy').checked) {
      toast('กรุณายืนยันความถูกต้องของข้อมูล');
      return;
    }
    const missing = getSubmissionMissingItems();
    if (missing.length) {
      toast(`กรุณากรอกให้ครบ: ${missing.join(' · ')}`);
      refreshSubmitApplicationButton();
      return;
    }
    const paths = state.application.document_paths;
    modal('ยืนยันการส่งใบสมัคร', 'เมื่อส่งแล้ว ใบสมัครจะเข้าสู่คิวตรวจเอกสาร', false, async () => {
      const confirmButton = $('modalConfirm');
      confirmButton.disabled = true;
      confirmButton.textContent = 'กำลังสร้าง PDF…';
      try {
        const formData = currentFormData();
        await persistApplication(formData, paths);
        const applicant = {
          id: state.profile.student_id,
          user_id: state.user.id,
          name: `${formData.prefix || ''} ${formData.applicant_name}`.trim(),
          application: state.application,
          document_paths: paths
        };
        const pdfBlob = await createApplicationPdfForStudent(applicant, '');
        const pdfPath = await submitApplicationWithPdf(applicant, pdfBlob);
        state.application.document_paths = Object.assign({}, state.application.document_paths, { application_pdf: pdfPath });
        state.review = { status: 'submitted', reason: null };
        $('studentStatus').textContent = displayStatus('submitted');
        updateTracking();
        toast('ส่งใบสมัครเรียบร้อย');
        closeModal();
        studentTab(document.querySelector('[data-pane="track"]'));
      } catch (error) {
        confirmButton.disabled = false;
        confirmButton.textContent = 'ยืนยัน';
        reportError('ส่งใบสมัครไม่สำเร็จ', error);
      }
    });
  };

  window.printApplication = async function () {
    if (!state.review || state.review.status !== 'approved') {
      toast('ปุ่มพิมพ์จะแสดงหลังครูตรวจผ่าน');
      return;
    }
    try {
      const student = {
        id: state.profile.student_id,
        user_id: state.user.id,
        application: state.application,
        document_paths: state.application.document_paths
      };
      let path = state.application.document_paths.application_pdf;
      if (!path) {
        toast('กำลังจัดเก็บใบสมัคร PDF…');
        path = await storePdfForApprovedApplication(student);
        state.application.document_paths.application_pdf = path;
      }
      const { data, error } = await requireClient().storage.from(STORAGE_BUCKET)
        .createSignedUrl(path, 300, { download: `ใบสมัครโควตา_${student.id}.pdf` });
      if (error) throw error;
      const link = document.createElement('a');
      link.href = data.signedUrl;
      link.download = `ใบสมัครโควตา_${student.id}.pdf`;
      link.rel = 'noopener';
      document.body.append(link);
      link.click();
      link.remove();
    } catch (error) {
      reportError('ดาวน์โหลดใบสมัคร PDF ไม่สำเร็จ', error);
    }
  };

  window.renderRows = function () {
    const query = ($('searchStudents')?.value || '').toLowerCase();
    const room = $('roomFilter')?.value || '';
    const status = $('statusFilter')?.value || '';
    const rows = students.filter((student) =>
      (student.name.toLowerCase().includes(query) || String(student.id).includes(query))
      && (!room || student.choices.includes(Number(room)))
      && (!status || student.status === status)
    );
    const body = $('studentRows');
    body.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 6;
      cell.textContent = 'ไม่พบข้อมูล';
      empty.append(cell);
      body.append(empty);
      return;
    }
    rows.forEach((student) => {
      const row = document.createElement('tr');
      const values = [
        String(student.id),
        student.name,
        student.room,
        student.choices.map((choice, index) => `${index + 1}. ${(plans[choice] || {}).name || ''}`).join('\n')
      ];
      values.forEach((value, index) => {
        const cell = document.createElement('td');
        if (index === 1) {
          const name = document.createElement('b');
          name.textContent = value;
          cell.append(name);
        } else {
          cell.textContent = value;
        }
        row.append(cell);
      });
      const statusCell = document.createElement('td');
      statusCell.innerHTML = statusBadge(student.status);
      row.append(statusCell);
      const actionCell = document.createElement('td');
      const button = document.createElement('button');
      button.className = 'linkbtn';
      const hasApplicationPdf = Boolean(student.document_paths.application_pdf);
      button.textContent = hasApplicationPdf
        ? 'ดูใบสมัคร PDF'
        : student.review_status === 'approved' ? 'สร้างใบสมัคร PDF' : 'ยังไม่มีใบสมัคร PDF';
      button.disabled = !hasApplicationPdf && !['approved', 'submitted'].includes(student.review_status);
      button.addEventListener('click', () => window.openStudentApplicationPdf(student.id));
      actionCell.append(button);
      row.append(actionCell);
      body.append(row);
    });
  };

  window.renderQueue = function () {
    const queue = pendingReviewStudents();
    renderReviewTabsNav(queue);
    activeReviewQueue = queue.filter((student, index) => getReviewTabIndex(student, index) === currentReviewTab);
    const container = $('reviewQueue');
    container.replaceChildren();
    container.classList.add('review-cards');
    if (!activeReviewQueue.length) {
      const empty = document.createElement('p');
      empty.className = 'smallnote';
      empty.textContent = queue.length ? 'แท็บนี้ไม่มีเอกสารรอตรวจ' : 'ไม่มีเอกสารรอตรวจ';
      container.append(empty);
      reviewQueueIndex = 0;
      return;
    }
    reviewQueueIndex = Math.min(reviewQueueIndex, activeReviewQueue.length - 1);
    activeReviewQueue.forEach((student, index) => {
      const item = document.createElement('article');
      item.className = `queue-card ${index === reviewQueueIndex ? 'active' : ''}`;
      const name = document.createElement('b');
      name.textContent = student.name;
      const details = document.createElement('small');
      details.textContent = `${student.id} · ${student.room} · ${student.choices.map((choice) => (plans[choice] || {}).name || '').join(', ')}`;
      const heading = document.createElement('button');
      heading.type = 'button';
      heading.className = 'queue-card-heading';
      heading.append(name, details);
      heading.addEventListener('click', () => {
        reviewQueueIndex = index;
        window.openReviewDocument(student.id, 'application');
      });
      const actions = document.createElement('div');
      actions.className = 'queue-card-actions';
      [
        ['application', 'ใบสมัคร'],
        ['photo', 'รูปถ่าย'],
        ['transcript', 'ปพ.1'],
        ['conduct', 'ใบรับรอง']
      ].forEach(([kind, label]) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn ghost';
        button.textContent = label;
        button.addEventListener('click', () => {
          reviewQueueIndex = index;
          window.openReviewDocument(student.id, kind);
        });
        actions.append(button);
      });
      item.append(heading, actions);
      container.append(item);
    });
  };

  window.currentStudent = function () {
    return activeReviewQueue[reviewQueueIndex] || null;
  };

  window.nextReview = function (step) {
    if (!activeReviewQueue.length) {
      return;
    }
    reviewQueueIndex = (reviewQueueIndex + step + activeReviewQueue.length) % activeReviewQueue.length;
    window.renderQueue();
    window.showReviewStudent(activeReviewQueue[reviewQueueIndex], currentReviewDocument);
  };

  window.selectStudent = function (studentId) {
    const queue = pendingReviewStudents();
    const studentIndex = queue.findIndex((student) => String(student.id) === String(studentId));
    if (studentIndex < 0) {
      toast('นักเรียนรายการนี้ไม่มีเอกสารรอตรวจ');
      return;
    }
    const student = queue[studentIndex];
    currentReviewTab = getReviewTabIndex(student, studentIndex);
    renderReviewTabsNav(queue);
    const tabButton = $(`reviewTabsNav`).querySelector(`[data-review-tab="${currentReviewTab}"]`);
    window.adminTab(tabButton);
    activeReviewQueue = queue.filter((item, index) => getReviewTabIndex(item, index) === currentReviewTab);
    reviewQueueIndex = activeReviewQueue.findIndex((item) => String(item.id) === String(studentId));
    window.renderQueue();
    window.showReviewStudent(activeReviewQueue[reviewQueueIndex], 'application');
  };

  async function fetchImageDataUrl(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`รูปภาพตอบกลับด้วย HTTP ${response.status}`);
    }
    const blob = await response.blob();
    if (!blob.type.startsWith('image/')) {
      throw new Error('ไฟล์รูปถ่ายที่บันทึกไว้ไม่ใช่รูปภาพ');
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => resolve(reader.result), { once: true });
      reader.addEventListener('error', () => reject(reader.error || new Error('อ่านรูปถ่ายไม่สำเร็จ')), { once: true });
      reader.readAsDataURL(blob);
    });
  }

  function loadReviewDocumentUrl(kind) {
    const student = reviewPreviewStudent;
    const path = student && student.document_paths && student.document_paths[kind];
    if (!student || !path || reviewDocumentUrls[kind] || reviewDocumentErrors[kind] || reviewDocumentLoads[kind]) {
      return;
    }
    const requestId = reviewPreviewRequest;
    const load = Promise.resolve()
      .then(() => requireClient().storage.from(STORAGE_BUCKET).createSignedUrl(path, 300))
      .then(({ data, error }) => {
        if (error) {
          throw error;
        }
        if (requestId === reviewPreviewRequest && reviewPreviewStudent?.user_id === student.user_id) {
          reviewDocumentUrls[kind] = data.signedUrl;
        }
      })
      .catch((error) => {
        if (requestId === reviewPreviewRequest && reviewPreviewStudent?.user_id === student.user_id) {
          reviewDocumentErrors[kind] = error;
          reportError(`เปิด${documentLabels[kind]}ไม่สำเร็จ`, error);
        }
      })
      .finally(() => {
        if (reviewDocumentLoads[kind] === load) {
          delete reviewDocumentLoads[kind];
        }
        const visibleKind = kind === 'application_pdf' ? 'application' : kind;
        if (requestId === reviewPreviewRequest && currentReviewDocument === visibleKind) {
          renderReviewDocument();
        }
      });
    reviewDocumentLoads[kind] = load;
  }

  async function generateApplicationPdf(student, photoDataUrl) {
    const formData = student.application && student.application.form_data || {};
    const address = formData.address || {};
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:210mm;height:297mm;border:0';
    const loaded = new Promise((resolve, reject) => {
      frame.addEventListener('load', resolve, { once: true });
      frame.addEventListener('error', () => reject(new Error('โหลดแบบฟอร์มใบสมัครไม่สำเร็จ')), { once: true });
    });
    frame.src = new URL('application-template.html', document.baseURI).href;
    document.body.append(frame);
    try {
      await loaded;
      const formWindow = frame.contentWindow;
      const formDocument = frame.contentDocument;
      const application = formDocument && formDocument.querySelector('#doc');
      if (!application) {
        throw new Error('ไม่พบแบบฟอร์มต้นฉบับสำหรับสร้าง PDF');
      }
      // Capture the template in its A4 screen layout. Its print stylesheet removes
      // the A4 page height and would make html2canvas shrink each page to its content.
      const fieldValues = {
        seq: student.application && student.application.application_number || formData.application_number || '',
        name: formData.applicant_name
          ? `${formData.prefix || ''} ${formData.applicant_name}`.trim()
          : student.name,
        room: formData.class_room || String(student.room || '').replace(/^ม\.3\//, ''),
        no: formData.seat_number ?? '',
        sid: student.id,
        gpa: formData.total_gpa ?? '',
        a_h: address.house ?? '',
        a_m: address.moo ?? '',
        a_r: address.road ?? '',
        a_t: address.subdistrict ?? '',
        a_a: address.district ?? '',
        a_p: address.province ?? '',
        a_tel: address.phone ?? ''
      };
      Object.entries(fieldValues).forEach(([id, value]) => {
        const field = formDocument.getElementById(id);
        if (!field) {
          throw new Error(`ไม่พบช่อง ${id} ในแบบฟอร์มต้นฉบับ`);
        }
        field.value = String(value ?? '');
      });
      const roomSelect = formDocument.getElementById('room');
      if (fieldValues.room && !Array.from(roomSelect.options).some((option) => option.value === fieldValues.room)) {
        roomSelect.add(new formWindow.Option(fieldValues.room, fieldValues.room));
      }
      roomSelect.value = fieldValues.room;
      if (typeof formWindow.doc !== 'function' || typeof formWindow.tog !== 'function'
          || typeof formWindow.html2canvas !== 'function' || typeof formWindow.jspdf?.jsPDF !== 'function') {
        throw new Error('โหลดแบบฟอร์มหรือตัวสร้าง PDF จากต้นฉบับไม่สำเร็จ');
      }
      formWindow.doc();
      const selectedChoices = Array.isArray(formData.choices)
        ? formData.choices.filter((choice) => Number.isInteger(choice) && plans[choice]).slice(0, 2)
        : [];
      selectedChoices.forEach((choice) => formWindow.tog(choice));
      const scoreValues = formData.scores || {};
      Array.from(formDocument.querySelectorAll('#scores input[data-k]')).forEach((input) => {
        const scoreKey = input.dataset.k;
        const termIndex = ['a', 'b', 'c', 'd', 'e'].indexOf(scoreKey.slice(-1));
        if (termIndex < 0) {
          throw new Error('พบช่องคะแนนที่ไม่ตรงกับแบบฟอร์มต้นฉบับ');
        }
        const subject = scoreKey.slice(0, -1);
        input.value = String(scoreValues[`${subject}-${termIndex}`] ?? '');
        input.dispatchEvent(new formWindow.Event('input', { bubbles: true }));
      });
      formWindow.doc();
      if (photoDataUrl) {
        const photoInput = formDocument.getElementById('photo');
        if (!photoInput || !formWindow.DataTransfer || !formWindow.File) {
          throw new Error('ไม่สามารถแนบรูปถ่ายลงในแบบฟอร์มต้นฉบับได้');
        }
        const photoBlob = await (await fetch(photoDataUrl)).blob();
        const transfer = new formWindow.DataTransfer();
        transfer.items.add(new formWindow.File([photoBlob], 'student-photo', { type: photoBlob.type }));
        const photoRendered = new Promise((resolve, reject) => {
          const observer = new formWindow.MutationObserver(() => {
            const photo = formDocument.querySelector('#doc .ph img');
            if (!photo) {
              return;
            }
            observer.disconnect();
            window.clearTimeout(timeout);
            photo.decode().then(resolve, reject);
          });
          observer.observe(application, { childList: true, subtree: true });
          const timeout = window.setTimeout(() => {
            observer.disconnect();
            reject(new Error('แสดงรูปถ่ายในแบบฟอร์มต้นฉบับไม่สำเร็จ'));
          }, 5000);
        });
        photoInput.files = transfer.files;
        photoInput.dispatchEvent(new formWindow.Event('change', { bubbles: true }));
        await photoRendered;
      }
      if (formDocument.fonts) {
        await Promise.race([
          formDocument.fonts.ready,
          new Promise((resolve) => window.setTimeout(resolve, 900))
        ]);
      }
      await Promise.all(Array.from(formDocument.images, (image) => image.decode()));
      const pages = Array.from(application.querySelectorAll('.pg'));
      if (!pages.length) {
        throw new Error('ไม่พบหน้ากระดาษในแบบฟอร์มต้นฉบับ');
      }
      const pdf = new formWindow.jspdf.jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
      for (let index = 0; index < pages.length; index += 1) {
        const canvas = await formWindow.html2canvas(pages[index], {
          scale: 2,
          backgroundColor: '#fff',
          windowWidth: pages[index].scrollWidth,
          windowHeight: pages[index].scrollHeight,
          scrollX: 0,
          scrollY: 0
        });
        let width = 210;
        let height = canvas.height * width / canvas.width;
        if (height > 297) {
          width *= 297 / height;
          height = 297;
        }
        if (index) pdf.addPage();
        pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, width, height);
      }
      const generatedBlob = pdf.output('blob');
      if (!generatedBlob || !generatedBlob.size || generatedBlob.type !== 'application/pdf') {
        throw new Error('สร้างไฟล์ PDF ไม่สำเร็จ');
      }
      const blob = new Blob([generatedBlob], { type: 'application/pdf' });
      return blob;
    } finally {
      frame.remove();
    }
  }

  function ensurePdfModalControls() {
    const toolbar = document.querySelector('#pdfViewer .pdf-toolbar');
    if ($('reviewPdfControls')) {
      return;
    }
    const modal = document.querySelector('#pdfViewer .pdf-modal');
    const frame = $('pdfFrame');
    modal.classList.add('review-shell');
    const layout = document.createElement('div');
    layout.className = 'review-layout';
    const sidebar = document.createElement('aside');
    sidebar.className = 'review-sidebar';
    sidebar.innerHTML = '<div class="review-sidebar-heading"><b>เอกสารผู้สมัคร</b><span id="reviewSeenCount">0/4 ดูแล้ว</span></div><nav id="reviewDocumentNav" aria-label="เอกสารสำหรับตรวจ"></nav><section class="review-facts"><b>ข้อมูลผู้สมัคร</b><dl id="reviewFacts"></dl></section>';
    const main = document.createElement('main');
    main.className = 'review-main';
    const stage = document.createElement('div');
    stage.className = 'review-stage';
    main.append(stage);
    layout.append(sidebar, main);
    const footer = document.createElement('footer');
    footer.className = 'review-footer';
    footer.innerHTML = '<span id="reviewSeenStatus">เปิดดูเอกสารแล้ว 0 จาก 4</span><div class="review-footer-actions" id="reviewFooterActions"></div>';
    modal.append(layout, footer);
    modal.insertBefore(toolbar, layout);
    stage.id = 'reviewStage';
    stage.append(frame);
    toolbar.classList.add('review-header');
    const closeButton = toolbar.querySelector('.btn');
    toolbar.replaceChildren();
    toolbar.innerHTML = '<button type="button" id="reviewBackButton" class="review-back" aria-label="กลับไปหน้ารายการ">← <span>คิวตรวจ</span></button><div class="review-heading"><div class="review-title-row"><b id="pdfViewerTitle">เอกสาร</b><span id="reviewResultBadge" class="review-result">รอตรวจ</span></div><small id="pdfViewerMeta" class="pdf-viewer-meta"></small><small id="reviewPosition" class="review-position"></small></div><div class="review-header-nav"><button type="button" id="reviewPreviousButton" class="review-icon-btn" aria-label="ผู้สมัครก่อนหน้า">←</button><button type="button" id="reviewNextButton" class="review-icon-btn" aria-label="ผู้สมัครถัดไป">→</button></div>';
    if (closeButton) { closeButton.textContent = 'ปิด'; closeButton.className = 'review-close'; toolbar.append(closeButton); }
    $('reviewBackButton').addEventListener('click', () => window.closePdfViewer());
    $('reviewPreviousButton').addEventListener('click', () => window.nextReview(-1));
    $('reviewNextButton').addEventListener('click', () => window.nextReview(1));
    const meta = document.createElement('small');
    meta.id = 'pdfViewerMeta';
    meta.className = 'pdf-viewer-meta';
    const zoomControls = document.createElement('div');
    zoomControls.className = 'pdf-zoom-controls';
    const zoomOut = document.createElement('button');
    zoomOut.type = 'button';
    zoomOut.className = 'btn ghost';
    zoomOut.textContent = '−';
    zoomOut.setAttribute('aria-label', 'ย่อเอกสาร');
    zoomOut.addEventListener('click', () => changePdfZoom(-10));
    const zoomLabel = document.createElement('span');
    zoomLabel.id = 'pdfZoomLabel';
    zoomLabel.textContent = '100%';
    const zoomIn = document.createElement('button');
    zoomIn.type = 'button';
    zoomIn.className = 'btn ghost';
    zoomIn.textContent = '+';
    zoomIn.setAttribute('aria-label', 'ขยายเอกสาร');
    zoomIn.addEventListener('click', () => changePdfZoom(10));
    zoomControls.append(zoomOut, zoomLabel, zoomIn);

    const reviewControls = $('reviewDocumentNav');
    reviewControls.id = 'reviewPdfControls';
    reviewControls.className = 'review-pdf-controls';
    const documentButtons = reviewControls;
    [
      ['application', 'ใบสมัคร'],
      ['photo', 'รูปถ่าย'],
      ['transcript', 'ปพ.1'],
      ['conduct', 'ใบรับรอง']
    ].forEach(([kind, label]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn ghost';
      button.dataset.reviewDocument = kind;
      button.textContent = label;
      button.addEventListener('click', () => window.viewDocument(kind));
      documentButtons.append(button);
    });
    const reviewActions = $('reviewFooterActions');
    [
      ['ไม่ผ่าน', () => window.rejectStudent(), 'btn ghost review-reject'],
      ['ผ่าน', () => window.approveStudent(), 'btn primary review-approve']
    ].forEach(([label, action, className]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = className;
      button.textContent = label;
      button.addEventListener('click', action);
      reviewActions.append(button);
    });
    const zoomWrap = document.createElement('div');
    zoomWrap.className = 'review-floating-tools';
    zoomWrap.append(zoomControls);
    $('reviewStage').prepend(zoomWrap);
  }

  function loadPdfJsLibrary() {
    if (window.pdfjsLib) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDF_JS_CDN_BASE}pdf.worker.min.js`;
      return Promise.resolve(window.pdfjsLib);
    }
    if (!pdfJsLibraryPromise) {
      pdfJsLibraryPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = `${PDF_JS_CDN_BASE}pdf.min.js`;
        script.onload = () => {
          if (!window.pdfjsLib) {
            reject(new Error('โหลดตัวแสดง PDF ไม่สำเร็จ'));
            return;
          }
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDF_JS_CDN_BASE}pdf.worker.min.js`;
          resolve(window.pdfjsLib);
        };
        script.onerror = () => {
          script.remove();
          reject(new Error('โหลดตัวแสดง PDF ไม่สำเร็จ'));
        };
        document.head.append(script);
      }).catch((error) => {
        pdfJsLibraryPromise = null;
        throw error;
      });
    }
    return pdfJsLibraryPromise;
  }

  function warmPdfJsWorker() {
    if (!pdfJsWorkerPromise) {
      pdfJsWorkerPromise = fetch(`${PDF_JS_CDN_BASE}pdf.worker.min.js`, { cache: 'force-cache' })
        .then((response) => {
          if (!response.ok) {
            throw new Error(`โหลด PDF worker ไม่สำเร็จ (HTTP ${response.status})`);
          }
          return response.arrayBuffer();
        })
        .then(() => undefined)
        .catch((error) => {
          pdfJsWorkerPromise = null;
          throw error;
        });
    }
    return pdfJsWorkerPromise;
  }

  function preloadPdfViewer() {
    return Promise.all([loadPdfJsLibrary(), warmPdfJsWorker()])
      .then(([library]) => library);
  }

  function ensureReviewPdfStage() {
    let stage = $('reviewPdfStage');
    if (!stage) {
      stage = document.createElement('div');
      stage.id = 'reviewPdfStage';
      stage.className = 'review-pdf-stage hidden';
      stage.setAttribute('role', 'region');
      stage.setAttribute('aria-label', 'ตัวอย่างเอกสาร PDF');
      $('pdfFrame').parentNode.insertBefore(stage, $('pdfFrame'));
    }
    return stage;
  }

  function cancelPdfJsRenderTasks() {
    if (pdfJsPageObserver) {
      pdfJsPageObserver.disconnect();
      pdfJsPageObserver = null;
    }
    pdfJsRenderTasks.forEach((task) => task.cancel());
    pdfJsRenderTasks = [];
  }

  function disposePdfJsDocument() {
    if (pdfJsLoadingTask) {
      const task = pdfJsLoadingTask;
      pdfJsLoadingTask = null;
      pdfJsLoadingPromise = null;
      pdfJsLoadingSource = '';
      void task.destroy().catch((error) => reportError('หยุดโหลด PDF ไม่สำเร็จ', error));
    }
    if (pdfJsDocument) {
      const pdf = pdfJsDocument;
      pdfJsDocument = null;
      pdfJsDocumentSource = '';
      void pdf.destroy().catch((error) => reportError('ปิดเอกสาร PDF ไม่สำเร็จ', error));
    }
  }

  function loadPdfJsDocument(url, library) {
    if (pdfJsDocument && pdfJsDocumentSource === url) {
      return Promise.resolve(pdfJsDocument);
    }
    if (pdfJsLoadingPromise && pdfJsLoadingSource === url) {
      return pdfJsLoadingPromise;
    }
    disposePdfJsDocument();
    const task = library.getDocument(url);
    const promise = task.promise
      .then((pdf) => {
        if (pdfJsLoadingTask !== task) {
          void pdf.destroy();
          return null;
        }
        pdfJsDocument = pdf;
        pdfJsDocumentSource = url;
        return pdf;
      })
      .finally(() => {
        if (pdfJsLoadingTask === task) {
          pdfJsLoadingTask = null;
          pdfJsLoadingPromise = null;
          pdfJsLoadingSource = '';
        }
      });
    pdfJsLoadingTask = task;
    pdfJsLoadingSource = url;
    pdfJsLoadingPromise = promise;
    return promise;
  }

  async function renderPdfDocument(url) {
    const requestId = ++pdfJsRenderRequest;
    cancelPdfJsRenderTasks();
    const frame = $('pdfFrame');
    const imageStage = $('reviewImageStage');
    if (imageStage) imageStage.classList.add('hidden');
    frame.removeAttribute('src');
    frame.removeAttribute('srcdoc');
    frame.classList.add('hidden');
    const stage = ensureReviewPdfStage();
    stage.classList.remove('hidden');
    stage.setAttribute('aria-busy', 'true');
    const status = document.createElement('div');
    status.className = 'pdf-render-status';
    status.textContent = 'กำลังเปิด PDF…';
    stage.replaceChildren(status);

    try {
      const library = await preloadPdfViewer();
      if (requestId !== pdfJsRenderRequest) return;
      const pdf = await loadPdfJsDocument(url, library);
      if (!pdf || requestId !== pdfJsRenderRequest) return;

      stage.replaceChildren();
      const outputScale = Math.min(Math.max(window.devicePixelRatio || 1, 1), 1.5);
      let firstPageRendered = false;
      const renderPage = async (pageContainer) => {
        if (requestId !== pdfJsRenderRequest || pageContainer.dataset.rendered === 'true' || pageContainer.dataset.rendering === 'true') return;
        pageContainer.dataset.rendering = 'true';
        const pageNumber = Number(pageContainer.dataset.pageNumber);
        try {
          const page = await pdf.getPage(pageNumber);
          if (requestId !== pdfJsRenderRequest) return;
          const baseViewport = page.getViewport({ scale: 1 });
          const availableWidth = Math.max(stage.clientWidth - 24, 1);
          const scale = (availableWidth / baseViewport.width) * (pdfViewerZoom / 100);
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.setAttribute('role', 'img');
          canvas.setAttribute('aria-label', `หน้า ${pageNumber} จาก ${pdf.numPages}`);
          canvas.width = Math.ceil(viewport.width * outputScale);
          canvas.height = Math.ceil(viewport.height * outputScale);
          canvas.style.width = `${viewport.width}px`;
          canvas.style.height = `${viewport.height}px`;
          pageContainer.style.width = `${viewport.width}px`;
          pageContainer.style.height = `${viewport.height}px`;
          pageContainer.replaceChildren(canvas);
          const renderTask = page.render({
            canvasContext: canvas.getContext('2d'),
            viewport,
            transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0]
          });
          pdfJsRenderTasks.push(renderTask);
          try {
            await renderTask.promise;
          } finally {
            pdfJsRenderTasks = pdfJsRenderTasks.filter((task) => task !== renderTask);
          }
          if (requestId === pdfJsRenderRequest) {
            pageContainer.dataset.rendered = 'true';
            pageContainer.dataset.rendering = 'false';
            if (!firstPageRendered) {
              firstPageRendered = true;
              stage.setAttribute('aria-busy', 'false');
            }
          }
        } catch (error) {
          pageContainer.dataset.rendering = 'false';
          if (error?.name !== 'RenderingCancelledException' && requestId === pdfJsRenderRequest) {
            pageContainer.textContent = `แสดงหน้า ${pageNumber} ไม่สำเร็จ`;
            reportError(`แสดงหน้า ${pageNumber} ของ PDF ไม่สำเร็จ`, error);
          }
        }
      };

      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const placeholder = document.createElement('div');
        placeholder.className = 'review-pdf-page review-pdf-page-placeholder';
        placeholder.dataset.pageNumber = String(pageNumber);
        placeholder.setAttribute('aria-label', `หน้า ${pageNumber} จาก ${pdf.numPages}`);
        placeholder.textContent = `หน้า ${pageNumber}`;
        stage.append(placeholder);
      }

      if ('IntersectionObserver' in window) {
        pdfJsPageObserver = new IntersectionObserver((entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            pdfJsPageObserver?.unobserve(entry.target);
            void renderPage(entry.target);
          });
        }, { root: stage, rootMargin: '900px 0px' });
        stage.querySelectorAll('.review-pdf-page').forEach((page) => pdfJsPageObserver.observe(page));
      } else {
        stage.querySelectorAll('.review-pdf-page').forEach((page) => { void renderPage(page); });
      }
    } catch (error) {
      if (requestId !== pdfJsRenderRequest) return;
      stage.replaceChildren();
      stage.setAttribute('aria-busy', 'false');
      const message = document.createElement('div');
      message.className = 'pdf-render-error';
      message.textContent = 'แสดง PDF ในป๊อปอัปไม่สำเร็จ';
      const fallbackLink = document.createElement('a');
      fallbackLink.href = url;
      fallbackLink.target = '_blank';
      fallbackLink.rel = 'noopener';
      fallbackLink.textContent = 'เปิด PDF ในแท็บใหม่';
      stage.append(message, fallbackLink);
      reportError('เปิด PDF ไม่สำเร็จ', error);
    }
  }

  function showPdfViewerMessage(message) {
    const frame = $('pdfFrame');
    const imageStage = $('reviewImageStage');
    const pdfStage = $('reviewPdfStage');
    pdfJsRenderRequest += 1;
    cancelPdfJsRenderTasks();
    if (imageStage) {
      imageStage.classList.add('hidden');
    }
    if (pdfStage) {
      pdfStage.classList.add('hidden');
    }
    frame.classList.remove('hidden');
    frame.removeAttribute('src');
    frame.srcdoc = `<!doctype html><html lang="th"><meta charset="utf-8"><style>body{font:16px Sarabun,Arial,sans-serif;color:#687487;display:grid;place-items:center;min-height:90vh;margin:0;text-align:center;padding:24px}</style><body>${String(message).replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character])}</body></html>`;
    pdfViewerSource = '';
    pdfViewerIsPdf = false;
  }

  function setPdfViewerSource(url, isPdf) {
    const frame = $('pdfFrame');
    const imageStage = $('reviewImageStage');
    if (imageStage) {
      imageStage.classList.add('hidden');
    }
    pdfViewerSource = url;
    pdfViewerIsPdf = isPdf;
    if (isPdf) {
      renderPdfDocument(url);
      return;
    }
    const pdfStage = $('reviewPdfStage');
    if (pdfStage) {
      pdfStage.classList.add('hidden');
    }
    frame.classList.remove('hidden');
    frame.removeAttribute('srcdoc');
    frame.src = url;
  }

  function showReviewImage(url, label) {
    const frame = $('pdfFrame');
    pdfJsRenderRequest += 1;
    cancelPdfJsRenderTasks();
    disposePdfJsDocument();
    frame.removeAttribute('src');
    frame.removeAttribute('srcdoc');
    frame.classList.add('hidden');
    const pdfStage = $('reviewPdfStage');
    if (pdfStage) {
      pdfStage.classList.add('hidden');
    }
    let stage = $('reviewImageStage');
    if (!stage) {
      stage = document.createElement('div');
      stage.id = 'reviewImageStage';
      stage.className = 'review-image-stage';
      $('reviewStage').append(stage);
    }
    const image = document.createElement('img');
    image.alt = label;
    image.src = url;
    image.style.transform = `scale(${pdfViewerZoom / 100})`;
    image.addEventListener('error', () => {
      reportError(`โหลด${label}ไม่สำเร็จ`, new Error('The review image could not be displayed.'));
      showPdfViewerMessage(`โหลด${label}ไม่สำเร็จ`);
    }, { once: true });
    stage.replaceChildren(image);
    stage.classList.remove('hidden');
    pdfViewerSource = url;
    pdfViewerIsPdf = false;
  }

  function changePdfZoom(step) {
    pdfViewerZoom = Math.max(50, Math.min(200, pdfViewerZoom + step));
    if ($('pdfZoomLabel')) {
      $('pdfZoomLabel').textContent = `${pdfViewerZoom}%`;
    }
    if (pdfViewerSource && pdfViewerIsPdf) {
      setPdfViewerSource(pdfViewerSource, true);
    } else if (pdfViewerSource && reviewModalMode === 'review') {
      const image = $('reviewImageStage')?.querySelector('img');
      if (image) {
        image.style.transform = `scale(${pdfViewerZoom / 100})`;
      }
    }
  }

  window.closePdfViewer = function () {
    reviewPreviewRequest += 1;
    pdfJsRenderRequest += 1;
    cancelPdfJsRenderTasks();
    disposePdfJsDocument();
    reviewPreviewStudent = null;
    reviewDocumentUrls = {};
    reviewDocumentErrors = {};
    reviewDocumentLoads = {};
    const controls = $('reviewPdfControls');
    if (controls) {
      controls.classList.add('hidden');
    }
    const imageStage = $('reviewImageStage');
    if (imageStage) {
      imageStage.remove();
    }
    const pdfStage = $('reviewPdfStage');
    if (pdfStage) {
      pdfStage.replaceChildren();
      pdfStage.classList.add('hidden');
    }
    $('pdfViewer').classList.remove('review-mode', 'reader-mode');
    reviewModalMode = 'review';
    pdfViewerSource = '';
    pdfViewerIsPdf = false;
    originalClosePdfViewer();
    unlockPdfViewerBackground();
  };

  function renderReviewDocument() {
    const student = reviewPreviewStudent;
    ensurePdfModalControls();
    document.querySelectorAll('[data-review-document]').forEach((button) => {
      button.classList.toggle('soft', button.dataset.reviewDocument === currentReviewDocument);
      button.classList.toggle('ghost', button.dataset.reviewDocument !== currentReviewDocument);
    });
    if (!student) {
      showPdfViewerMessage('เลือกนักเรียนจากรายการเพื่อตรวจเอกสาร');
      return;
    }

    if (currentReviewDocument === 'application') {
      if (student.document_paths.application_pdf) {
        if (reviewDocumentErrors.application_pdf) {
          showPdfViewerMessage('เปิดใบสมัคร PDF ไม่สำเร็จ');
          return;
        }
        const storedPdfUrl = reviewDocumentUrls.application_pdf;
        if (storedPdfUrl) {
          setPdfViewerSource(storedPdfUrl, true);
          return;
        }
        showPdfViewerMessage('กำลังโหลดใบสมัคร PDF…');
        loadReviewDocumentUrl('application_pdf');
        return;
      }
      if (student.review_status === 'submitted') {
        showPdfViewerMessage('กำลังสร้างและบันทึกใบสมัคร PDF…');
        ensureSubmittedApplicationPdf(student);
        return;
      }
      showPdfViewerMessage('ไม่พบไฟล์ใบสมัคร PDF ที่บันทึกไว้');
      return;
    }

    const path = student.document_paths && student.document_paths[currentReviewDocument];
    if (!path) {
      showPdfViewerMessage(`ยังไม่มี${documentLabels[currentReviewDocument] || 'เอกสาร'}ที่บันทึกไว้`);
      return;
    }
    if (reviewDocumentErrors[currentReviewDocument]) {
      showPdfViewerMessage(`เปิด${documentLabels[currentReviewDocument]}ไม่สำเร็จ`);
      return;
    }
    const url = reviewDocumentUrls[currentReviewDocument];
    if (!url) {
      showPdfViewerMessage(`กำลังโหลด${documentLabels[currentReviewDocument]}…`);
      loadReviewDocumentUrl(currentReviewDocument);
      return;
    }
    if (/\.(?:png|jpe?g|webp)$/i.test(path)) {
      showReviewImage(url, documentLabels[currentReviewDocument]);
      return;
    }
    if (/\.pdf$/i.test(path)) {
      setPdfViewerSource(url, true);
      return;
    }
    showPdfViewerMessage(`ไม่รองรับการแสดงตัวอย่าง${documentLabels[currentReviewDocument]}ในเว็บ`);
  }

  window.openReviewDocument = function (studentId, documentType) {
    const index = activeReviewQueue.findIndex((student) => String(student.id) === String(studentId));
    if (index < 0) {
      toast('นักเรียนรายการนี้ไม่มีเอกสารรอตรวจ');
      return;
    }
    reviewQueueIndex = index;
    window.renderQueue();
    window.showReviewStudent(activeReviewQueue[reviewQueueIndex], documentType);
  };

  window.viewDocument = function (documentType) {
    if (!['application', 'photo', 'transcript', 'conduct'].includes(documentType)) {
      throw new Error(`Unknown review document: ${documentType}`);
    }
    currentReviewDocument = documentType;
    const seen = reviewSeenDocuments.get(reviewPreviewStudent?.user_id) || new Set();
    seen.add(documentType);
    reviewSeenDocuments.set(reviewPreviewStudent?.user_id, seen);
    updateReviewSeenStatus(seen);
    renderReviewDocument();
  };

  function updateReviewSeenStatus(seen) {
    const count = seen?.size || 0;
    if ($('reviewSeenCount')) $('reviewSeenCount').textContent = `${count}/4 ดูแล้ว`;
    if ($('reviewSeenStatus')) $('reviewSeenStatus').textContent = `เปิดดูเอกสารแล้ว ${count} จาก 4`;
  }

  window.showReviewStudent = async function (student, documentType = 'application') {
    if (!student) {
      return;
    }
    reviewPreviewRequest += 1;
    reviewPreviewStudent = student;
    reviewDocumentUrls = {};
    reviewDocumentErrors = {};
    currentReviewDocument = documentType;
    const seen = reviewSeenDocuments.get(student.user_id) || new Set();
    seen.add(documentType);
    reviewSeenDocuments.set(student.user_id, seen);
    reviewModalMode = 'review';
    reviewDocumentLoads = {};
    ensurePdfModalControls();
    $('reviewPdfControls').classList.remove('hidden');
    lockPdfViewerBackground();
    $('pdfViewer').classList.add('review-mode');
    $('pdfViewer').classList.remove('hidden');
    $('pdfViewerTitle').textContent = student.name;
    $('pdfViewerMeta').textContent = `เลขประจำตัว ${student.id} · ${student.room} · ${student.choices.map((choice, index) => `${index + 1}. ${(plans[choice] || {}).name || ''}`).join(' | ')}`;
    const total = activeReviewQueue.length;
    $('reviewPosition').textContent = `คิวตรวจ ${reviewQueueIndex + 1} จาก ${total}`;
    $('reviewPreviousButton').disabled = reviewQueueIndex <= 0;
    $('reviewNextButton').disabled = reviewQueueIndex >= total - 1;
    $('reviewResultBadge').textContent = student.review_status === 'approved' ? 'ผ่าน' : student.review_status === 'rejected' ? 'ไม่ผ่าน' : 'รอตรวจ';
    const form = student.application?.form_data || student.form_data || {};
    const facts = [['GPA', form.total_gpa || form.gpa || '—'], ['โทรศัพท์', form.phone || form.address?.phone || '—'], ['แผนที่เลือก', student.choices.map((choice, index) => `${index + 1}. ${(plans[choice] || {}).name || '—'}`).join(' / ') || '—']];
    $('reviewFacts').replaceChildren(...facts.map(([label, value]) => {
      const row = document.createElement('div');
      const term = document.createElement('dt'); term.textContent = label;
      const detail = document.createElement('dd'); detail.textContent = String(value);
      row.append(term, detail);
      return row;
    }));
    updateReviewSeenStatus(seen);
    renderReviewDocument();
  };

  window.openApprovedApplication = async function (studentId) {
    let student = state.queue.find((item) => String(item.id) === String(studentId));
    if (!student || student.review_status !== 'approved') {
      toast('เปิดดูได้เฉพาะใบสมัครที่ผ่านการอนุมัติแล้ว');
      return;
    }
    try {
      let path = student.document_paths.application_pdf;
      if (!path) {
        toast('กำลังสร้างใบสมัคร PDF…');
        path = await storePdfForApprovedApplication(student);
        student.document_paths.application_pdf = path;
        renderRows();
      }
      const { data, error } = await requireClient().storage.from(STORAGE_BUCKET).createSignedUrl(path, 300);
      if (error) {
        throw error;
      }
      window.closePdfViewer();
      ensurePdfModalControls();
      reviewModalMode = 'approved';
      $('reviewPdfControls').classList.add('hidden');
      $('pdfViewer').classList.remove('review-mode', 'hidden');
      $('pdfViewer').classList.add('reader-mode');
      $('pdfViewerTitle').textContent = `ใบสมัคร PDF · ${student.name}`;
      $('pdfViewerMeta').textContent = `เลขประจำตัว ${student.id} · ${student.room} · อนุมัติแล้ว`;
      pdfViewerZoom = 100;
      $('pdfZoomLabel').textContent = '100%';
      setPdfViewerSource(data.signedUrl, true);
      lockPdfViewerBackground();
    } catch (error) {
      reportError('เปิดใบสมัคร PDF ไม่สำเร็จ', error);
    }
  };

  window.openStudentApplicationPdf = function (studentId) {
    const student = state.queue.find((item) => String(item.id) === String(studentId));
    if (!student) {
      toast('ไม่พบข้อมูลนักเรียน');
      return;
    }
    if (student.document_paths.application_pdf) {
      window.viewStudentFile('application_pdf', student);
      return;
    }
    if (student.review_status === 'approved') {
      window.openApprovedApplication(studentId);
      return;
    }
    if (student.review_status === 'submitted') {
      window.selectStudent(studentId);
      return;
    }
    toast('ใบสมัคร PDF จะพร้อมหลังนักเรียนยืนยันส่งเอกสารครบ');
  };

  window.approveStudent = function () {
    const student = activeReviewQueue[reviewQueueIndex];
    if (!student) {
      return;
    }
    if (!student.document_paths.application_pdf) {
      toast('กำลังสร้างและบันทึก PDF ก่อนอนุมัติ');
      ensureSubmittedApplicationPdf(student);
      return;
    }
    modal('ยืนยันผลตรวจเอกสาร', `อนุมัติ ${student.name} และจัดเก็บใบสมัครเป็น PDF?`, false, async () => {
      let cleanupError;
      let numberReserved = false;
      try {
        const { data: applicationNumber, error: numberError } = await requireClient().rpc('reserve_review_application_number', {
          p_target_user_id: student.user_id
        });
        if (numberError) throw numberError;
        numberReserved = true;
        student.application = { ...(student.application || {}), application_number: Number(applicationNumber) };
        const finalPdf = await createApplicationPdfForStudent(student);
        cleanupError = await approveApplicationWithPdf(student, finalPdf);
      } catch (error) {
        if (numberReserved) {
          const { error: releaseError } = await requireClient().rpc('release_review_application_number', {
            p_target_user_id: student.user_id
          });
          if (releaseError) console.error('ไม่สามารถคืนลำดับใบสมัครได้', releaseError);
        }
        reportError('อนุมัติและจัดเก็บใบสมัคร PDF ไม่สำเร็จ', error);
        return;
      }
      closeModal();
      toast('อนุมัติและจัดเก็บใบสมัคร PDF แล้ว');
      try {
        const nextStudent = activeReviewQueue[reviewQueueIndex + 1] || null;
        await loadAdminData();
        renderRows();
        window.renderQueue();
        const nextIndex = nextStudent ? activeReviewQueue.findIndex((item) => String(item.id) === String(nextStudent.id)) : -1;
        if (nextIndex >= 0) {
          reviewQueueIndex = nextIndex;
          window.renderQueue();
          window.showReviewStudent(activeReviewQueue[reviewQueueIndex], currentReviewDocument);
        } else {
          window.closePdfViewer();
        }
      } catch (error) {
        reportError('อนุมัติแล้ว แต่โหลดรายการนักเรียนใหม่ไม่สำเร็จ', error);
      }
      if (cleanupError) {
        reportError('อนุมัติแล้ว แต่ลบใบสมัคร PDF ฉบับเก่าไม่สำเร็จ', cleanupError);
      }
    });
  };

  window.rejectStudent = function () {
    const student = activeReviewQueue[reviewQueueIndex];
    if (!student) {
      return;
    }
    modal('ไม่ผ่านการตรวจเอกสาร', `ระบุเหตุผลแจ้ง ${student.name}`, true, async () => {
      const reason = $('modalReason').value.trim();
      if (!reason) {
        toast('กรุณาระบุเหตุผล');
        return;
      }
      let cleanupError;
      try {
        cleanupError = await rejectApplication(student, reason);
      } catch (error) {
        reportError('บันทึกผลตรวจไม่สำเร็จ', error);
        return;
      }
      closeModal();
      toast('บันทึกผลไม่ผ่านและลบใบสมัคร PDF แล้ว');
      try {
        const nextStudent = activeReviewQueue[reviewQueueIndex + 1] || null;
        await loadAdminData();
        renderRows();
        window.renderQueue();
        const nextIndex = nextStudent
          ? activeReviewQueue.findIndex((item) => String(item.id) === String(nextStudent.id))
          : -1;
        if (nextIndex >= 0) {
          reviewQueueIndex = nextIndex;
          window.renderQueue();
          window.showReviewStudent(activeReviewQueue[reviewQueueIndex], currentReviewDocument);
        } else {
          window.closePdfViewer();
        }
      } catch (error) {
        reportError('บันทึกผลไม่ผ่านแล้ว แต่โหลดรายการนักเรียนใหม่ไม่สำเร็จ', error);
      }
      if (cleanupError) {
        reportError('บันทึกผลไม่ผ่านแล้ว แต่ลบใบสมัคร PDF ไม่สำเร็จ', cleanupError);
      }
    });
  };

  function prepareLoginUi() {
    document.querySelectorAll('.demo').forEach((element) => element.remove());
    $('loginId').value = '';
    $('loginDob').value = '';
    const adminPassword = $('adminPassword');
    const emailLabel = document.createElement('label');
    emailLabel.className = 'label';
    emailLabel.textContent = 'อีเมล';
    const emailInput = document.createElement('input');
    emailInput.id = 'adminEmail';
    emailInput.type = 'email';
    emailInput.className = 'input';
    emailInput.autocomplete = 'username';
    emailInput.placeholder = 'อีเมลบัญชี Supabase';
    const passwordLabel = adminPassword.previousElementSibling;
    adminPassword.parentNode.insertBefore(emailLabel, passwordLabel);
    adminPassword.parentNode.insertBefore(emailInput, passwordLabel);
    adminPassword.autocomplete = 'current-password';
  }

  async function initialize() {
    const studentForm = $('studentApp');
    if (studentForm) {
      studentForm.addEventListener('input', refreshSubmitApplicationButton);
      studentForm.addEventListener('change', refreshSubmitApplicationButton);
      $('roomList')?.addEventListener('click', () => window.setTimeout(refreshSubmitApplicationButton, 0));
    }
    prepareLoginUi();
    loadReviewSettings();
    students.splice(0, students.length);
    renderRows();
    renderQueue();
    if (!client) {
      toast('เชื่อมต่อ Supabase ไม่ได้ กรุณาตรวจการโหลด SDK');
      return;
    }
    const { data, error } = await client.auth.getSession();
    if (error) {
      reportError('ตรวจสอบสถานะการเข้าสู่ระบบไม่สำเร็จ', error);
      return;
    }
    if (!data.session) {
      return;
    }
    try {
      await loadProfile(data.session.user);
      if (state.profile.role === 'student') {
        await loadStudentApplication();
        studentLoggedIn = true;
        showStudentHome();
      } else if (isStaff()) {
        await loadAdminData();
        hideViews();
        $('adminApp').classList.remove('hidden');
        renderRows();
        renderQueue();
        startStaffQueueRefresh();
      } else {
        throw new Error('บัญชีไม่มีสิทธิ์ใช้งานระบบ');
      }
    } catch (error) {
      reportError('โหลดข้อมูลบัญชีไม่สำเร็จ', error);
    }
  }

  client && client.auth.onAuthStateChange((_event, session) => {
    if (!session) {
      state.user = null;
      state.profile = null;
    }
  });

  window.importStudentRows = async function (studentsToImport) {
    if (!isStaff()) throw new Error('บัญชีนี้ไม่มีสิทธิ์นำเข้าข้อมูลนักเรียน');
    const { data, error } = await requireClient().functions.invoke('import-students', {
      body: { students: studentsToImport }
    });
    if (error) {
      try { error.importResponseInfo = await error.context.clone().json(); } catch { /* keep the function error */ }
      throw error;
    }
    return data;
  };

  window.refreshImportedStudentList = async function () {
    await loadAdminData();
    renderRows();
    window.renderQueue();
  };

  initialize();
})();
