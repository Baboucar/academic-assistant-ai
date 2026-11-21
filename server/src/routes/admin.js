import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { spawn } from 'node:child_process';
import { db } from '../db/connect.js';
import { Queries } from '../db/queries.js';
import { env } from '../env.js';
import { HttpError, wrap } from '../errors.js';

export const admin = Router();

const DATA = env.DATA_DIR;
fs.mkdirSync(DATA, { recursive: true });

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const TYPES = ['timetable', 'exams', 'calendar', 'notices'];
// Which source types each file extension can be parsed as (see ingest/ingest.js)
const TYPES_BY_EXT = {
    '.pdf': ['timetable', 'exams', 'calendar'],
    '.xlsx': ['timetable', 'exams'],
    '.xls': ['timetable', 'exams'],
    '.docx': ['notices'],
};

function safeName(original) {
    const base = path.basename(String(original || '')).replace(/[^\w.\-+]/g, '_');
    // no hidden files, no names made only of dots
    return base.replace(/^\.+/, '');
}

/**
 * Resolve a client-supplied file name to a path inside data/.
 * Rejects anything with a directory part, so "../server/.env" cannot be reached.
 */
function resolveDataFile(name) {
    const file = String(name || '');
    if (!file || file !== path.basename(file) || file.startsWith('.')) {
        throw new HttpError(400, 'Invalid file name');
    }
    const full = path.resolve(DATA, file);
    if (path.dirname(full) !== DATA) throw new HttpError(400, 'Invalid file name');
    return { file, full };
}

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, DATA),
        filename: (req, file, cb) => cb(null, safeName(file.originalname)),
    }),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    fileFilter: (req, file, cb) => {
        const name = safeName(file.originalname);
        const ext = path.extname(name).toLowerCase();
        if (!name || !TYPES_BY_EXT[ext]) {
            return cb(new HttpError(400, 'Only PDF, Excel (.xlsx/.xls) and Word (.docx) files are supported'));
        }
        cb(null, true);
    },
});

/** Run the ingest script and resolve with its exit code and output. */
function runIngest({ file = '', semester = '' } = {}) {
    return new Promise((resolve) => {
        const childEnv = {
            ...process.env,
            DATA_DIR: DATA,
            DB_PATH: env.DB_PATH,
            ONLY_FILE: file || '',
        };
        if (semester) childEnv.SEMESTER = semester;
        else delete childEnv.SEMESTER;

        const child = spawn(process.execPath, [path.join(env.ROOT, 'ingest', 'ingest.js')], {
            cwd: env.ROOT,
            env: childEnv,
        });

        let log = '';
        const collect = (buf) => { log = (log + buf.toString()).slice(-8000); };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);

        const timer = setTimeout(() => child.kill(), 5 * 60 * 1000);
        child.on('error', (err) => {
            clearTimeout(timer);
            resolve({ ok: false, code: -1, log: String(err?.message || err) });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ ok: code === 0, code, log: log.trim() });
        });
    });
}

admin.get('/sources', (req, res) => {
    res.json({ sources: Queries.listSources(), counts: Queries.counts() });
});

admin.post(
    '/upload',
    upload.single('file'),
    wrap(async (req, res) => {
        const base = req.file?.filename;
        if (!base) throw new HttpError(400, 'file is required');

        const { type = 'timetable', semester = '', reingest = '1', dept = '' } = req.body || {};
        const allowed = TYPES_BY_EXT[path.extname(base).toLowerCase()] || [];
        if (!TYPES.includes(type) || !allowed.includes(type)) {
            // the file is already on disk at this point: do not leave it behind
            fs.rmSync(path.join(DATA, base), { force: true });
            throw new HttpError(
                400,
                TYPES.includes(type)
                    ? `A ${path.extname(base)} file cannot be ingested as "${type}" (allowed: ${allowed.join(', ')})`
                    : 'Unknown source type',
            );
        }

        // Which department or school the file belongs to, e.g. "CS" or "LAW" (optional)
        const department = String(dept || '').trim().toUpperCase();
        if (department && !/^[A-Z0-9][A-Z0-9 &-]{0,19}$/.test(department)) {
            fs.rmSync(path.join(DATA, base), { force: true });
            throw new HttpError(400, 'Department should be a short code such as CS or LAW (letters and numbers, up to 20 characters)');
        }

        const sem = String(semester || '').trim().slice(0, 60);
        db.prepare(`
      INSERT INTO sources (source_file, type, semester, dept)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(source_file) DO UPDATE
        SET type=excluded.type, semester=excluded.semester, dept=excluded.dept, ingested_at=datetime('now')
    `).run(base, type, sem || null, department || null);

        let ingest = null;
        if (String(reingest) === '1') {
            ingest = await runIngest({ file: base, semester: sem });
        }

        res.json({ ok: ingest ? ingest.ok : true, file: base, type, semester: sem || null, dept: department || null, ingest });
    }),
);

admin.delete(
    '/source/:file',
    wrap(async (req, res) => {
        const { file, full } = resolveDataFile(req.params.file);

        const remove = db.transaction(() => {
            let rows = 0;
            for (const table of ['timetable', 'exams', 'calendar', 'notices']) {
                rows += db.prepare(`DELETE FROM ${table} WHERE source_file=?`).run(file).changes;
            }
            const known = db.prepare(`DELETE FROM sources WHERE source_file=?`).run(file).changes;
            return { rows, known };
        });
        const { rows, known } = remove();

        let fileDeleted = false;
        if (req.query.deleteFile === '1' && fs.existsSync(full)) {
            fs.rmSync(full, { force: true });
            fileDeleted = true;
        }

        if (!known && !rows && !fileDeleted) throw new HttpError(404, 'Source not found');
        res.json({ ok: true, removed_rows: rows, file, file_deleted: fileDeleted });
    }),
);

admin.post(
    '/reingest',
    wrap(async (req, res) => {
        const { file = '', semester = '' } = req.body || {};
        let only = '';
        if (file) {
            const resolved = resolveDataFile(file);
            if (!fs.existsSync(resolved.full)) {
                throw new HttpError(404, 'That file is no longer in the data folder. Upload it again.');
            }
            only = resolved.file;
        }

        const result = await runIngest({ file: only, semester: String(semester || '').trim().slice(0, 60) });
        res.status(result.ok ? 200 : 500).json({
            ok: result.ok,
            file: only || null,
            log: result.log,
            ...(result.ok ? {} : { error: 'Ingest failed. See the log for details.' }),
        });
    }),
);
