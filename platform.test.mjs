import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createPlatform } from './server.mjs';

test('school accounts, teacher permissions, synchronization and credential revocation', async () => {
  const database = new PGlite();
  const platform = await createPlatform(database, { secret: 'test'.repeat(16) });
  await new Promise(resolve => platform.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + platform.address().port;
  async function call(path, body, token, method = body ? 'POST' : 'GET') {
    const response = await fetch(base + '/api/' + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {})
      },
      body: body && JSON.stringify(body)
    });
    return { status: response.status, ...(await response.json()) };
  }
  try {
    const school = await call('register', { name: 'مدير المدرسة الأول', school: 'مدرسة أ', pin: '12457896' });
    const other = await call('register', { name: 'مدير المدرسة الثاني', school: 'مدرسة ب', pin: '14859632' });
    assert.equal(school.status, 200);
    const sessionRows = await database.query("SELECT expires::text FROM madrasti_sessions WHERE school_code=$1", [school.account.schoolCode]);
    assert.equal(sessionRows.rows[0].expires, 'infinity');
    assert.equal(other.status, 200);
    assert.notEqual(school.account.schoolCode, other.account.schoolCode);
    assert.equal((await call('state')).status, 401);

    const data = school.data;
    data.classes = [{ id: 'c1', name: 'أ' }, { id: 'c2', name: 'ب' }];
    data.subjects = [{ id: 'sub', name: 'رياضيات' }];
    data.students = [{ id: 's1', name: 'طالب مسند', group: 'أ' }, { id: 's2', name: 'طالب آخر', group: 'ب' }];
    data.teachers = [{ id: 't1', name: 'مدرس جديد', phone: '9647701234567',
      assignments: [{ id: 'a1', group: 'أ', subject: 'رياضيات', weekly: 2 }], leaves: [] }];
    data.announcements.push({ id: 'n1', title: 'إعلان', detail: 'للمدرسين' });
    assert.equal((await call('state', { data, revision: school.revision, credential: { id: 't1', pin: '1357' } }, school.token, 'PUT')).status, 200);
    assert.deepEqual((await call('state', null, other.token)).data.students, []);
    const login = { school: 'مدرسة أ', name: 'مدرس جديد', pin: '1357' };
    assert.equal((await call('login', { ...login, school: 'مدرسة ب' })).status, 401);
    const teacher = await call('login', login);
    assert.equal(teacher.status, 200);
    assert.deepEqual(teacher.data.students.map(s => s.id), ['s1']);
    assert.equal(teacher.data.announcements[0].title, 'إعلان');
    assert.equal(teacher.data.teachers[0].phone, undefined);
    assert.equal(teacher.data.teachers[0].pinHash, undefined);

    const change = structuredClone(teacher.data);
    change.students.push({ id: 's2', name: 'غير مسموح', group: 'ب' });
    assert.equal((await call('state', { data: change, revision: teacher.revision }, teacher.token, 'PUT')).status, 403);
    change.students.pop();
    change.grades['رياضيات|s1'] = 85;
    change.teacherNotifications.unshift({ id: 'report1', page: 'الدرجات', teacher: 'اسم مزور', items: ['تم رصد الدرجات'] });
    assert.equal((await call('state', { data: change, revision: teacher.revision }, teacher.token, 'PUT')).status, 200);
    assert.equal((await call('state', { data: change, revision: teacher.revision }, teacher.token, 'PUT')).status, 409);
    const current = await call('state', null, school.token);
    assert.equal(current.data.grades['رياضيات|s1'], 85);
    assert.equal(current.data.teacherNotifications[0].teacher, 'مدرس جديد');
    assert.equal(current.data.students.length, 2);
    assert.equal((await call('state', { data: current.data, revision: current.revision, credential: { id: 't1', pin: '6543' } }, school.token, 'PUT')).status, 200);
    assert.equal((await call('state', null, teacher.token)).status, 401);
    assert.equal((await call('logout', {}, school.token)).status, 200);
    assert.equal((await call('state', null, school.token)).status, 401);
  } finally {
    await new Promise(resolve => platform.close(resolve));
    await database.close();
  }
});
