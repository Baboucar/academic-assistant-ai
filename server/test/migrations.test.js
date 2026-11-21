// Databases made by earlier versions must come up to date without losing anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ACCOUNTS_MIGRATIONS, migrate, TIMETABLE_MIGRATIONS } from '../src/db/migrations.js';

const columns = (db, table) => db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map((c) => c.name);

test('a fresh database gets every table, and remembers its version', () => {
    const db = new Database(':memory:');
    assert.equal(migrate(db, TIMETABLE_MIGRATIONS), TIMETABLE_MIGRATIONS.length);
    assert.equal(db.pragma('user_version', { simple: true }), TIMETABLE_MIGRATIONS.length);
    for (const table of ['timetable', 'exams', 'calendar', 'notices', 'sources']) assert.ok(columns(db, table).length, table);
    assert.ok(columns(db, 'exams').includes('lecturer'));
    assert.ok(columns(db, 'sources').includes('dept'));
    db.prepare(`INSERT INTO sources (source_file, type) VALUES ('e.pdf', 'exams')`).run();

    // running it again changes nothing
    assert.equal(migrate(db, TIMETABLE_MIGRATIONS), TIMETABLE_MIGRATIONS.length);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM sources`).get().n, 1);
});

test('a database from the first release is upgraded in place, keeping its rows', () => {
    const db = new Database(':memory:');
    // as created before semesters, exams, departments or versions existed
    db.exec(`
      CREATE TABLE timetable (id INTEGER PRIMARY KEY, dept TEXT, course_code TEXT, course_title TEXT, day TEXT,
                              start_time TEXT, end_time TEXT, venue TEXT, lecturer TEXT, source_file TEXT);
      CREATE TABLE calendar (id INTEGER PRIMARY KEY, date TEXT, title TEXT, description TEXT, source_file TEXT);
      CREATE TABLE notices (id INTEGER PRIMARY KEY, date TEXT, title TEXT, body TEXT, source_file TEXT);
      CREATE TABLE sources (id INTEGER PRIMARY KEY, source_file TEXT UNIQUE,
                            type TEXT CHECK (type IN ('timetable','calendar','notices')),
                            semester TEXT, ingested_at TEXT DEFAULT (datetime('now')));
      INSERT INTO timetable (dept, course_code, day, source_file) VALUES ('CS', 'CPS 416', 'Mon', 'old.pdf');
      INSERT INTO sources (source_file, type, semester, ingested_at) VALUES ('old.pdf', 'timetable', '2025 S1', '2025-01-01 10:00:00');
    `);
    assert.throws(() => db.prepare(`INSERT INTO sources (source_file, type) VALUES ('e.pdf', 'exams')`).run(), /CHECK/);

    migrate(db, TIMETABLE_MIGRATIONS);

    assert.ok(columns(db, 'timetable').includes('semester'));
    assert.deepEqual(db.prepare(`SELECT course_code, day FROM timetable`).all(), [{ course_code: 'CPS 416', day: 'Mon' }]);
    assert.deepEqual(
        db.prepare(`SELECT source_file, type, semester, ingested_at, dept FROM sources`).all(),
        [{ source_file: 'old.pdf', type: 'timetable', semester: '2025 S1', ingested_at: '2025-01-01 10:00:00', dept: null }],
    );
    db.prepare(`INSERT INTO sources (source_file, type, dept) VALUES ('e.pdf', 'exams', 'SITC')`).run();
    db.prepare(`INSERT INTO exams (course_code, date, lecturer) VALUES ('CPS 313', '2026-12-12', 'x')`).run();
});

test('the accounts database has accounts, settings, logs and seeded aliases', () => {
    const db = new Database(':memory:');
    migrate(db, ACCOUNTS_MIGRATIONS);
    for (const table of ['users', 'email_codes', 'sessions', 'settings', 'aliases', 'admin_log', 'question_log', 'mail_counters']) {
        assert.ok(columns(db, table).length, table);
    }
    assert.equal(db.prepare(`SELECT title FROM aliases WHERE alias = 'ai'`).get().title, 'Artificial Intelligence', 'aliases match in any case');
    assert.ok(!columns(db, 'question_log').some((c) => /user|email|mat/.test(c)));
});

test('a step that fails leaves the database at the last good version', () => {
    const db = new Database(':memory:');
    const steps = [
        (d) => d.exec(`CREATE TABLE a (id INTEGER)`),
        (d) => { d.exec(`CREATE TABLE b (id INTEGER)`); throw new Error('boom'); },
    ];
    assert.throws(() => migrate(db, steps), /boom/);
    assert.equal(db.pragma('user_version', { simple: true }), 1);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'b'`).get().n, 0, 'the half-applied step was rolled back');
});
