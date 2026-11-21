// Measure answer quality: ask the real app a fixed list of questions and check
// that each answer was written from the right timetable rows.
//
//   cd server
//   node scripts/eval.js                    every question, against the real model
//   node scripts/eval.js --only abbr-ai     one question (ids are in eval/questions.js)
//   node scripts/eval.js --stub --limit 5   dry run against a fake model: proves the script works, nothing more
//   node scripts/eval.js --help             all options
//
// It starts the app on a spare port with a throwaway database filled from
// eval/fixture.js, so it never touches tmp/utg.db, the accounts database or
// data/. The model key is read from server/.env. What the results mean, and
// how to add a question, is in eval/README.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { CLASSES, EXAMS, insertFixture } from '../eval/fixture.js';
import { QUESTIONS } from '../eval/questions.js';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_PAUSE_SECONDS = 8; // between questions, to stay inside the provider's per-minute limit
const DEFAULT_RETRY_PAUSE_SECONDS = 60; // after a 429: long enough for a per-minute limit to clear
const REQUEST_TIMEOUT_MS = 120_000;
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const USAGE = `Usage: node scripts/eval.js [options]      (run it from server/)

  --only <id,id>        run only these questions
  --category <a,b>      run only these categories (as printed in the summary)
  --limit <n>           run only the first n of the questions chosen
  --pause <seconds>     wait between questions (default ${DEFAULT_PAUSE_SECONDS}; 0 with --stub)
  --retry-pause <s>     wait before the one retry after the model says it is busy (default ${DEFAULT_RETRY_PAUSE_SECONDS})
  --model <name>        use this model instead of MODEL from server/.env
  --json <file>         save every result, with filters and answers, to a file
  --compare <file>      a file saved earlier with --json: list the questions whose result changed
  --min <percent>       exit with code 1 if the pass rate is below this (default 0: never)
  --stub                use the fake model from test/helpers.js; no key needed, results mean nothing
  --list                print the questions and what each expects, then stop (no model calls)
  --help                this text

Exit codes: 0 finished, 1 pass rate below --min, 2 could not run or had to stop (no key, model unavailable), 130 stopped with Ctrl+C.`;

// ---------- options ----------

class UsageError extends Error {}

const FLAG_OPTIONS = { '--stub': 'stub', '--list': 'list', '--help': 'help', '-h': 'help' };
const VALUE_OPTIONS = {
    '--only': 'only',
    '--category': 'category',
    '--limit': 'limit',
    '--pause': 'pause',
    '--retry-pause': 'retryPause',
    '--model': 'model',
    '--json': 'json',
    '--compare': 'compare',
    '--min': 'min',
};

export function parseArgs(argv) {
    const options = {};
    for (let i = 0; i < argv.length; i++) {
        const [name, inline] = argv[i].startsWith('--') && argv[i].includes('=') ? argv[i].split(/=(.*)/s) : [argv[i]];
        if (FLAG_OPTIONS[name]) {
            options[FLAG_OPTIONS[name]] = true;
        } else if (VALUE_OPTIONS[name]) {
            const value = inline ?? argv[++i];
            if (value === undefined || value === '') throw new UsageError(`${name} needs a value`);
            options[VALUE_OPTIONS[name]] = value;
        } else {
            throw new UsageError(`Unknown option: ${argv[i]}`);
        }
    }

    const number = (key, label, { min = 0, max = Infinity, whole = false } = {}) => {
        if (options[key] === undefined) return;
        const n = Number(options[key]);
        if (!Number.isFinite(n) || n < min || n > max || (whole && !Number.isInteger(n))) {
            throw new UsageError(`${label} must be a ${whole ? 'whole ' : ''}number${max === Infinity ? ` of at least ${min}` : ` from ${min} to ${max}`}`);
        }
        options[key] = n;
    };
    number('limit', '--limit', { min: 1, whole: true });
    number('pause', '--pause');
    number('retryPause', '--retry-pause');
    number('min', '--min', { max: 100 });

    const list = (key) => {
        if (options[key] !== undefined) options[key] = String(options[key]).split(',').map((s) => s.trim()).filter(Boolean);
    };
    list('only');
    list('category');
    return options;
}

/** The questions chosen by --only, --category and --limit, in the order of the file. */
export function chooseCases(all, { only, category, limit } = {}) {
    let cases = all;
    if (only) {
        const unknown = only.filter((id) => !all.some((c) => c.id === id));
        if (unknown.length) throw new UsageError(`No question with id: ${unknown.join(', ')}. See eval/questions.js or run with --list.`);
        cases = cases.filter((c) => only.includes(c.id));
    }
    if (category) {
        const known = [...new Set(all.map((c) => c.category))];
        const wanted = category.map((name) => name.toLowerCase());
        const unknown = wanted.filter((name) => !known.includes(name));
        if (unknown.length) throw new UsageError(`No category called: ${unknown.join(', ')}. The categories are: ${known.join(', ')}.`);
        cases = cases.filter((c) => wanted.includes(c.category));
    }
    if (limit) cases = cases.slice(0, limit);
    if (!cases.length) throw new UsageError('No questions match those options.');
    return cases;
}

// ---------- expectations ----------

/** "Today", "tomorrow" and the day after as 'Mon'..'Sun' in a timezone, plus the date. */
export function campusDays(timeZone, date = new Date()) {
    const today = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short' }).format(date).slice(0, 3);
    const i = DAYS.indexOf(today);
    return {
        today,
        tomorrow: DAYS[(i + 1) % 7],
        dayAfter: DAYS[(i + 2) % 7],
        weekday: new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long' }).format(date),
        iso: new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date),
    };
}

/** A case's expectation for a given day (some are functions of the weekday). */
export const resolveExpect = (testCase, when) =>
    typeof testCase.expect === 'function' ? testCase.expect(when) : testCase.expect;

const normCode = (code) => String(code ?? '').toUpperCase().replace(/\s+/g, '');
const day3 = (day) => {
    const d = String(day ?? '').trim().slice(0, 3).toLowerCase();
    return d ? d[0].toUpperCase() + d.slice(1) : '';
};
const unique = (list) => [...new Set(list)];

/**
 * Check questions.js against fixture.js before spending any model calls.
 * Returns a list of problems (empty when all is well).
 */
export function checkCases(cases) {
    const problems = [];
    const known = new Set([...CLASSES, ...EXAMS].map((row) => normCode(row.course_code)));
    const seen = new Set();
    const EXPECT_KEYS = ['codes', 'includes', 'kind', 'days', 'dates', 'clarify', 'none'];

    for (const c of cases) {
        const at = `"${c.id}"`;
        if (!c.id || typeof c.id !== 'string') problems.push(`A case has no id (question: ${JSON.stringify(c.question)})`);
        if (seen.has(c.id)) problems.push(`${at} is used as an id more than once`);
        seen.add(c.id);
        if (!c.category) problems.push(`${at} has no category`);
        if (!c.why) problems.push(`${at} has no "why"`);
        if (typeof c.question !== 'string' || !c.question.trim()) problems.push(`${at} has no question`);
        else if (c.question.length > 500) problems.push(`${at}: the question is longer than the 500 characters the app accepts`);
        for (const turn of c.history || []) {
            if (!['user', 'assistant'].includes(turn?.role) || typeof turn?.text !== 'string') {
                problems.push(`${at}: each history turn needs role 'user' or 'assistant' and a text`);
            }
        }

        // An expectation may depend on the weekday: check it for all seven.
        for (const today of DAYS) {
            const i = DAYS.indexOf(today);
            const when = { today, tomorrow: DAYS[(i + 1) % 7], dayAfter: DAYS[(i + 2) % 7] };
            let expect;
            try {
                expect = resolveExpect(c, when);
            } catch (e) {
                problems.push(`${at}: the expect function failed for ${today}: ${e.message}`);
                break;
            }
            const found = [];
            if (!expect || typeof expect !== 'object') {
                found.push('expect is missing');
            } else {
                const unknownKeys = Object.keys(expect).filter((key) => !EXPECT_KEYS.includes(key));
                if (unknownKeys.length) found.push(`unknown expect key ${unknownKeys.join(', ')}`);
                if (!expect.codes && !expect.includes && !expect.none && expect.clarify === undefined) {
                    found.push('expect needs at least one of codes, includes, none or clarify');
                }
                if (expect.none && (expect.codes?.length || expect.includes?.length)) found.push('expect has both none and course codes');
                if (expect.codes && !expect.codes.length) found.push('expect.codes is empty: use none: true');
                if (expect.clarify === true && (expect.codes || expect.includes)) {
                    found.push('expect has clarify: true and course codes, but the app returns no rows when it asks which department');
                }
                for (const code of [...(expect.codes || []), ...(expect.includes || [])]) {
                    if (!known.has(normCode(code))) found.push(`course code ${code} is not in the fixture`);
                }
                if (expect.kind && !['class', 'exam'].includes(expect.kind)) found.push(`kind must be 'class' or 'exam'`);
                for (const day of expect.days || []) if (!DAYS.includes(day)) found.push(`day ${day} must be one of ${DAYS.join(', ')}`);
                for (const date of expect.dates || []) if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) found.push(`date ${date} must be YYYY-MM-DD`);
            }
            if (found.length) {
                problems.push(...unique(found).map((text) => `${at}: ${text}${typeof c.expect === 'function' ? ` (when today is ${today})` : ''}`));
                break;
            }
        }
    }
    return problems;
}

/**
 * Compare the app's reply with what a case expects.
 * Returns { pass, problems: [text], got: { codes, kinds, days, dates, clarify, rows } }.
 */
export function judge(expect, body) {
    const matches = Array.isArray(body?.matches) ? body.matches : [];
    const rows = matches.map((m) => ({
        dept: m.dept ?? null,
        course_code: m.course_code ?? null,
        course_title: m.course_title ?? null,
        kind: m.kind === 'exam' ? 'exam' : 'class',
        day: day3(m.day) || null,
        date: m.date ?? null,
        start_time: m.start_time ?? null,
        end_time: m.end_time ?? null,
        venue: m.venue ?? null,
        lecturer: m.lecturer ?? null,
    }));
    const got = {
        codes: unique(rows.map((row) => String(row.course_code || '').trim() || '(no code)')),
        kinds: unique(rows.map((row) => row.kind)),
        days: unique(rows.map((row) => row.day).filter(Boolean)),
        dates: unique(rows.map((row) => row.date).filter(Boolean)),
        clarify: body?.clarify ? body.clarify.options || true : null,
        rows,
    };
    const gotCodes = new Set(got.codes.map(normCode));
    const problems = [];

    if (got.clarify && expect.clarify !== true) problems.push('asked "Which department do you want?" instead of answering');
    if (expect.clarify === true && !got.clarify) problems.push('did not ask "Which department do you want?"');

    if (expect.none && rows.length) problems.push(`expected no rows, got ${rows.length}`);

    if (expect.codes) {
        const wanted = new Set(expect.codes.map(normCode));
        const missing = expect.codes.filter((code) => !gotCodes.has(normCode(code)));
        const extra = got.codes.filter((code) => !wanted.has(normCode(code)));
        if (missing.length) problems.push(`missing ${missing.join(', ')}`);
        if (extra.length) problems.push(`not expected: ${extra.join(', ')}`);
    }
    if (expect.includes) {
        const missing = expect.includes.filter((code) => !gotCodes.has(normCode(code)));
        if (missing.length) problems.push(`missing ${missing.join(', ')}`);
    }

    if (expect.kind === 'exam' && got.kinds.includes('class')) problems.push('got class rows, expected exam rows');
    if (expect.kind === 'class' && got.kinds.includes('exam')) problems.push('got exam rows, expected class rows');

    const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
    if (expect.days && rows.length && !sameSet(unique(expect.days), got.days)) {
        problems.push(`rows are on ${got.days.join(', ') || 'no day'}, expected ${expect.days.join(', ')}`);
    }
    if (expect.dates && rows.length && !sameSet(unique(expect.dates), got.dates)) {
        problems.push(`rows are dated ${got.dates.join(', ') || 'no date'}, expected ${expect.dates.join(', ')}`);
    }

    return { pass: problems.length === 0, problems, got };
}

export function describeExpect(expect) {
    if (expect.clarify === true) return 'ask which department';
    if (expect.none) return 'no rows';
    const parts = [];
    if (expect.codes) parts.push(expect.codes.join(', '));
    if (expect.includes) parts.push(`at least ${expect.includes.join(', ')}`);
    if (expect.kind) parts.push(`[${expect.kind}]`);
    if (expect.days) parts.push(`on ${expect.days.join(', ')}`);
    if (expect.dates) parts.push(`on ${expect.dates.join(', ')}`);
    return parts.join(' ');
}

export function describeGot(got, expect = {}) {
    if (got.clarify) return `asked which department${Array.isArray(got.clarify) ? ` (${got.clarify.join(', ')})` : ''}`;
    if (!got.rows.length) return 'no rows';
    const parts = [got.codes.join(', '), `[${got.kinds.join(' and ')}]`];
    if (expect.days && got.days.length) parts.push(`on ${got.days.join(', ')}`);
    if (expect.dates && got.dates.length) parts.push(`on ${got.dates.join(', ')}`);
    return parts.join(' ');
}

// ---------- running ----------

let interrupted = false;
let wake = null; // ends the current pause early (Ctrl+C)
const sleep = (ms) =>
    new Promise((resolve) => {
        if (ms <= 0 || interrupted) return resolve();
        const done = () => {
            clearTimeout(timer);
            wake = null;
            resolve();
        };
        const timer = setTimeout(done, ms);
        wake = done;
    });

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/**
 * The database that holds student accounts. They may live in their own file
 * (src/db/accounts.js) or, in older versions, beside the timetable.
 */
async function accountsDatabase(timetableDb) {
    try {
        const { accountsDb } = await import('../src/db/accounts.js');
        if (accountsDb) return accountsDb;
    } catch (e) {
        if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;
    }
    return timetableDb;
}

/** A verified student with a session, written straight to the database. Returns the session token. */
function createStudent(accounts) {
    const token = crypto.randomBytes(24).toString('base64url');
    const now = Date.now();
    const userId = accounts
        .prepare(`INSERT INTO users (mat_number, email, password_hash, verified_at, created_at) VALUES ('EVAL0001', 'eval@utg.edu', 'x', ?, ?)`)
        .run(now, now).lastInsertRowid;
    accounts
        .prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
        .run(sha256(token), userId, now, now + 24 * 3600_000);
    return token;
}

/**
 * When the model last failed, as the app's model client reports it
 * (src/ai/groq.js: aiStatus). Returns a function that gives
 * { at, state, text } or null; null always, on a version without aiStatus.
 */
async function modelErrorReader() {
    let aiStatus = null;
    try {
        ({ aiStatus } = await import('../src/ai/groq.js'));
    } catch {
        // older layout: go by the HTTP status alone
    }
    return () => {
        try {
            const status = aiStatus?.();
            if (!status?.last_error_at) return null;
            // the provider's reply is JSON, possibly cut short: keep its message
            const raw = String(status.last_error || (status.last_error_status ? `status ${status.last_error_status}` : '')).replace(/\s+/g, ' ');
            const message = raw.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)/)?.[1];
            return { at: status.last_error_at, state: status.state, text: (message || raw).slice(0, 200) };
        } catch {
            return null;
        }
    };
}

/**
 * What the app wrote in its own question log for the question just asked:
 * { outcome, model_calls } or null. Only used for the "model calls" figure, so
 * any failure (older version, no such table) is ignored.
 */
function lastLoggedQuestion(accounts, since) {
    try {
        return accounts.prepare(`SELECT outcome, model_calls FROM question_log WHERE at >= ? ORDER BY id DESC LIMIT 1`).get(since) || null;
    } catch {
        return null;
    }
}

/** POST one question. Never throws: returns { status, body, text, ms } with status 0 if the request itself failed. */
async function ask(base, token, { question, history = [] }) {
    const started = Date.now();
    try {
        const response = await fetch(`${base}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ question, history }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const text = await response.text();
        let body = null;
        try { body = JSON.parse(text); } catch { /* not JSON: keep the text */ }
        return { status: response.status, body, text, ms: Date.now() - started };
    } catch (e) {
        const reason = e?.name === 'TimeoutError' ? `no reply within ${REQUEST_TIMEOUT_MS / 1000} seconds` : e?.message || String(e);
        return { status: 0, body: null, text: reason, ms: Date.now() - started };
    }
}

/** The search filters that were set, without the empty ones. */
const usedFilters = (filters) =>
    Object.fromEntries(Object.entries(filters || {}).filter(([, value]) => (Array.isArray(value) ? value.length > 0 : Boolean(value))));

const pad = (text, width) => String(text).padEnd(width);
const percent = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

function duration(ms) {
    const seconds = Math.round(ms / 1000);
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function printList(cases, when) {
    const width = Math.max(...cases.map((c) => c.id.length));
    for (const c of cases) {
        console.log(`${pad(c.id, width)}  [${c.category}]  ${JSON.stringify(c.question)}${c.history?.length ? `  (after ${c.history.length} earlier turns)` : ''}`);
        console.log(`${pad('', width)}  expects: ${describeExpect(resolveExpect(c, when))}`);
    }
    console.log(`\n${cases.length} questions. Expectations are shown for today, ${when.weekday} ${when.iso}.`);
}

function summarise(results) {
    const count = (list, status) => list.filter((r) => r.status === status).length;
    const tally = (list) => ({
        total: list.length,
        passed: count(list, 'pass'),
        failed: count(list, 'fail'),
        errors: count(list, 'error'),
        notRun: count(list, 'not_run'),
    });
    const byCategory = {};
    for (const category of unique(results.map((r) => r.category))) {
        byCategory[category] = tally(results.filter((r) => r.category === category));
    }
    const totals = tally(results);
    // from the app's own question log; null on a version that does not keep one
    const counted = results.filter((r) => Number.isFinite(r.model_calls));
    const modelCalls = counted.length ? counted.reduce((sum, r) => sum + r.model_calls, 0) : null;
    return { ...totals, passRate: percent(totals.passed, totals.total), modelCalls, byCategory };
}

function printSummary(summary, results, { model, stub, elapsedMs, stopReason }) {
    const width = Math.max(8, ...Object.keys(summary.byCategory).map((name) => name.length)) + 2;
    const noAnswer = (t) => (t.errors + t.notRun ? `   (${t.errors + t.notRun} with no answer)` : '');
    const line = (name, t) => `  ${pad(name, width)}${String(t.passed).padStart(3)} of ${String(t.total).padEnd(3)} ${String(percent(t.passed, t.total)).padStart(3)}%${noAnswer(t)}`;

    console.log('\nPassed, by category');
    for (const [name, t] of Object.entries(summary.byCategory)) console.log(line(name, t));
    console.log(`  ${'-'.repeat(width + 15)}`);
    console.log(line('all', summary));
    console.log(`\nModel: ${stub ? 'the fake model (--stub): these numbers say nothing about answer quality' : model}. Time: ${duration(elapsedMs)}.`);
    if (summary.modelCalls !== null) {
        const asked = results.filter((r) => Number.isFinite(r.model_calls)).length;
        console.log(`Model calls the app made: ${summary.modelCalls} for ${asked} question(s).`);
    }

    if (stopReason) console.log(`\nStopped early: ${stopReason}`);
    if (summary.errors + summary.notRun) {
        console.log(
            `${summary.errors} question(s) got an error instead of an answer and ${summary.notRun} were not asked. ` +
                `They count as not passed, so the real pass rate may be higher.`,
        );
    }
    const again = results.filter((r) => r.status !== 'pass').map((r) => r.id);
    if (again.length && !stub) console.log(`\nTo run only those again:\n  node scripts/eval.js --only ${again.join(',')}`);
}

/** An earlier --json file, read before anything is asked so a wrong path costs no model calls. */
function readEarlierRun(file) {
    try {
        const earlier = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
        if (!Array.isArray(earlier.results)) throw new Error('it has no "results" list');
        return earlier;
    } catch (e) {
        throw new UsageError(`Cannot compare with ${file}: ${e.message}`);
    }
}

function printComparison(earlier, file, results) {
    const was = new Map(earlier.results.map((r) => [r.id, r.status]));
    const changed = (from, to) => results.filter((r) => was.get(r.id) === from && r.status === to).map((r) => r.id);
    const worse = changed('pass', 'fail');
    const better = changed('fail', 'pass');
    console.log(`\nCompared with ${file} (${earlier.model || 'unknown model'}, ${String(earlier.started_at || '').slice(0, 10) || 'no date'}):`);
    console.log(`  passed then, fail now: ${worse.join(', ') || 'none'}`);
    console.log(`  failed then, pass now: ${better.join(', ') || 'none'}`);
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log(USAGE);
        return 0;
    }
    const earlier = options.compare ? readEarlierRun(options.compare) : null;

    // server/.env first, as the server does. Values set below win over it,
    // because dotenv never replaces a variable that is already set.
    dotenv.config({ path: path.join(SERVER_DIR, '.env') });
    const timeZone = process.env.TIMEZONE || 'Africa/Banjul';

    const problems = checkCases(QUESTIONS);
    if (problems.length) {
        console.error(`eval/questions.js does not fit eval/fixture.js:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
        return 2;
    }
    const cases = chooseCases(QUESTIONS, options);

    if (options.list) {
        printList(cases, campusDays(timeZone));
        return 0;
    }

    const stub = options.stub ? await (await import('../test/helpers.js')).startStub() : null;
    if (!stub && !process.env.GROQ_API_KEY) {
        console.error(
            'GROQ_API_KEY is not set, so there is no model to ask.\n' +
                'Put the key in server/.env (see server/.env.example), or add --stub for a dry run against a fake model.',
        );
        return 2;
    }

    // A throwaway home for both databases and the data folder. These must be set
    // before any server code is imported, because env.js reads them at import time.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'utg-eval-'));
    process.on('exit', () => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the system clears its temp folder anyway */ }
    });
    Object.assign(process.env, {
        NODE_ENV: 'test', // no request log, and the mailer stays quiet
        DATA_DIR: path.join(dir, 'data'),
        DB_PATH: path.join(dir, 'utg.db'),
        ACCOUNTS_DB_PATH: path.join(dir, 'accounts.db'),
        BACKUP_DIR: path.join(dir, 'backups'),
        SMTP_HOST: '',
        DEV_SHOW_CODES: '',
        // one student asks every question: the app's own limits must not get in the way
        CHAT_PER_MINUTE: '100000',
        CHAT_PER_DAY: '1000000',
        // every question is worked out afresh, never taken from the answer cache
        ANSWER_CACHE_SECONDS: '0',
    });
    if (options.model) process.env.MODEL = options.model;
    if (stub) Object.assign(process.env, { GROQ_API_KEY: 'stub-key', GROQ_BASE_URL: stub.url, MODEL: 'stub-model' });

    const { env } = await import('../src/env.js');
    const { createApp } = await import('../src/app.js');
    const { db } = await import('../src/db/connect.js');
    const accounts = await accountsDatabase(db);

    const modelError = await modelErrorReader();

    const inserted = insertFixture(db);
    const token = createStudent(accounts);

    const server = createApp().listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => server.once('listening', resolve).once('error', reject));
    const base = `http://127.0.0.1:${server.address().port}`;

    const pauseMs = (options.pause ?? (stub ? 0 : DEFAULT_PAUSE_SECONDS)) * 1000;
    const retryPauseMs = (options.retryPause ?? (stub ? 0 : DEFAULT_RETRY_PAUSE_SECONDS)) * 1000;
    const startedAt = new Date();
    const first = campusDays(timeZone, startedAt);

    console.log(`Answer-quality evaluation: ${cases.length} question(s) against ${inserted.classes} made-up classes and ${inserted.exams} exams.`);
    console.log(
        stub
            ? 'DRY RUN with the fake model (--stub). It always returns the same thing, so most questions fail. This only shows that the script works.'
            : `Model: ${env.MODEL}. Pause between questions: ${pauseMs / 1000}s, so this takes about ${duration((cases.length - 1) * pauseMs + cases.length * 3000)}.`,
    );
    console.log(`Today is ${first.weekday} ${first.iso} in ${timeZone}.\n`);

    process.on('SIGINT', () => {
        if (interrupted) process.exit(130);
        interrupted = true;
        console.log('\nStopping after the current question. Press Ctrl+C again to quit at once.');
        wake?.();
    });

    const idWidth = Math.max(...cases.map((c) => c.id.length));
    const results = [];
    let stopReason = null;
    let modelUnusable = false; // stopped because no answer could be had from the model

    for (const [index, c] of cases.entries()) {
        if (index > 0 && !stopReason && !interrupted) await sleep(pauseMs);
        if (interrupted && !stopReason) stopReason = 'interrupted with Ctrl+C.';

        const when = campusDays(timeZone);
        const expect = resolveExpect(c, when);
        const result = {
            id: c.id,
            category: c.category,
            question: c.question,
            history: c.history || [],
            why: c.why,
            expected: expect,
            status: 'not_run',
            problems: [],
            attempts: 0,
        };
        results.push(result);
        if (stopReason) continue;

        // Ask. If the model was unavailable meanwhile, the app may have answered
        // from its fallback (or not at all), which says nothing about answer
        // quality: wait, and ask once more.
        const askOnce = async () => {
            const since = Date.now();
            const reply = await ask(base, token, c);
            const failure = modelError();
            const modelFailed = Boolean(failure && failure.at >= since);
            const refused = [429, 502, 503].includes(reply.status);
            return {
                reply,
                since,
                unavailable: refused || modelFailed || reply.body?.degraded === true,
                busy: reply.status === 429 || (modelFailed && failure.state === 'busy'),
                reason: (refused && reply.body?.error) || (modelFailed && failure.text) || 'the app answered without the model',
            };
        };

        let attempt = await askOnce();
        result.attempts = 1;
        if (attempt.unavailable && !interrupted) {
            // a per-minute limit needs the long wait; anything else is retried sooner
            const wait = attempt.busy ? retryPauseMs : Math.min(retryPauseMs, 5000);
            console.log(`  wait  ${c.id}: the model was not available (${attempt.reason}). Waiting ${wait / 1000}s, then asking once more.`);
            await sleep(wait);
            if (!interrupted) {
                attempt = await askOnce();
                result.attempts = 2;
            }
        }
        const { reply } = attempt;
        result.http_status = reply.status;
        result.ms = reply.ms;
        const logged = lastLoggedQuestion(accounts, attempt.since);
        if (logged) {
            result.outcome = logged.outcome;
            result.model_calls = logged.model_calls;
        }

        if (reply.status === 200 && reply.body && !attempt.unavailable) {
            const verdict = judge(expect, reply.body);
            result.status = verdict.pass ? 'pass' : 'fail';
            result.problems = verdict.problems;
            result.got = { ...verdict.got, filters: reply.body.filters ?? null, slots: reply.body.slots ?? null, answer: reply.body.answer ?? null };

            console.log(`${verdict.pass ? 'PASS ' : 'FAIL '} ${pad(c.id, idWidth)}  expected: ${describeExpect(expect)}  |  got: ${describeGot(verdict.got, expect)}`);
            if (!verdict.pass) {
                console.log(`       ${verdict.problems.join('; ')}`);
                console.log(`       question: ${JSON.stringify(c.question)}${c.history?.length ? ` (after ${c.history.length} earlier turns)` : ''}`);
                console.log(`       searched with: ${JSON.stringify(usedFilters(reply.body.filters))}`);
            }
            continue;
        }

        result.status = 'error';
        if (attempt.unavailable) result.error = `the model was not available: ${attempt.reason}`;
        else if (reply.status) result.error = `HTTP ${reply.status}: ${reply.body?.error || reply.text.slice(0, 200)}`;
        else result.error = reply.text;
        console.log(`ERROR ${pad(c.id, idWidth)}  ${result.error}`);

        // Some failures will repeat for every question: stop instead of burning through the list.
        if (interrupted) {
            stopReason = 'interrupted with Ctrl+C.';
        } else if (attempt.unavailable && attempt.busy) {
            modelUnusable = true;
            stopReason = `the model was still busy after a ${retryPauseMs / 1000}s wait. The daily limit may be used up: try again later, or use a longer --pause.`;
        } else if (attempt.unavailable) {
            modelUnusable = true;
            stopReason = `the model cannot be used: ${attempt.reason}`;
        } else if (reply.status === 401) {
            modelUnusable = true;
            stopReason = 'the app did not accept the student this script created. The way sessions are stored has probably changed: see createStudent in scripts/eval.js.';
        }
    }

    const finishedAt = new Date();
    const summary = summarise(results);
    printSummary(summary, results, { model: env.MODEL, stub: Boolean(stub), elapsedMs: finishedAt - startedAt, stopReason });

    if (earlier) printComparison(earlier, options.compare, results);

    if (options.json) {
        const file = path.resolve(options.json);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const report = {
            started_at: startedAt.toISOString(),
            finished_at: finishedAt.toISOString(),
            model: stub ? 'stub' : env.MODEL,
            stub: Boolean(stub),
            timezone: timeZone,
            today: `${first.weekday} ${first.iso}`,
            pause_seconds: pauseMs / 1000,
            stopped_early: stopReason,
            summary,
            results,
        };
        fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
        console.log(`\nResults saved to ${file}`);
    }

    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    if (stub) await stub.close();
    if (accounts !== db) accounts.close();
    db.close();

    // an unfinished run measured nothing that can be compared with --min
    if (modelUnusable) return 2;
    if (interrupted) return 130;
    const minimum = options.min ?? 0;
    if (summary.passRate < minimum) {
        console.log(`\nPass rate ${summary.passRate}% is below the --min of ${minimum}%.`);
        return 1;
    }
    return 0;
}

// Run only when started as a script, so the checks above can be imported and tested.
const startedDirectly =
    Boolean(process.argv[1]) && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));

if (startedDirectly) {
    let code;
    try {
        code = await main();
    } catch (e) {
        code = 2;
        if (e instanceof UsageError) {
            console.error(`${e.message}\n\n${USAGE}`);
        } else {
            console.error('The evaluation could not run:');
            console.error(e);
        }
    }
    // Exit explicitly (sockets left open by fetch would keep the process alive
    // for a few seconds), but only once everything printed has been written out.
    await new Promise((resolve) => process.stdout.write('', resolve));
    await new Promise((resolve) => process.stderr.write('', resolve));
    process.exit(code);
}
