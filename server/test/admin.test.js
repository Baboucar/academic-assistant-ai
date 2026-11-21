import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setup } from './helpers.js';

// The ingest package owns the spreadsheet dependency
const require = createRequire(new URL('../../ingest/package.json', import.meta.url));
const xlsx = require('xlsx');

let ctx;
before(async () => { ctx = await setup(); });
after(async () => { await ctx.close(); });

function workbook(rows) {
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(rows), 'Timetable');
    return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function uploadForm(name, bytes, fields = {}) {
    const fd = new FormData();
    fd.append('file', new Blob([bytes]), name);
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    return fetch(`${ctx.base}/api/admin/upload`, { method: 'POST', headers: ctx.auth(), body: fd });
}

const sources = async () => (await (await fetch(`${ctx.base}/api/admin/sources`, { headers: ctx.auth() })).json());

test('admin routes need valid credentials', async () => {
    assert.equal((await fetch(`${ctx.base}/api/admin/sources`)).status, 401);
    const wrong = await fetch(`${ctx.base}/api/admin/sources`, { headers: ctx.auth('admin', 'nope') });
    assert.equal(wrong.status, 401);
    // no native browser password prompt on top of the app's own form
    assert.equal(wrong.headers.get('www-authenticate'), null);
    assert.equal((await fetch(`${ctx.base}/api/admin/sources`, { headers: ctx.auth() })).status, 200);
});

test('sources list includes row counts', async () => {
    const body = await sources();
    const seed = body.sources.find((s) => s.source_file === 'seed.xlsx');
    assert.equal(seed.row_count, 5);
    assert.equal(body.counts.timetable, 5);
});

test('upload ingests the file and reports the result', async () => {
    const bytes = workbook([
        { 'Course Code': 'MTH 101', 'Course Title': 'Calculus I', Day: 'Wed', Start: '08:30', End: '10:30', Room: 'Hall C', Instructor: 'Dr. Musa Bah' },
        { 'Course Code': 'MTH 102', 'Course Title': 'Algebra', Day: 'Fri', Start: '11:00', End: '13:00', Room: 'Hall C', Instructor: 'Dr. Musa Bah' },
    ]);
    const r = await uploadForm('maths timetable.xlsx', bytes, { type: 'timetable', semester: '2026 S1', reingest: '1' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.file, 'maths_timetable.xlsx');
    assert.equal(body.ingest.ok, true);
    assert.match(body.ingest.log, /maths_timetable\.xlsx -> \+2/);
    // only the uploaded file was ingested
    assert.doesNotMatch(body.ingest.log, /seed/);

    const row = (await sources()).sources.find((s) => s.source_file === 'maths_timetable.xlsx');
    assert.equal(row.row_count, 2);
    assert.equal(row.semester, '2026 S1');
});

test('an exam timetable upload is read into the exams table, whatever the column spelling', async () => {
    const bytes = workbook([
        { 'Exam Date': '12/01/2099', Time: '9:00am - 12:00pm', 'Course Code': 'MTH 101', 'Course Title': 'Calculus I', Hall: 'Exam Hall 3' },
        { 'Exam Date': 'Wednesday, 14th January 2099', Time: '14:00-17:00', 'Course Code': 'MTH 102', 'Course Title': 'Algebra', Hall: 'Exam Hall 3' },
        { 'Exam Date': '', Time: '', 'Course Code': 'Invigilators to arrive 30 minutes early', 'Course Title': '', Hall: '' },
    ]);
    const r = await uploadForm('maths finals.xlsx', bytes, { type: 'exams', semester: '2026 S1', reingest: '1' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ingest.ok, true);
    assert.match(body.ingest.log, /Exam timetable: maths_finals\.xlsx -> \+2/);

    const rows = ctx.db
        .prepare(`SELECT course_code, date, start_time, end_time, venue FROM exams WHERE source_file = 'maths_finals.xlsx' ORDER BY date`)
        .all();
    assert.deepEqual(rows, [
        { course_code: 'MTH 101', date: '2099-01-12', start_time: '09:00', end_time: '12:00', venue: 'Exam Hall 3' },
        { course_code: 'MTH 102', date: '2099-01-14', start_time: '14:00', end_time: '17:00', venue: 'Exam Hall 3' },
    ]);
    const listed = (await sources()).sources.find((s) => s.source_file === 'maths_finals.xlsx');
    assert.deepEqual({ type: listed.type, rows: listed.row_count }, { type: 'exams', rows: 2 });

    // deleting the source removes its exams too
    const del = await fetch(`${ctx.base}/api/admin/source/maths_finals.xlsx?deleteFile=1`, { method: 'DELETE', headers: ctx.auth() });
    assert.equal((await del.json()).removed_rows, 2);
});

test('the department chosen at upload labels every row from that file', async () => {
    const bytes = workbook([
        { 'Course Code': 'LAW 101', 'Course Title': 'Constitutional Law', Day: 'Mon', Start: '09:00', End: '11:00', Room: 'Moot Court', Instructor: 'Dr. Binta Jatta' },
    ]);
    const r = await uploadForm('faculty of law.xlsx', bytes, { type: 'timetable', dept: ' law ', reingest: '1' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).dept, 'LAW');
    assert.equal(ctx.db.prepare(`SELECT dept FROM timetable WHERE course_code = 'LAW 101'`).get().dept, 'LAW');
    assert.equal((await sources()).sources.find((s) => s.source_file === 'faculty_of_law.xlsx').dept, 'LAW');

    // re-ingesting keeps the label
    await ctx.post('/api/admin/reingest', { file: 'faculty_of_law.xlsx' }, ctx.auth());
    assert.equal(ctx.db.prepare(`SELECT dept FROM timetable WHERE course_code = 'LAW 101'`).get().dept, 'LAW');

    const bad = await uploadForm('other.xlsx', bytes, { type: 'timetable', dept: "x'; DROP TABLE users;--", reingest: '0' });
    assert.equal(bad.status, 400);
    assert.ok(!fs.existsSync(path.join(ctx.dataDir, 'other.xlsx')));

    await fetch(`${ctx.base}/api/admin/source/faculty_of_law.xlsx?deleteFile=1`, { method: 'DELETE', headers: ctx.auth() });
});

test('upload rejects unsupported files and impossible types', async () => {
    const exe = await uploadForm('run.sh', 'echo hi', { type: 'timetable' });
    assert.equal(exe.status, 400);
    assert.ok(!fs.existsSync(path.join(ctx.dataDir, 'run.sh')));

    const mismatch = await uploadForm('notes.xlsx', workbook([{ a: 1 }]), { type: 'notices', reingest: '0' });
    assert.equal(mismatch.status, 400);
    assert.ok(!fs.existsSync(path.join(ctx.dataDir, 'notes.xlsx')), 'rejected upload is not left on disk');

    const noFile = await fetch(`${ctx.base}/api/admin/upload`, { method: 'POST', headers: ctx.auth(), body: new FormData() });
    assert.equal(noFile.status, 400);
});

test('upload file names cannot escape the data folder', async () => {
    const r = await uploadForm('../../escape.xlsx', workbook([{ a: 1 }]), { type: 'timetable', reingest: '0' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).file, 'escape.xlsx');
    assert.ok(fs.existsSync(path.join(ctx.dataDir, 'escape.xlsx')));
    assert.ok(!fs.existsSync(path.join(ctx.dir, 'escape.xlsx')));
});

test('delete cannot reach files outside the data folder', async () => {
    const secret = path.join(ctx.dir, 'secret.env');
    fs.writeFileSync(secret, 'KEY=1');
    for (const name of ['../secret.env', '..%2Fsecret.env', '%2E%2E%2Fsecret.env', '.env']) {
        const r = await fetch(`${ctx.base}/api/admin/source/${name}?deleteFile=1`, { method: 'DELETE', headers: ctx.auth() });
        assert.ok([400, 404].includes(r.status), `${name} -> ${r.status}`);
    }
    assert.ok(fs.existsSync(secret), 'file outside data/ is untouched');
});

test('reingest validates the file name and reports a missing file', async () => {
    const traversal = await ctx.post('/api/admin/reingest', { file: '../server/.env' }, ctx.auth());
    assert.equal(traversal.status, 400);
    const missing = await ctx.post('/api/admin/reingest', { file: 'gone.xlsx' }, ctx.auth());
    assert.equal(missing.status, 404);
});

test('delete removes rows, and the file only when asked', async () => {
    const file = path.join(ctx.dataDir, 'maths_timetable.xlsx');
    assert.ok(fs.existsSync(file));

    const dbOnly = await fetch(`${ctx.base}/api/admin/source/maths_timetable.xlsx`, { method: 'DELETE', headers: ctx.auth() });
    assert.deepEqual(await dbOnly.json(), { ok: true, removed_rows: 2, file: 'maths_timetable.xlsx', file_deleted: false });
    assert.ok(fs.existsSync(file));

    const again = await fetch(`${ctx.base}/api/admin/source/maths_timetable.xlsx?deleteFile=1`, { method: 'DELETE', headers: ctx.auth() });
    assert.equal((await again.json()).file_deleted, true);
    assert.ok(!fs.existsSync(file));

    const gone = await fetch(`${ctx.base}/api/admin/source/maths_timetable.xlsx`, { method: 'DELETE', headers: ctx.auth() });
    assert.equal(gone.status, 404);
});
