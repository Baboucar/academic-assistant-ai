// Test harness: a fake model endpoint plus an app wired to a throwaway database.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/** Start an OpenAI-compatible stub. Tests set `stub.slots` / `stub.answer` and read `stub.calls`. */
export async function startStub() {
    const stub = {
        slots: {},
        answer: 'Stub answer.',
        failAnswer: false,
        busyTimes: 0, // answer the next N requests with 429 "try again"
        calls: [],
    };

    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const body = JSON.parse(raw || '{}');
            const isSlots = body.messages?.[0]?.content?.includes('slot-filling');
            stub.calls.push({ kind: isSlots ? 'slots' : 'answer', body });

            if (stub.busyTimes > 0) {
                stub.busyTimes--;
                res.statusCode = 429;
                res.setHeader('Retry-After', '0');
                return res.end('{"error":{"message":"Rate limit reached"}}');
            }

            if (isSlots) {
                res.setHeader('Content-Type', 'application/json');
                return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(stub.slots) } }] }));
            }
            if (stub.failAnswer) {
                res.statusCode = 500;
                return res.end('boom');
            }
            if (!body.stream) {
                res.setHeader('Content-Type', 'application/json');
                return res.end(JSON.stringify({ choices: [{ message: { content: stub.answer } }] }));
            }
            res.setHeader('Content-Type', 'text/event-stream');
            for (const word of stub.answer.split(/(?<=\s)/)) {
                res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`);
            }
            res.write('data: [DONE]\n\n');
            res.end();
        });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    stub.url = `http://127.0.0.1:${server.address().port}`;
    stub.close = () => new Promise((resolve) => server.close(resolve));
    return stub;
}

export const ROWS = [
    ['CS', 'CPS 416', 'Artificial Intelligence', 'Mon', '08:30', '11:00', 'Lab 2', 'Dr. Awa Ceesay'],
    ['CS', 'CPS 313', 'Operating Systems', 'Mon', '11:30', '14:00', 'Hall A', 'Mr. Lamin Jobe'],
    ['CS', 'ICT 202', 'Web Programming II', 'Tue', '08:30', '11:00', 'Lab 1', 'Ms. Fatou Sanneh'],
    ['INS', 'INS 404', 'Database Systems', 'Tue', '14:30', '17:00', 'Hall B', 'Dr. Awa Ceesay'],
    ['CS', 'CPS 220', 'Data Communications and Network', 'Thu', '08:30', '11:00', 'Hall A', 'Mr. Lamin Jobe'],
];

// Exam sittings: two still to come and one already written, relative to any test run date
export const EXAMS = [
    ['CS', 'CPS 416', 'Artificial Intelligence', '2099-01-12', '09:00', '12:00', 'Exam Hall 1'],
    ['CS', 'CPS 313', 'Operating Systems', '2099-01-14', '14:00', '17:00', 'Exam Hall 2'],
    ['CS', 'ICT 202', 'Web Programming II', '2020-01-10', '09:00', '12:00', 'Exam Hall 1'],
];

/**
 * Boot the app against a temp database and the stub model.
 * Must run before anything imports server code, because env is read at import time.
 */
export async function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'utg-test-'));
    const stub = await startStub();

    Object.assign(process.env, {
        NODE_ENV: 'test',
        DATA_DIR: path.join(dir, 'data'),
        DB_PATH: path.join(dir, 'utg.db'),
        GROQ_API_KEY: 'test-key',
        GROQ_BASE_URL: stub.url,
        ADMIN_USER: 'admin',
        ADMIN_PASS: 'test-pass',
        TIMEZONE: 'Africa/Banjul',
        ORIGIN: '*',
        // pin everything a developer's own server/.env could otherwise change
        MODEL: 'test-model',
        SMTP_HOST: '',
        DEV_SHOW_CODES: '',
        STUDENT_EMAIL_DOMAINS: 'utg.edu',
        MAT_NUMBER_PATTERN: '^[A-Z0-9]{5,12}$',
        // tests ask far more questions than one student would
        CHAT_PER_MINUTE: '1000',
        CHAT_PER_DAY: '100000',
    });

    const { createApp } = await import('../src/app.js');
    const { db } = await import('../src/db/connect.js');

    const insert = db.prepare(`
      INSERT INTO timetable (dept,course_code,course_title,day,start_time,end_time,venue,lecturer,source_file,semester)
      VALUES (?,?,?,?,?,?,?,?, 'seed.xlsx', 'S1')`);
    for (const row of ROWS) insert.run(...row);
    db.prepare(`INSERT INTO sources (source_file, type, semester) VALUES ('seed.xlsx','timetable','S1')`).run();

    const insertExam = db.prepare(`
      INSERT INTO exams (dept,course_code,course_title,date,start_time,end_time,venue,source_file,semester)
      VALUES (?,?,?,?,?,?,?, 'seed-exams.xlsx', 'S1')`);
    for (const row of EXAMS) insertExam.run(...row);
    db.prepare(`INSERT INTO sources (source_file, type, semester) VALUES ('seed-exams.xlsx','exams','S1')`).run();

    // A signed-in student for the tests that are not about signing in
    const token = crypto.randomBytes(24).toString('base64url');
    const userId = db
        .prepare(`INSERT INTO users (mat_number, email, password_hash, verified_at, created_at) VALUES ('22216000', 'seed@utg.edu', 'x', ?, ?)`)
        .run(Date.now(), Date.now()).lastInsertRowid;
    db.prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
        .run(crypto.createHash('sha256').update(token).digest('hex'), userId, Date.now(), Date.now() + 3600_000);
    const student = { Authorization: `Bearer ${token}` };

    const server = createApp().listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    const auth = (user = 'admin', pass = 'test-pass') => ({
        Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`,
    });

    return {
        base,
        stub,
        db,
        dir,
        dataDir: process.env.DATA_DIR,
        auth,
        student,
        /** POST JSON as the seeded student; pass headers to sign in as someone else (or nobody). */
        post: (url, body, headers = student) =>
            fetch(base + url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...headers },
                body: JSON.stringify(body),
            }),
        get: (url, headers = student) => fetch(base + url, { headers }),
        async close() {
            await new Promise((resolve) => server.close(resolve));
            await stub.close();
            db.close();
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

/** Parse an SSE response body into its JSON events. */
export async function readEvents(response) {
    const text = await response.text();
    return text
        .split('\n\n')
        .map((frame) => frame.replace(/^data:\s?/, '').trim())
        .filter(Boolean)
        .map((frame) => JSON.parse(frame));
}
