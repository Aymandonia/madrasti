
const cloud = { token: '', account: null, revision: 0, pending: [], sending: false, failed: null, baseline: '', generation: 0 };
const dataFields = ['school','schoolType','year','students','teachers','classes','subjects','attendance','grades','schedule','homework','announcements','teacherNotifications'];
function emptySchool() {
  return { logged: false, theme: 'light', students: [], teachers: [], schools: [] };
}
let db = emptySchool();
function schoolSnapshot() {
  return Object.fromEntries(dataFields.map(key => [key, db[key]]));
}
function apiAddress() {
  const url = new URL(window.MADRASTI_API || '/api', location.href);
  if (url.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(url.hostname))
    throw new Error('أضف رابط Render في ملف config.js');
  if (!window.MADRASTI_API && !['localhost','127.0.0.1'].includes(location.hostname))
    throw new Error('أضف رابط Render في ملف config.js');
  return url.href.replace(/\/$/, '');
}
async function api(path, method = 'GET', body, token = cloud.token) {
  const response = await fetch(apiAddress() + path, {
    method, cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(70000),
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body && JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) throw Object.assign(new Error(payload.error), { status: response.status });
  return payload;
}
function installSchool(payload) {
  cloud.account = payload.account;
  cloud.revision = payload.revision;
  db = { ...payload.data, logged: true, theme: db.theme,
    role: payload.account.role === 'teacher' ? 'المدرس' : 'مدير المدرسة',
    activeTeacherId: payload.account.role === 'teacher' ? payload.account.id : null,
    schools: [{ id: payload.account.schoolCode, name: payload.data.school, manager: payload.account.role === 'manager' ? payload.account.name : '', active: true }]
  };
  cloud.baseline = snapshotVersion(schoolSnapshot());
}
function snapshotVersion(data) {
  return JSON.stringify(data, (key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(name => [name, value[name]]))
    : value);
}
function syncStatus() {
  const status = $('#syncStatus');
  if (status) status.textContent = cloud.failed ? cloud.failed.message : cloud.sending || cloud.pending.length ? 'جارٍ الحفظ…' : 'متصل';
  if ($('#syncRecovery')) $('#syncRecovery').hidden = !cloud.failed;
}
function save(credential, success) {
  if (!cloud.token) return false;
  cloud.pending.push({ data: structuredClone(schoolSnapshot()), credential, success });
  void flushSchool();
  return true;
}
async function flushSchool() {
  if (!cloud.token || cloud.sending || cloud.failed || !cloud.pending.length) return;
  cloud.sending = true;
  syncStatus();
  const generation = cloud.generation;
  try {
    while (cloud.pending.length && generation === cloud.generation) {
      const change = cloud.pending[0];
      const result = await api('/state', 'PUT', { data: change.data, revision: cloud.revision, credential: change.credential });
      if (generation !== cloud.generation) return;
      cloud.pending.shift();
      cloud.revision = result.revision;
      cloud.baseline = JSON.stringify(result.data);
      if (!cloud.pending.length) {
        db.teacherNotifications = result.data.teacherNotifications;
        const saved = { ...change.data, teacherNotifications: result.data.teacherNotifications };
        cloud.baseline = snapshotVersion(saved);
      }
      change.success?.();
      if (!change.success) toast('تمت المزامنة');
    }
  } catch (error) {
    if (generation !== cloud.generation) return;
    if (error.status === 401) {
      await signOut(true);
      return;
    }
    cloud.failed = error;
    toast(error.status === 409 ? 'تغيّرت بيانات المدرسة. يمكنك تحديث البيانات وإعادة إدخال التعديل.' : 'لم يُحفظ التعديل في الخادم');
  } finally {
    if (generation === cloud.generation) {
      cloud.sending = false;
      syncStatus();
    }
  }
}
async function recoverSync() {
  if (!cloud.failed) return;
  if (!cloud.failed.status || cloud.failed.status >= 500) {
    cloud.failed = null;
    await flushSchool();
    return;
  }
  if (!confirm('تحديث بيانات المدرسة؟ ستُفقد التعديلات التي لم تُحفظ.')) return;
  try {
    const result = await api('/state');
    cloud.pending = [];
    cloud.failed = null;
    installSchool(result);
    render();
  } catch (error) {
    if (error.status === 401) await signOut(true);
    else toast('تعذر تحديث البيانات');
  }
}
let polling = false, lastNotified = '';
function canRefresh() {
  return !cloud.sending && !cloud.pending.length && !cloud.failed && !$('#modal')?.open &&
    !exportSession && page !== 'teacherTools' &&
    !document.activeElement?.matches('input,textarea,select,iframe') &&
    snapshotVersion(schoolSnapshot()) === cloud.baseline;
}
async function refreshSchool() {
  if (!cloud.token || polling || document.hidden) return;
  const generation = cloud.generation;
  polling = true;
  try {
    const result = await api('/state');
    if (generation !== cloud.generation || result.revision <= cloud.revision) return;
    const notice = (isTeacher() ? result.data.announcements : result.data.teacherNotifications)[0];
    const prior = (isTeacher() ? db.announcements : db.teacherNotifications)[0];
    if (notice && notice.id !== prior?.id && notice.id !== lastNotified) {
      lastNotified = notice.id;
      toast(isTeacher() ? 'إعلان جديد من إدارة المدرسة' : 'وصل إشعار جديد من مدرس');
    }
    if (canRefresh()) { installSchool(result); render(); }
  } catch (error) {
    if (generation === cloud.generation && error.status === 401) await signOut(true);
  } finally { polling = false; }
}
setInterval(refreshSchool, 10000);
window.addEventListener('focus', refreshSchool);
window.addEventListener('beforeunload', event => {
  if (cloud.pending.length || (cloud.token && snapshotVersion(schoolSnapshot()) !== cloud.baseline)) {
    event.preventDefault();
    event.returnValue = '';
  }
});
async function signOut(force = false) {
  const unsaved = cloud.pending.length || (cloud.token && snapshotVersion(schoolSnapshot()) !== cloud.baseline);
  if (!force && unsaved && !confirm('هناك تعديلات لم تُحفظ. تسجيل الخروج؟')) return;
  const token = cloud.token;
  Object.assign(cloud, { token: '', account: null, revision: 0, pending: [], sending: false, failed: null, baseline: '', generation: cloud.generation + 1 });
  db = emptySchool();
  lastNotified = '';
  window.reportData = null;
  closeModal();
  $('#modalBody').textContent = '';
  loginView = 'login';
  render();
  if (token) api('/logout', 'POST', null, token).catch(() => {});
}
function whatsappPhone(value) {
  let phone = normalizePin(value).replace(/[\s()+-]/g, '').replace(/^00/, '');
  if (/^07\d{9}$/.test(phone)) phone = '964' + phone.slice(1);
  return /^\d{8,15}$/.test(phone) ? phone : '';
}
function showTeacherAccess(teacher, pin) {
  const message = ['بيانات دخول منصة مدرستي', 'الرابط: ' + location.origin + location.pathname,
    'اسم المدرسة: ' + db.school, 'الاسم: ' + teacher.name, 'الرمز: ' + pin].join('\n');
  const phone = whatsappPhone(teacher.phone || '');
  const link = phone ? '<a class="btn" target="_blank" rel="noopener noreferrer" href="https://wa.me/' + phone + '?text=' + esc(encodeURIComponent(message)) + '">مشاركة عبر واتساب</a>' : '';
  dialog(`<h2>بيانات دخول المدرس</h2><p class="hint" style="white-space:pre-line">${esc(message)}</p><div class="dialog-actions">${link}<button class="btn outline" onclick="closeModal()">إغلاق</button></div>`);
}

