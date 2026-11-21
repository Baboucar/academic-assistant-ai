// Admin routes, mounted at /api/admin behind adminAuth (req.admin is the signed-in admin).
import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { db } from '../db/connect.js';
import { recentAdminActions, recordAdminAction, Settings } from '../db/accounts.js';
import { Aliases } from '../db/aliases.js';
import { activeSemester, Queries } from '../db/queries.js';
import { answerCache } from '../chat/cache.js';
import { questionStats } from '../chat/log.js';
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
// The ingest script skips names that start with a dot, so these are safe to keep in data/
const MANIFEST = path.join(DATA, '.sources.json');
const INCOMING = '.incoming-';
const PREVIOUS = '.previous-';

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

/**
 * Write what the admin chose for each file (type, semester, department) next to
 * the files, so data/ on its own is enough to rebuild the timetable database.
 */
function writeManifest() {
    try {
        // Start from what is already saved for files still in the folder: if the
        // timetable database was lost, it no longer knows them, and their choices
        // must survive until they are re-ingested.
        let saved = {};
        try { saved = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) || {}; } catch { /* none yet */ }
        const kept = Object.fromEntries(Object.entries(saved).filter(([file]) => fs.existsSync(path.join(DATA, file))));
        const rows = db.prepare(`SELECT source_file, type, semester, dept FROM sources ORDER BY source_file`).all();
        const manifest = { ...kept, ...Object.fromEntries(rows.map(({ source_file, ...rest }) => [source_file, rest])) };
        fs.writeFileSync(`${MANIFEST}.tmp`, JSON.stringify(manifest, null, 2));
        fs.renameSync(`${MANIFEST}.tmp`, MANIFEST);
    } catch (e) {
        console.error('Could not write data/.sources.json:', e?.message || e);
    }
}

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, DATA),
        // Held under a temporary name until it has been checked and read, so a bad
        // upload never replaces the good file it was meant to update.
        filename: (req, file, cb) => cb(null, `${INCOMING}${crypto.randomBytes(6).toString('hex')}-${safeName(file.originalname)}`),
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

/**
 * Run the ingest script and resolve with its exit code and output.
 * `force` replaces a file's rows even when the new version reads far fewer.
 */
function runIngest({ file = '', semester = '', force = false } = {}) {
    return new Promise((resolve) => {
        const childEnv = {
            ...process.env,
            DATA_DIR: DATA,
            DB_PATH: env.DB_PATH,
            ONLY_FILE: file || '',
            FORCE: force ? '1' : '',
        };
        if (semester) childEnv.SEMESTER = semester;
        else delete childEnv.SEMESTER;
        // the reader does not need the server's secrets
        for (const secret of ['GROQ_API_KEY', 'ADMIN_PASS', 'ADMIN_USERS', 'SMTP_PASS']) delete childEnv[secret];

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
            const text = log.trim();
            resolve({ ok: code === 0, code, log: text, refused: /^Refused:/m.test(text) });
        });
    });
}

/** The line of the ingest log that says why it was refused or failed, for showing to the admin. */
function reasonFrom(result) {
    const line = (result.log || '').split('\n').find((l) => /^(Refused|Failed):/.test(l));
    if (!line) return result.refused ? 'Kept the rows already loaded.' : 'The file could not be read.';
    return line.replace(/^Refused:\s*/, 'Not replaced: ').replace(/^Failed:\s*/, 'Could not read ').replace(' -> ', ': ');
}

// One change to a file at a time: two uploads of the same name at once would
// each move the other's files around.
const busyFiles = new Set();
async function exclusively(file, work) {
    if (busyFiles.has(file)) throw new HttpError(409, `${file} is being uploaded or re-ingested right now. Try again when it has finished.`);
    busyFiles.add(file);
    try {
        return await work();
    } finally {
        busyFiles.delete(file);
    }
}

const rowsLoaded = (file) =>
    ['timetable', 'exams', 'calendar', 'notices'].reduce(
        (sum, table) => sum + db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE source_file = ?`).get(file).n,
        0,
    );

admin.get('/sources', (req, res) => {
    res.json({ sources: Queries.listSources(), counts: Queries.counts() });
});

admin.post(
    '/upload',
    upload.single('file'),
    wrap(async (req, res) => {
        const incoming = req.file?.path;
        if (!incoming) throw new HttpError(400, 'file is required');
        const base = safeName(req.file.originalname);
        const target = path.join(DATA, base);
        const reject = (status, message) => {
            fs.rmSync(incoming, { force: true });
            throw new HttpError(status, message);
        };

        const { type = 'timetable', semester = '', reingest = '1', dept = '', force = '' } = req.body || {};
        const allowed = TYPES_BY_EXT[path.extname(base).toLowerCase()] || [];
        if (!TYPES.includes(type)) reject(400, 'Unknown source type');
        if (!allowed.includes(type)) {
            reject(400, `A ${path.extname(base)} file cannot be ingested as "${type}" (allowed: ${allowed.join(', ')})`);
        }
        // Which department or school the file belongs to, e.g. "CS" or "LAW" (optional)
        const department = String(dept || '').trim().toUpperCase();
        if (department && !/^[A-Z0-9][A-Z0-9 &-]{0,19}$/.test(department)) {
            reject(400, 'Department should be a short code such as CS or LAW (letters and numbers, up to 20 characters)');
        }
        if (busyFiles.has(base)) reject(409, `${base} is being uploaded or re-ingested right now. Try again when it has finished.`);
        busyFiles.add(base);
        try {
        // A label that differs from an existing one only in capitals or spacing is the same semester
        let sem = String(semester || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        const sameLabel = sem && Queries.semesters().find((s) => s.semester.toLowerCase() === sem.toLowerCase());
        if (sameLabel) sem = sameLabel.semester;

        // Keep the version being replaced until the new one has been read
        const previous = path.join(DATA, `${PREVIOUS}${base}`);
        const hadPrevious = fs.existsSync(target);
        const before = db.prepare(`SELECT type, semester, dept, ingested_at FROM sources WHERE source_file = ?`).get(base);
        if (hadPrevious) fs.renameSync(target, previous);
        fs.renameSync(incoming, target);

        db.prepare(`
      INSERT INTO sources (source_file, type, semester, dept)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(source_file) DO UPDATE
        SET type=excluded.type, dept=excluded.dept, ingested_at=datetime('now'),
            -- a blank semester box keeps the label the file already has
            semester=COALESCE(excluded.semester, sources.semester)
    `).run(base, type, sem || null, department || null);

        let ingest = null;
        let kept = false;
        if (String(reingest) === '1') {
            ingest = await runIngest({ file: base, semester: sem, force: String(force) === '1' });
            if (!ingest.ok && hadPrevious) {
                // the new file could not be read (or would have dropped most rows): put the old one back
                fs.renameSync(previous, target);
                if (before) {
                    db.prepare(`UPDATE sources SET type = ?, semester = ?, dept = ?, ingested_at = ? WHERE source_file = ?`)
                        .run(before.type, before.semester, before.dept, before.ingested_at, base);
                }
                kept = true;
            }
        }
        fs.rmSync(previous, { force: true });
        writeManifest();
        answerCache.clear();

        const rows = rowsLoaded(base);
        recordAdminAction(
            req.admin,
            'upload',
            base,
            kept ? 'new version rejected, previous version kept' : `${type}${department ? `, ${department}` : ''}${sem ? `, ${sem}` : ''}: ${rows} rows`,
        );
        res.json({
            ok: ingest ? ingest.ok : true,
            file: base,
            type,
            semester: sem || null,
            dept: department || null,
            rows,
            // true when the upload was not used and the file already in place was kept
            kept_previous: kept,
            ingest,
        });
        } finally {
            busyFiles.delete(base);
        }
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
        writeManifest();
        answerCache.clear();
        recordAdminAction(req.admin, 'delete', file, `${rows} rows removed${fileDeleted ? ', file deleted' : ', file kept'}`);
        res.json({ ok: true, removed_rows: rows, file, file_deleted: fileDeleted });
    }),
);

admin.post(
    '/reingest',
    wrap(async (req, res) => {
        const { file = '', semester = '', force = false } = req.body || {};
        let only = '';
        if (file) {
            const resolved = resolveDataFile(file);
            if (!fs.existsSync(resolved.full)) {
                throw new HttpError(404, 'That file is no longer in the data folder. Upload it again.');
            }
            only = resolved.file;
        }

        const run = () => runIngest({ file: only, semester: String(semester || '').trim().slice(0, 60), force: force === true || force === '1' });
        const result = only ? await exclusively(only, run) : await run();
        writeManifest();
        answerCache.clear();
        recordAdminAction(req.admin, 'reingest', only || 'all files', result.ok ? 'ok' : result.refused ? 'refused: would have dropped rows' : 'failed');
        res.status(result.ok ? 200 : result.refused ? 409 : 500).json({
            ok: result.ok,
            file: only || null,
            log: result.log,
            refused: Boolean(result.refused),
            ...(result.ok ? {} : { error: reasonFrom(result) }),
        });
    }),
);

// ---------------------------------------------------------------- settings

/** { current_semester: what the admin pinned (null = automatic, "*" = all), active_semester, semesters } */
const settingsBody = () => ({
    current_semester: Settings.get('current_semester'),
    active_semester: activeSemester(),
    semesters: Queries.semesters(),
});

admin.get('/settings', (req, res) => res.json(settingsBody()));

admin.put('/settings', (req, res) => {
    const parsed = z.object({ current_semester: z.string().trim().max(60).nullable() }).safeParse(req.body || {});
    if (!parsed.success) throw new HttpError(400, 'current_semester must be a semester label, "*" for all semesters, or null for automatic');
    const value = parsed.data.current_semester || null;
    Settings.set('current_semester', value);
    answerCache.clear();
    recordAdminAction(req.admin, 'setting', 'current_semester', value === '*' ? 'all semesters' : value || 'automatic');
    res.json(settingsBody());
});

// ----------------------------------------------------------------- aliases

admin.get('/aliases', (req, res) => res.json({ aliases: Aliases.list() }));

admin.post('/aliases', (req, res) => {
    const text = z.string().trim().min(2).max(80);
    const parsed = z.object({ alias: text, title: text }).safeParse(req.body || {});
    if (!parsed.success) throw new HttpError(400, 'Give a short name and the full course title it stands for (2 to 80 characters each)');
    const { alias, title } = parsed.data;
    if (alias.toLowerCase() === title.toLowerCase()) throw new HttpError(400, 'The short name and the title are the same');
    Aliases.add(alias, title);
    answerCache.clear();
    recordAdminAction(req.admin, 'alias', alias, `stands for "${title}"`);
    res.status(201).json({ aliases: Aliases.list() });
});

admin.delete('/aliases/:alias', (req, res) => {
    if (!Aliases.remove(String(req.params.alias))) throw new HttpError(404, 'No such alias');
    answerCache.clear();
    recordAdminAction(req.admin, 'alias', req.params.alias, 'removed');
    res.json({ aliases: Aliases.list() });
});

// ------------------------------------------------------------- what happened

/** Recent admin actions, newest first. */
admin.get('/log', (req, res) => {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    res.json({ log: recentAdminActions(limit) });
});

/** What students asked in the last N days, and which questions got no answer. */
admin.get('/questions', (req, res) => res.json(questionStats(req.query.days)));
