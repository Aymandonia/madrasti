import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { promisify, isDeepStrictEqual } from 'node:util';
import pg from 'pg';

const derive = promisify(scrypt);
const digest = value => createHash('sha256').update(value).digest('hex');
const denied = (status, message) => Object.assign(new Error(message), { status });
const requireThat = (condition, status = 422, message = 'تحقق من البيانات المدخلة') => {
  if (!condition) throw denied(status, message);
};
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const idOk = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const line = (value, max = 120) => {
  requireThat(typeof value === 'string' && value.trim() && value.trim().length <= max);
  return value.trim().replace(/\s+/gu, ' ').normalize('NFC');
};
const pinOk = value => typeof value === 'string' && /^[0-9]{8}$/.test(value);
const lists = ['teachers', 'classes', 'subjects', 'students', 'schedule', 'homework', 'announcements', 'teacherNotifications'];
const maps = ['attendance', 'grades'];
const settings = ['school', 'schoolType', 'year'];
const initial = school => ({
  school, schoolType: 'ابتدائية',
  year: (() => { const year = new Date().getFullYear(); return year + ' / ' + (year + 1); })(),
  ...Object.fromEntries(lists.map(key => [key, []])), attendance: {}, grades: {}
});
const dataKeys = [...lists, ...maps, ...settings];
const staticTypes = { '/': 'text/html', '/index.html': 'text/html', '/cloud.js': 'text/javascript', '/config.js': 'text/javascript' };
const subset = (obj, fn) => Object.fromEntries(Object.entries(obj).filter(([key, val]) => fn(key, val)));

function validateList(list) {
  requireThat(Array.isArray(list) && list.length <= 12000);
  const ids = new Set();
  for (const item of list) {
    requireThat(record(item) && idOk(item.id) && !ids.has(item.id));
    ids.add(item.id);
  }
}
function checkTree(value, depth = 0) {
  requireThat(depth <= 24);
  if (typeof value === 'string') requireThat(value.length <= 12000);
  if (typeof value === 'number') requireThat(Number.isFinite(value));
  if (Array.isArray(value)) {
    requireThat(value.length <= 12000);
    for (const child of value) checkTree(child, depth + 1);
  }
  if (record(value)) {
    for (const [key, child] of Object.entries(value)) {
      requireThat(key.length <= 250 && !['__proto__', 'prototype', 'constructor'].includes(key));
      if (key === 'id') requireThat(idOk(child));
      checkTree(child, depth + 1);
    }
  }
}
function schoolData(input, old) {
  const data = Object.fromEntries(dataKeys.map(key => [key, input[key]]));
  for (const key of lists) validateList(data[key]);
  for (const key of maps) requireThat(record(data[key]));
  for (const key of settings) data[key] = line(data[key]);
  const names = new Set();
  for (const teacher of data.teachers) {
    teacher.name = line(teacher.name);
    requireThat(!names.has(teacher.name), 409, 'اسم المدرس مستخدم في هذه المدرسة');
    names.add(teacher.name);
    validateList(teacher.assignments);
    validateList(teacher.leaves);
    requireThat(!teacher.phone || (typeof teacher.phone === 'string' && /^\d{8,15}$/.test(teacher.phone)));
    requireThat(teacher.disabled == null || typeof teacher.disabled === 'boolean');
  }
  for (const key of ['classes', 'subjects', 'students']) {
    for (const entry of data[key]) {
      line(entry.name);
      if (key === 'students') line(entry.group);
      requireThat(!entry.name.includes('|'));
    }
  }
  for (const entry of data.homework) {
    line(entry.group);
    line(entry.subject);
    line(entry.title);
    requireThat(Array.isArray(entry.delivered) && entry.delivered.every(idOk));
  }
  for (const entry of data.schedule) {
    for (const key of ['teacher', 'group', 'subject', 'day', 'period']) line(entry[key]);
  }
  return { ...data, teacherNotifications: old.teacherNotifications.filter(note =>
    data.teacherNotifications.some(item => item.id === note.id)) };
}

function teacherAccess(data, teacher) {
  const groups = new Set(teacher.assignments.map(a => a.group));
  const pair = (group, subject) => teacher.assignments.some(a => a.group === group && a.subject === subject);
  const studentOk = s => groups.has(s.group);
  const students = data.students.filter(studentOk);
  return { groups, pair, studentOk, students };
}
function teacherView(data, teacher) {
  const { groups, pair, students } = teacherAccess(data, teacher);
  const byId = new Map(students.map(s => [s.id, s]));
  const homework = data.homework.filter(h => pair(h.group, h.subject));
  const { phone, sessionVersion, ...visibleTeacher } = teacher;
  return {
    ...data, teachers: [visibleTeacher], students,
    classes: data.classes.filter(c => groups.has(c.name)),
    subjects: data.subjects.filter(s => teacher.assignments.some(a => a.subject === s.name)),
    schedule: data.schedule.filter(l => l.teacher === teacher.name && pair(l.group, l.subject)),
    homework, teacherNotifications: [],
    attendance: subset(data.attendance, key => byId.has(key.split('|')[1])),
    grades: subset(data.grades, key => {
      const [subject, id] = key.split('|');
      return pair(byId.get(id)?.group, subject);
    })
  };
}
function teacherWrite(data, incoming, teacher) {
  const { studentOk, pair } = teacherAccess(data, teacher);
  const permitted = condition => requireThat(condition, 403, 'التغيير خارج صلاحيات المدرس');
  const replace = (old, next, allowed) => {
    validateList(next);
    const hidden = old.filter(item => !allowed(item));
    const hiddenIds = new Set(hidden.map(item => item.id));
    permitted(next.every(item => allowed(item) && !hiddenIds.has(item.id)));
    return [...hidden, ...next];
  };
  const students = replace(data.students, incoming.students, studentOk);
  const current = new Map(students.map(s => [s.id, s]));
  const previous = new Map(data.students.map(s => [s.id, s]));
  for (const student of incoming.students) {
    line(student.name);
    permitted(!previous.has(student.id) || previous.get(student.id).group === student.group);
  }
  const applyMap = (kind, allowed, valid) => {
    const map = incoming[kind];
    requireThat(record(map));
    for (const [key, value] of Object.entries(map)) {
      const parts = key.split('|');
      permitted(parts.length === 2 && allowed(parts, current));
      requireThat(valid(parts, value));
    }
    return {
      ...subset(data[kind], key => !allowed(key.split('|'), previous) && current.has(key.split('|')[1])),
      ...map
    };
  };
  const attendance = applyMap('attendance', ([, id], byId) => groupsHas(byId, id),
    ([date], status) => /^\d{4}-\d{2}-\d{2}$/.test(date) && ['حاضر','غائب','بعذر','متأخر','عطلة',''].includes(status));
  function groupsHas(byId, id) { return byId.has(id) && studentOk(byId.get(id)); }
  const grades = applyMap('grades', ([subject, id], byId) => pair(byId.get(id)?.group, subject),
    (_, mark) => typeof mark === 'number' && mark >= 0 && mark <= 100);
  const homework = replace(data.homework, incoming.homework, h => pair(h.group, h.subject));
  for (const item of incoming.homework) {
    line(item.title);
    requireThat(typeof item.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.date));
    requireThat(Array.isArray(item.delivered) && item.delivered.every(idOk));
  }
  const own = incoming.teachers?.find?.(t => t.id === teacher.id);
  permitted(own && (own.toolbox === undefined || record(own.toolbox)));
  validateList(incoming.teacherNotifications);
  const notes = incoming.teacherNotifications;
  requireThat(notes.length <= 10);
  const notices = notes.filter(note => !data.teacherNotifications.some(existing => existing.id === note.id)).map(note => {
    requireThat(Array.isArray(note.items) && note.items.length <= 500 && note.items.every(item => typeof item === 'string' && item.length <= 2000));
    return {
      id: note.id, teacher: teacher.name, page: line(note.page, 100),
      group: typeof note.group === 'string' ? note.group.slice(0, 100) : '',
      subject: typeof note.subject === 'string' ? note.subject.slice(0, 100) : '',
      date: new Date().toISOString(), items: note.items
    };
  });
  return { ...data, students, attendance, grades, homework,
    teachers: data.teachers.map(t => t.id === teacher.id && own.toolbox !== undefined ? { ...t, toolbox: own.toolbox } : t),
    teacherNotifications: [...notices, ...data.teacherNotifications].slice(0, 1500)
  };
}

export async function createPlatform(db, { secret, origin, proxy = false } = {}) {
  if (!secret || secret.length < 32) throw new Error('APP_SECRET must contain at least 32 characters');
  await db.query(`CREATE TABLE IF NOT EXISTS madrasti_schools (
    code text PRIMARY KEY, manager text NOT NULL, manager_hash text NOT NULL,
    data jsonb NOT NULL, credentials jsonb NOT NULL DEFAULT '{}', revision integer NOT NULL DEFAULT 0
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS madrasti_sessions (
    token_hash text PRIMARY KEY, school_code text NOT NULL REFERENCES madrasti_schools(code) ON DELETE CASCADE,
    account_id text NOT NULL, credential_version text NOT NULL, expires timestamptz NOT NULL
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS madrasti_attempts (
    key text PRIMARY KEY, attempts integer NOT NULL, expires timestamptz NOT NULL
  )`);
  const keyed = value => createHmac('sha256', secret).update(value).digest('hex');
  async function hash(pin, salt = randomBytes(16).toString('hex')) {
    return salt + ':' + Buffer.from(await derive(keyed(pin), salt, 32)).toString('hex');
  }
  const dummy = await hash('00000000');
  async function limit(key, max) {
    const result = await db.query(`INSERT INTO madrasti_attempts VALUES ($1, 1, now() + interval '15 min')
      ON CONFLICT (key) DO UPDATE SET attempts = CASE WHEN madrasti_attempts.expires <= now() THEN 1
        ELSE madrasti_attempts.attempts + 1 END, expires = CASE WHEN madrasti_attempts.expires <= now()
        THEN excluded.expires ELSE madrasti_attempts.expires END RETURNING attempts`, [keyed(key)]);
    requireThat(result.rows[0].attempts <= max, 429, 'محاولات كثيرة، حاول مرة أخرى بعد ١٥ دقيقة');
  }
  const cleanup = setInterval(() => {
    for (const table of ['madrasti_attempts', 'madrasti_sessions']) {
      db.query('DELETE FROM ' + table + ' WHERE expires <= now()').catch(() => {});
    }
  }, 600000);
  cleanup.unref();
  const credentialFor = (row, id) => id === 'manager' ? row.manager_hash : row.credentials[id];
  const activeTeacher = (row, id) => row.data.teachers.find(t => t.id === id && !t.disabled);
  const accountVersion = (row, id) => digest(credentialFor(row, id) + ':' +
    (activeTeacher(row, id)?.sessionVersion || ''));
  const view = (row, id) => {
    const teacher = id === 'manager' ? null : activeTeacher(row, id);
    return {
      account: { role: teacher ? 'teacher' : 'manager', id, name: teacher?.name || row.manager, schoolCode: row.code },
      data: teacher ? teacherView(row.data, teacher) : row.data, revision: row.revision
    };
  };
  async function session(row, id) {
    const token = randomBytes(32).toString('base64url');
    await db.query(`INSERT INTO madrasti_sessions VALUES ($1,$2,$3,$4,now() + interval '12 hours')`,
      [digest(token), row.code, id, accountVersion(row, id)]);
    return { token, ...view(row, id) };
  }
  async function body(req) {
    requireThat(req.headers['content-type']?.split(';')[0] === 'application/json', 415);
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      requireThat(size <= 8 * 1024 * 1024, 413, 'حجم البيانات يتجاوز الحد المسموح');
      chunks.push(chunk);
    }
    let result;
    try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw denied(400, 'بيانات غير صالحة'); }
    requireThat(record(result));
    checkTree(result);
    return result;
  }

  const server = createServer(async (req, res) => {
    const path = req.url?.split('?')[0];
    const method = req.method;
    const from = req.headers.origin;
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    };
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Vary', 'Origin');
      if (proxy) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
      if (!proxy && method === 'GET' && Object.hasOwn(staticTypes, path)) {
        const file = path === '/' ? 'index.html' : path.slice(1);
        const content = await readFile(new URL(file, import.meta.url));
        res.writeHead(200, { 'Content-Type': staticTypes[path] + '; charset=utf-8' });
        return res.end(content);
      }
      if (path === '/health' && method === 'GET') {
        await db.query('SELECT 1');
        return send(200, { ok: true });
      }
      const isLocal = !proxy && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(from ?? '');
      if (from) {
        requireThat(from === origin || isLocal, 403, 'عنوان الواجهة غير مسموح');
        res.setHeader('Access-Control-Allow-Origin', from);
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
      }
      if (method === 'OPTIONS' && path?.startsWith('/api/')) {
        res.writeHead(204);
        return res.end();
      }
      const ip = proxy ? String(req.headers['x-forwarded-for'] || '').split(',').at(-1).trim() : req.socket.remoteAddress;
      if (method === 'POST' && path === '/api/register') {
        await limit('register:' + ip, 8);
        const input = await body(req);
        const name = line(input.name), school = line(input.school);
        requireThat(name.split(' ').length >= 3 && pinOk(input.pin), 422, 'أدخل الاسم الثلاثي ورمزاً من ثمانية أرقام');
        const code = randomBytes(6).toString('hex').toUpperCase();
        const result = await db.query('INSERT INTO madrasti_schools (code, manager, manager_hash, data) VALUES ($1,$2,$3,$4) RETURNING *',
          [code, name, await hash(input.pin), JSON.stringify(initial(school))]);
        return send(200, await session(result.rows[0], 'manager'));
      }
      if (method === 'POST' && path === '/api/login') {
        await limit('login-ip:' + ip, 30);
        const input = await body(req);
        const code = line(input.schoolCode, 12).toUpperCase(), name = line(input.name);
        requireThat(/^[A-F0-9]{12}$/.test(code) && pinOk(input.pin));
        await limit('login-account:' + code + ':' + name, 8);
        const { rows: [row] } = await db.query('SELECT * FROM madrasti_schools WHERE code=$1', [code]);
        const teacher = row?.data.teachers.find(t => t.name === name && !t.disabled);
        const id = row?.manager === name ? 'manager' : teacher?.id;
        const stored = (id && credentialFor(row, id)) || dummy;
        const actual = await hash(input.pin, stored.split(':')[0]);
        requireThat(timingSafeEqual(Buffer.from(stored), Buffer.from(actual)) && id && credentialFor(row, id),
          401, 'معرّف المدرسة أو الاسم أو الرمز غير صحيح');
        return send(200, await session(row, id));
      }
      requireThat(['/api/state', '/api/logout'].includes(path), 404, 'الصفحة غير موجودة');
      const token = /^Bearer ([\w-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
      requireThat(token, 401, 'سجّل الدخول مجدداً');
      const tokenHash = digest(token);
      const { rows: [row] } = await db.query(`SELECT s.*, a.account_id, a.credential_version
        FROM madrasti_sessions a JOIN madrasti_schools s ON s.code=a.school_code
        WHERE a.token_hash=$1 AND a.expires > now()`, [tokenHash]);
      const id = row?.account_id;
      const stored = row && credentialFor(row, id);
      requireThat(stored && accountVersion(row, id) === row.credential_version && (id === 'manager' || activeTeacher(row,id)),
        401, 'سجّل الدخول مجدداً');
      if (method === 'POST' && path === '/api/logout') {
        await db.query('DELETE FROM madrasti_sessions WHERE token_hash=$1', [tokenHash]);
        return send(200, { ok: true });
      }
      if (method === 'GET' && path === '/api/state') return send(200, view(row, id));
      requireThat(method === 'PUT' && path === '/api/state', 405, 'طريقة غير مسموحة');
      const input = await body(req);
      requireThat(input.revision === row.revision, 409, 'تغيّرت البيانات على جهاز آخر');
      requireThat(record(input.data));
      const data = id === 'manager' ? schoolData(input.data, row.data) : teacherWrite(row.data, input.data, activeTeacher(row,id));
      let credentials = row.credentials;
      if (id === 'manager') {
        credentials = subset(credentials, key => data.teachers.some(t => t.id === key));
        if (input.credential) {
          const { id: teacherId, pin } = input.credential;
          requireThat(teacherId !== 'manager' && pinOk(pin) && data.teachers.some(t => t.id === teacherId));
          credentials[teacherId] = await hash(pin);
        }
        for (const teacher of data.teachers) {
          requireThat(teacher.name !== row.manager && teacher.id !== 'manager' && Object.hasOwn(credentials, teacher.id),
            422, 'تأكد من رمز المدرس واختر اسماً مختلفاً عن اسم المدير');
          const previous = row.data.teachers.find(t => t.id === teacher.id);
          teacher.sessionVersion = previous && Boolean(previous.disabled) === Boolean(teacher.disabled)
            ? previous.sessionVersion || '' : randomBytes(16).toString('hex');
        }
      }
      if (isDeepStrictEqual(data, row.data) && isDeepStrictEqual(credentials, row.credentials)) return send(200, view(row, id));
      const saved = await db.query(`UPDATE madrasti_schools SET data=$1, credentials=$2, revision=revision+1
        WHERE code=$3 AND revision=$4 RETURNING *`, [JSON.stringify(data), JSON.stringify(credentials), row.code, row.revision]);
      requireThat(saved.rows.length, 409, 'تغيّرت البيانات على جهاز آخر');
      return send(200, view(saved.rows[0], id));
    } catch (error) {
      if (!error.status) console.error('Request failed:', error.code || error.name);
      if (!res.headersSent) send(error.status || 500, { error: error.status ? error.message : 'تعذّر الاتصال بالخدمة' });
    }
  });
  server.on('close', () => clearInterval(cleanup));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { DATABASE_URL, APP_SECRET, FRONTEND_ORIGIN, NODE_ENV, PORT = 3000 } = process.env;
  if (!DATABASE_URL || !FRONTEND_ORIGIN) throw new Error('Set DATABASE_URL and FRONTEND_ORIGIN');
  const url = new URL(DATABASE_URL);
  if (NODE_ENV === 'production') url.searchParams.set('sslmode', 'verify-full');
  const pool = new pg.Pool({ connectionString: url.href, max: 8, connectionTimeoutMillis: 12000 });
  pool.on('error', error => console.error('Database connection:', error.code || error.name));
  const server = await createPlatform(pool, { secret: APP_SECRET, origin: new URL(FRONTEND_ORIGIN).origin, proxy: NODE_ENV === 'production' });
  server.listen(Number(PORT), '0.0.0.0', () => console.log('Madrasti API listening on port ' + PORT));
}

