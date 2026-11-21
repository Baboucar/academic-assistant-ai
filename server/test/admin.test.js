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

// ---- uploads must not damage what is already loaded ----

const classRow = (i, extra = {}) => ({
    'Course Code': `MTH ${200 + i}`, 'Course Title': `Topic ${i}`, Day: 'Wed', Start: '08:30', End: '10:30', Room: 'Hall C', Instructor: 'Dr. Musa Bah', ...extra,
});
const loaded = (file) => ctx.db.prepare(`SELECT COUNT(*) AS n FROM timetable WHERE source_file = ?`).get(file).n;

test('a new version that reads (almost) nothing is refused, and the old file and rows are kept', async () => {
    const good = workbook(Array.from({ length: 12 }, (_, i) => classRow(i)));
    const first = await (await uploadForm('guard.xlsx', good, { type: 'timetable', dept: 'MTH', reingest: '1' })).json();
    assert.equal(first.rows, 12);

    // same file name, but the columns were renamed, so nothing can be read from it
    const broken = workbook(Array.from({ length: 12 }, (_, i) => ({ Kode: `MTH ${200 + i}`, Dag: 'Wed', Van: '08:30' })));
    const r = await uploadForm('guard.xlsx', broken, { type: 'timetable', dept: 'MTH', reingest: '1' });
    const body = await r.json();
    assert.equal(body.ok, false);
    assert.equal(body.kept_previous, true);
    assert.equal(body.ingest.refused, true);
    assert.match(body.ingest.log, /Refused: guard\.xlsx -> kept the 12 row\(s\) already loaded: this version of the file gives 0/);
    assert.equal(loaded('guard.xlsx'), 12, 'the rows students see are untouched');
    assert.ok(fs.readFileSync(path.join(ctx.dataDir, 'guard.xlsx')).equals(good), 'the good file is still the one on disk');
    assert.deepEqual(fs.readdirSync(ctx.dataDir).filter((f) => f.startsWith('.incoming-') || f.startsWith('.previous-')), [], 'no temporary files are left behind');

    // losing most of the rows is refused too
    const few = workbook(Array.from({ length: 3 }, (_, i) => classRow(i)));
    assert.equal((await (await uploadForm('guard.xlsx', few, { type: 'timetable', reingest: '1' })).json()).kept_previous, true);
    assert.equal(loaded('guard.xlsx'), 12);

    // ...unless the admin says to replace anyway
    const forced = await (await uploadForm('guard.xlsx', few, { type: 'timetable', dept: 'MTH', reingest: '1', force: '1' })).json();
    assert.equal(forced.ok, true);
    assert.equal(loaded('guard.xlsx'), 3);

    // re-ingesting everything never wipes a file either: here nothing changed, so it succeeds
    const again = await ctx.post('/api/admin/reingest', { file: 'guard.xlsx' }, ctx.auth());
    assert.equal(again.status, 200);
    await fetch(`${ctx.base}/api/admin/source/guard.xlsx?deleteFile=1`, { method: 'DELETE', headers: ctx.auth() });
});

test('values are stored in one form, and rows that cannot be used are reported', async () => {
    const bytes = workbook([
        classRow(1, { Day: 'Monday', Start: 0.3541666666666667, End: '2:30 PM' }), // an Excel time cell, and a 12-hour time
        classRow(2, { Day: 'thurs', Start: '8:30', End: '' }),
        classRow(3, { Day: 'Someday' }),
        classRow(4, { Start: 'early' }),
    ]);
    const body = await (await uploadForm('forms.xlsx', bytes, { type: 'timetable', reingest: '1' })).json();
    assert.equal(body.ingest.ok, true);
    assert.match(body.ingest.log, /forms\.xlsx -> \+2/);
    assert.match(body.ingest.log, /note: Row 3 was left out: "Someday" is not a day of the week\./);
    assert.match(body.ingest.log, /note: Row 4 was left out: start time "early" could not be read\./);
    assert.deepEqual(
        ctx.db.prepare(`SELECT day, start_time, end_time FROM timetable WHERE source_file = 'forms.xlsx' ORDER BY id`).all(),
        [{ day: 'Mon', start_time: '08:30', end_time: '14:30' }, { day: 'Thu', start_time: '08:30', end_time: '' }],
    );
    await fetch(`${ctx.base}/api/admin/source/forms.xlsx?deleteFile=1`, { method: 'DELETE', headers: ctx.auth() });
});

test('the choices made at upload are kept beside the files, so data/ alone rebuilds the database', async () => {
    const bytes = workbook([classRow(1)]);
    await uploadForm('econ timetable.xlsx', bytes, { type: 'timetable', dept: 'ECON', semester: '2026 S2', reingest: '1' });

    const manifest = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, '.sources.json'), 'utf8'));
    assert.deepEqual(manifest['econ_timetable.xlsx'], { type: 'timetable', semester: '2026 S2', dept: 'ECON' });

    // lose the database record, as if the database had been deleted, then rebuild from the folder
    ctx.db.prepare(`DELETE FROM timetable WHERE source_file = 'econ_timetable.xlsx'`).run();
    ctx.db.prepare(`DELETE FROM sources WHERE source_file = 'econ_timetable.xlsx'`).run();
    const rebuilt = await ctx.post('/api/admin/reingest', { file: 'econ_timetable.xlsx' }, ctx.auth());
    assert.equal(rebuilt.status, 200);
    assert.deepEqual(
        ctx.db.prepare(`SELECT dept, semester FROM timetable WHERE source_file = 'econ_timetable.xlsx'`).get(),
        { dept: 'ECON', semester: '2026 S2' },
        'not guessed from the file name ("econ" used to become CS) and not the default semester',
    );
    await fetch(`${ctx.base}/api/admin/source/econ_timetable.xlsx?deleteFile=1`, { method: 'DELETE', headers: ctx.auth() });
    const after = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, '.sources.json'), 'utf8'));
    assert.equal(after['econ_timetable.xlsx'], undefined);
});

test('re-uploading a file as a different type cannot silently wipe what was loaded from it', async () => {
    const exams = workbook([
        { 'Exam Date': '12/01/2099', Time: '09:00-12:00', 'Course Code': 'MTH 301', 'Course Title': 'Statistics', Hall: 'Hall 1' },
        { 'Exam Date': '13/01/2099', Time: '09:00-12:00', 'Course Code': 'MTH 302', 'Course Title': 'Analysis', Hall: 'Hall 1' },
    ]);
    assert.equal((await (await uploadForm('finals.xlsx', exams, { type: 'exams', reingest: '1' })).json()).rows, 2);

    // the same file again, but the type box was left on "Class timetable": nothing in it reads as classes
    const again = await (await uploadForm('finals.xlsx', exams, { type: 'timetable', reingest: '1' })).json();
    assert.equal(again.kept_previous, true);
    assert.equal(ctx.db.prepare(`SELECT COUNT(*) AS n FROM exams WHERE source_file = 'finals.xlsx'`).get().n, 2);
    assert.equal(ctx.db.prepare(`SELECT type FROM sources WHERE source_file = 'finals.xlsx'`).get().type, 'exams', 'and it is still listed as an exam timetable');
    await fetch(`${ctx.base}/api/admin/source/finals.xlsx?deleteFile=1`, { method: 'DELETE', headers: ctx.auth() });
});

test('leaving the semester box blank keeps the file\'s label instead of inventing one', async () => {
    const bytes = workbook([classRow(1)]);
    await uploadForm('term.xlsx', bytes, { type: 'timetable', semester: '2026-2027 S2', reingest: '1' });
    await uploadForm('term.xlsx', bytes, { type: 'timetable', semester: '', reingest: '1' });
    assert.equal(ctx.db.prepare(`SELECT semester FROM timetable WHERE source_file = 'term.xlsx'`).get().semester, '2026-2027 S2');

    // a brand-new file with no label joins the latest term in use, and a label that
    // differs only in capitals is the same semester
    await uploadForm('unlabelled.xlsx', bytes, { type: 'timetable', reingest: '1' });
    await uploadForm('shouted.xlsx', bytes, { type: 'timetable', semester: '2026-2027 s2', reingest: '1' });
    const labels = ctx.db.prepare(`SELECT source_file, semester FROM sources WHERE source_file IN ('unlabelled.xlsx', 'shouted.xlsx') ORDER BY source_file`).all();
    assert.notEqual(labels.find((l) => l.source_file === 'unlabelled.xlsx').semester, '2025-2026 S1', 'not the old hard-coded default');
    assert.equal(labels.find((l) => l.source_file === 'shouted.xlsx').semester, '2026-2027 S2');
    for (const f of ['term.xlsx', 'unlabelled.xlsx', 'shouted.xlsx']) {
        await fetch(`${ctx.base}/api/admin/source/${f}?deleteFile=1`, { method: 'DELETE', headers: ctx.auth() });
    }
});

test('dates are read the same whether the year comes first or last', async () => {
    const { toIsoDate } = await import('../../ingest/parsers/excel.js');
    assert.deepEqual(
        ['2026/12/01', '2026.12.14', '2026-12-01', '01/12/2026', '1.12.26', '12/1/126', '2026/13/01'].map(toIsoDate),
        ['2026-12-01', '2026-12-14', '2026-12-01', '2026-12-01', '2026-12-01', null, null],
    );
});

test('a class that ends before it starts is put right when it is plainly an afternoon time, and left out otherwise', async () => {
    const { checkRows, looksLikeDataLoss } = await import('../../ingest/check.js');
    const base = ['CS', 'CPS 1', 'T', 'Mon'];
    const { rows, rejected } = checkRows('timetable', [
        [...base, '11:00', '1:00', 'Hall', 'X'],
        [...base, '14:00', '9:00', 'Hall', 'X'],
    ]);
    assert.deepEqual(rows.map((r) => [r[4], r[5]]), [['11:00', '13:00']]);
    assert.match(rejected[0].reason, /ends \(09:00\) before it starts \(14:00\)/);

    // "fewer than half" applies from four rows up; nothing read is always a loss
    assert.deepEqual([[9, 1], [8, 3], [4, 1], [3, 1], [2, 0], [0, 0], [10, 5]].map(([b, a]) => looksLikeDataLoss(b, a)), [true, true, true, false, true, false, false]);
});

test('a department is only guessed from a file name that plainly gives one', async () => {
    const guess = async (name) => {
        const bytes = workbook([classRow(1)]);
        const body = await (await uploadForm(name, bytes, { type: 'timetable', reingest: '1' })).json();
        const dept = ctx.db.prepare(`SELECT dept FROM timetable WHERE source_file = ?`).get(body.file).dept;
        await fetch(`${ctx.base}/api/admin/source/${encodeURIComponent(body.file)}?deleteFile=1`, { method: 'DELETE', headers: ctx.auth() });
        return dept;
    };
    assert.equal(await guess('cs-timetable.xlsx'), 'CS');
    assert.equal(await guess('SITC Draft EXAMS.xlsx'), 'SITC');
    for (const name of ['Latest timetable.xlsx', 'June exams timetable.xlsx', 'Year 1 timetable.xlsx', 'Main campus timetable.xlsx', 'Monday classes.xlsx', 'Book1.xlsx', 'economics-timetable.xlsx']) {
        assert.equal(await guess(name), 'UNKNOWN', name);
    }
});

test('two uploads of the same file at once do not trample each other', async () => {
    const good = workbook(Array.from({ length: 6 }, (_, i) => classRow(i)));
    const [a, b] = await Promise.all([
        uploadForm('race.xlsx', good, { type: 'timetable', reingest: '1' }),
        uploadForm('race.xlsx', good, { type: 'timetable', reingest: '1' }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(loaded('race.xlsx'), 6);
    assert.ok(fs.readFileSync(path.join(ctx.dataDir, 'race.xlsx')).equals(good));
    assert.deepEqual(fs.readdirSync(ctx.dataDir).filter((f) => f.startsWith('.incoming-') || f.startsWith('.previous-')), []);
    await fetch(`${ctx.base}/api/admin/source/race.xlsx?deleteFile=1`, { method: 'DELETE', headers: ctx.auth() });
});

test('the saved choices survive losing the database, even when another file is changed first', async () => {
    const bytes = workbook([classRow(1)]);
    await uploadForm('keep.xlsx', bytes, { type: 'timetable', dept: 'ECON', semester: '2026 S2', reingest: '1' });
    // the timetable database forgets the file, as it would if it were deleted and recreated
    ctx.db.prepare(`DELETE FROM timetable WHERE source_file = 'keep.xlsx'`).run();
    ctx.db.prepare(`DELETE FROM sources WHERE source_file = 'keep.xlsx'`).run();
    // an admin does something else before re-ingesting it
    await uploadForm('other.xlsx', bytes, { type: 'timetable', reingest: '1' });

    const manifest = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, '.sources.json'), 'utf8'));
    assert.deepEqual(manifest['keep.xlsx'], { type: 'timetable', semester: '2026 S2', dept: 'ECON' });
    for (const f of ['keep.xlsx', 'other.xlsx']) {
        await fetch(`${ctx.base}/api/admin/source/${f}?deleteFile=1`, { method: 'DELETE', headers: ctx.auth() });
    }
    assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.dataDir, '.sources.json'), 'utf8'))['keep.xlsx'], undefined, 'gone once the file itself is deleted');
});

