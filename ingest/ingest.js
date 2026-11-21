import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { parseExcelExams, parseExcelTimetable } from './parsers/excel.js';
import { parseCalendarPdf, parseTimetablePdf } from './parsers/pdf.js';
import { parseExamPdf } from './parsers/examPdf.js';
import { parseDocxNotice } from './parsers/docx.js';
import { migrate, TIMETABLE_MIGRATIONS } from '../server/src/db/migrations.js';
import { checkRows, looksLikeDataLoss } from './check.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT   = path.resolve(__dirname, '..');
// DATA_DIR / DB_PATH let the server (and tests) point the ingest at other locations
const DATA   = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const DB_PATH= path.resolve(process.env.DB_PATH || path.join(ROOT, 'tmp', 'utg.db'));

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('busy_timeout = 5000');
db.pragma('journal_mode = WAL');
// One definition of the tables, shared with the server
migrate(db, TIMETABLE_MIGRATIONS);

// Semester tag: SEMESTER env wins, then whatever the file was tagged with before
const DEFAULT_SEMESTER = '2025-2026 S1';
// Ingest a single file (set by the admin dashboard) instead of the whole folder
const ONLY_FILE = process.env.ONLY_FILE || '';
// Replace a file's rows even if the new version reads far fewer than are loaded
const FORCE = ['1', 'true'].includes(String(process.env.FORCE || '').toLowerCase());

// What the admin chose for each file at upload (type, semester, department). The
// server writes it next to the files, so data/ alone can rebuild the database.
function readManifest() {
    try {
        return JSON.parse(fs.readFileSync(path.join(DATA, '.sources.json'), 'utf8')) || {};
    } catch {
        return {};
    }
}
const manifest = readManifest();

/** The latest semester label already loaded, so an unlabelled file joins the current term. */
function latestSemester() {
    const labels = db
        .prepare(`SELECT DISTINCT semester FROM sources WHERE semester IS NOT NULL AND TRIM(semester) <> ''`)
        .all()
        .map((r) => r.semester)
        .sort((x, y) => y.localeCompare(x, 'en', { numeric: true, sensitivity: 'base' }));
    return labels[0] || null;
}

/** A file's new rows would wipe out most of what is loaded from it. */
class Refused extends Error {}

const getSource = db.prepare(`SELECT type, semester, dept FROM sources WHERE source_file = ?`);

// Upsert file into sources
const upsertSource = db.prepare(`
  INSERT INTO sources (source_file, type, semester, dept)
  VALUES (@source_file, @type, @semester, @dept)
  ON CONFLICT(source_file) DO UPDATE
    SET type=excluded.type, semester=excluded.semester, ingested_at=datetime('now'),
        dept=COALESCE(excluded.dept, sources.dept)
`);

// Clean per file
const delBySource = {
    timetable: db.prepare(`DELETE FROM timetable WHERE source_file = ?`),
    exams:     db.prepare(`DELETE FROM exams     WHERE source_file = ?`),
    calendar:  db.prepare(`DELETE FROM calendar  WHERE source_file = ?`),
    notices:   db.prepare(`DELETE FROM notices   WHERE source_file = ?`)
};

// Inserts with semester
const insTT = db.prepare(`
  INSERT INTO timetable (dept,course_code,course_title,day,start_time,end_time,venue,lecturer,source_file,semester)
  VALUES (?,?,?,?,?,?,?,?,?,?)
`);
const insExam = db.prepare(`
  INSERT INTO exams (dept,course_code,course_title,date,start_time,end_time,venue,lecturer,source_file,semester)
  VALUES (?,?,?,?,?,?,?,?,?,?)
`);
const insCal = db.prepare(`
  INSERT INTO calendar (date,title,description,source_file,semester)
  VALUES (?,?,?,?,?)
`);
const insN = db.prepare(`
  INSERT INTO notices (date,title,body,source_file,semester)
  VALUES (?,?,?, ?,?)
`);

// Words that start a file name without being a department: "Latest timetable.xlsx", "June exams.pdf"
const NOT_A_DEPT = new Set(
    (
        'draft final new old copy latest updated revised current master main full resit exam exams timetable time table ' +
        'schedule calendar notice notices sem semester first second third utg the and for class classes year level week ' +
        'book sheet school dept campus all general monday tuesday wednesday thursday friday saturday sunday ' +
        'jan feb mar apr may jun jul aug sep sept oct nov dec june july pdf xlsx xls docx'
    ).split(' '),
);

/**
 * A department label for a file nobody labelled. Only a name that plainly
 * starts with one counts: a short word in capitals ("SITC Draft EXAMS.pdf"),
 * or a short word right before "timetable" ("cs-timetable.pdf"). Anything
 * else is UNKNOWN: choosing the department at upload is the reliable way, and
 * a wrong guess would become a department students' questions get matched to.
 */
function deptGuessFromName(f) {
    const tokens = f.replace(/\.[^.]+$/, '').split(/[^A-Za-z]+/).filter(Boolean);
    const [first, next] = tokens;
    if (!first || NOT_A_DEPT.has(first.toLowerCase())) return 'UNKNOWN';
    const inCapitals = /^[A-Z]{2,6}$/.test(first);
    const beforeTimetable = /^[A-Za-z]{2,4}$/.test(first) && /^(timetable|timetables|exam|exams|classes|schedule)$/i.test(next || '');
    return inCapitals || beforeTimetable ? first.toUpperCase() : 'UNKNOWN';
}

/** Parse one file and replace its rows. Returns a log line. */
async function ingestFile(base) {
    const f = path.join(DATA, base);
    const known = getSource.get(base) || manifest[base];
    // The label given now, else the one this file already has, else the latest label in use
    const semester = process.env.SEMESTER || known?.semester || latestSemester() || DEFAULT_SEMESTER;
    // The department chosen at upload wins; otherwise guess from the file name
    const dept = known?.dept || deptGuessFromName(base);

    let type, rows, insert, label;
    let notes = []; // things the reader corrected or could not make sense of
    if (/\.(xlsx|xls)$/i.test(base)) {
        // The type chosen at upload wins; otherwise guess from the file name
        const isExams = known?.type ? known.type === 'exams' : /exam/i.test(base);
        if (isExams) {
            type = 'exams'; insert = insExam; label = 'Exam timetable';
            rows = parseExcelExams(f, dept);
        } else {
            type = 'timetable'; insert = insTT; label = 'Excel';
            rows = parseExcelTimetable(f, dept);
        }
    } else if (/\.pdf$/i.test(base)) {
        // The type chosen at upload wins; otherwise guess from the file name
        const kind = known?.type || (/calendar/i.test(base) ? 'calendar' : /exam/i.test(base) ? 'exams' : 'timetable');
        if (kind === 'exams') {
            type = 'exams'; insert = insExam; label = 'Exam timetable PDF';
            rows = await parseExamPdf(f, dept);
            notes = rows.warnings || [];
        } else if (kind === 'calendar') {
            type = 'calendar'; insert = insCal; label = 'Calendar PDF';
            rows = await parseCalendarPdf(f);
        } else {
            type = 'timetable'; insert = insTT; label = 'Timetable PDF';
            rows = await parseTimetablePdf(f, dept);
        }
    } else if (/\.docx$/i.test(base)) {
        type = 'notices'; insert = insN; label = 'Notice DOCX';
        rows = await parseDocxNotice(f);
    } else {
        return `Skipping ${base}`;
    }

    // Put every value into one form, and leave out rows that cannot be used
    const checked = checkRows(type, rows);
    for (const { index, reason } of checked.rejected.slice(0, 5)) notes.push(`Row ${index + 1} was left out: ${reason}.`);
    if (checked.rejected.length > 5) notes.push(`${checked.rejected.length - 5} more row(s) were left out for similar reasons.`);

    // Never let a file that suddenly reads (almost) nothing wipe out what is loaded
    // counted across every table: a file loaded as an exam timetable and re-uploaded as a
    // class timetable would otherwise look like "0 rows before" and wipe the exams
    const before = ['timetable', 'exams', 'calendar', 'notices'].reduce(
        (sum, table) => sum + db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE source_file = ?`).get(base).n,
        0,
    );
    if (!FORCE && looksLikeDataLoss(before, checked.rows.length)) {
        throw new Refused(
            `kept the ${before} row(s) already loaded: this version of the file gives ${checked.rows.length}. ` +
                'Check the file (renamed columns? wrong type?), or replace anyway.',
        );
    }

    // Swap the file's rows in one transaction so a failure never leaves it half-loaded
    db.transaction(() => {
        upsertSource.run({ source_file: base, type, semester, dept: known?.dept ?? null });
        for (const del of Object.values(delBySource)) del.run(base);
        for (const r of checked.rows) insert.run(...r, base, semester);
    })();
    return [`${label}: ${base} -> +${checked.rows.length}`, ...notes.map((note) => `  note: ${note}`)].join('\n');
}

(async ()=>{
    let files = fs.existsSync(DATA) ? fs.readdirSync(DATA).filter((n) => !n.startsWith('.')) : [];
    if (ONLY_FILE) {
        files = files.filter((n) => n === ONLY_FILE);
        if (!files.length) {
            console.error(`File not found in data/: ${ONLY_FILE}`);
            process.exit(1);
        }
    }

    let failed = 0;
    for (const base of files) {
        try {
            console.log(await ingestFile(base));
        } catch (e) {
            failed++;
            console.error(`${e instanceof Refused ? 'Refused' : 'Failed'}: ${base} -> ${e?.message || e}`);
        }
    }
    console.log(`Ingestion complete -> ${path.relative(ROOT, DB_PATH) || DB_PATH}`);
    if (failed) process.exit(1);
})();
