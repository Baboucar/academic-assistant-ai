import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { parseExcelExams, parseExcelTimetable } from './parsers/excel.js';
import { parseCalendarPdf, parseTimetablePdf } from './parsers/pdf.js';
import { parseExamPdf } from './parsers/examPdf.js';
import { parseDocxNotice } from './parsers/docx.js';
import { migrate } from '../server/src/db/migrate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT   = path.resolve(__dirname, '..');
// DATA_DIR / DB_PATH let the server (and tests) point the ingest at other locations
const DATA   = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const DB_PATH= path.resolve(process.env.DB_PATH || path.join(ROOT, 'tmp', 'utg.db'));
const SCHEMA = path.join(ROOT, 'server', 'src', 'db', 'schema.sql');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('busy_timeout = 5000');
db.exec(fs.readFileSync(SCHEMA, 'utf8'));

// Bring a database from an older version up to date
migrate(db);

// Semester tag: SEMESTER env wins, then whatever the file was tagged with before
const DEFAULT_SEMESTER = '2025-2026 S1';
// Ingest a single file (set by the admin dashboard) instead of the whole folder
const ONLY_FILE = process.env.ONLY_FILE || '';

const getSource = db.prepare(`SELECT type, semester, dept FROM sources WHERE source_file = ?`);

// Upsert file into sources
const upsertSource = db.prepare(`
  INSERT INTO sources (source_file, type, semester)
  VALUES (@source_file, @type, @semester)
  ON CONFLICT(source_file) DO UPDATE
    SET type=excluded.type, semester=excluded.semester, ingested_at=datetime('now')
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

function deptGuessFromName(f){
    const s=f.toLowerCase();
    if(s.includes('cs'))  return 'CS';
    if(s.includes('ins')) return 'INS';
    if(s.includes('ict')) return 'ICT';
    if(s.includes('tel')) return 'TEL';
    if(s.includes('cps')) return 'CPS';
    return 'UNKNOWN';
}

/** Parse one file and replace its rows. Returns a log line. */
async function ingestFile(base) {
    const f = path.join(DATA, base);
    const known = getSource.get(base);
    const semester = process.env.SEMESTER || known?.semester || DEFAULT_SEMESTER;
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

    // Swap the file's rows in one transaction so a failure never leaves it half-loaded
    db.transaction(() => {
        upsertSource.run({ source_file: base, type, semester });
        for (const del of Object.values(delBySource)) del.run(base);
        for (const r of rows) insert.run(...r, base, semester);
    })();
    return [`${label}: ${base} -> +${rows.length}`, ...notes.map((note) => `  note: ${note}`)].join('\n');
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
            console.error(`Failed: ${base} -> ${e?.message || e}`);
        }
    }
    console.log(`Ingestion complete -> ${path.relative(ROOT, DB_PATH) || DB_PATH}`);
    if (failed) process.exit(1);
})();
