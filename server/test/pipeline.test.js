// How a question is handled: which parts need the model and which do not,
// what is remembered, and the things an admin can change that alter answers.
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readEvents, setup } from './helpers.js';

let ctx;
let answerCache;
before(async () => {
    ctx = await setup();
    ({ answerCache } = await import('../src/chat/cache.js'));
});
after(async () => { await ctx.close(); });
beforeEach(() => {
    ctx.stub.calls.length = 0;
    ctx.stub.slots = {};
    ctx.stub.answer = 'Stub answer.';
    ctx.stub.failAnswer = false;
    ctx.stub.busyTimes = 0;
});

const codes = (matches) => matches.map((m) => m.course_code);
const kinds = () => ctx.stub.calls.map((c) => c.kind);
const ask = async (question, history) => (await ctx.post('/api/chat', { question, ...(history ? { history } : {}) })).json();
const admin = (method, url, body) =>
    fetch(`${ctx.base}/api/admin${url}`, {
        method,
        headers: { ...ctx.auth(), 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

test('a simple question is read by code: no model call to understand it', async () => {
    const byCode = await ask('when is cps416?');
    assert.deepEqual(codes(byCode.matches), ['CPS 416']);
    assert.deepEqual(kinds(), ['answer'], 'one call, to write the sentence; none to read the question');

    ctx.stub.calls.length = 0;
    const byDay = await ask('What classes are on Monday?');
    assert.deepEqual(codes(byDay.matches), ['CPS 416', 'CPS 313']);
    assert.deepEqual(kinds(), ['answer']);

    // a name can only be picked out by the model
    ctx.stub.calls.length = 0;
    ctx.stub.slots = { lecturer_name: 'Lamin Jobe' };
    const byName = await ask('What does Lamin Jobe take?');
    assert.deepEqual(codes(byName.matches), ['CPS 313', 'CPS 220']);
    assert.deepEqual(kinds(), ['slots', 'answer']);
});

test('"room 101" is not mistaken for a course code', async () => {
    ctx.stub.slots = { venue: 'Room 101' };
    await ask('What is in room 101 on Monday?');
    assert.equal(kinds()[0], 'slots', 'left to the model, not read as course ROOM101');
});

test('nothing found is said by code, naming what was searched', async () => {
    ctx.stub.slots = { title_kw: 'Quantum Physics' };
    const body = await ask('When is Quantum Physics?');
    assert.deepEqual(body.matches, []);
    assert.equal(body.answer, 'I could not find any classes for Quantum Physics in the timetable. Check the spelling, or try the course code.');
    assert.deepEqual(kinds(), ['slots'], 'no model call to write "not found"');
});

test('a question that could not be read is told apart from one with no match', async () => {
    ctx.stub.slots = {}; // the model found nothing to search for
    const body = await ask('When is the lecture with the new lecturer?');
    assert.match(body.answer, /could not work out which course, lecturer, venue or day/);
    assert.deepEqual(kinds(), ['slots']);

    const log = ctx.accountsDb.prepare(`SELECT outcome FROM question_log ORDER BY id DESC LIMIT 1`).get();
    assert.equal(log.outcome, 'not_understood');
});

test('small talk goes to the model, with a canned reply when the model is down', async () => {
    ctx.stub.answer = 'Hello! I can help with classes and exams.';
    assert.equal((await ask('hello there')).answer, 'Hello! I can help with classes and exams.');

    // "thanks a lot" has nothing code can read, so the model is asked; when it answers
    // the reading step but fails on the reply, the canned text is used
    ctx.stub.failAnswer = true;
    const down = await ask('thanks a lot');
    assert.match(down.answer, /I can answer questions about classes and exams/);
});

test('when a search has to be loosened, the answer says what was not found', async () => {
    // INS is a department in the class timetable, but no exam carries it
    const body = await ask('Show the INS exams');
    assert.deepEqual(body.matches.map((m) => m.date), ['2099-01-12', '2099-01-14']);
    assert.equal(body.filters.dept, null, 'the filters returned are the ones that produced the rows');
    const prompt = ctx.stub.calls.find((c) => c.kind === 'answer').body.messages[0].content;
    assert.match(prompt, /Nothing matched the search first asked for \(INS exams\)/);

    // with the model unavailable the same thing is said by code
    ctx.stub.failAnswer = true;
    const fallback = await ask('Show the INS exams');
    assert.match(fallback.answer, /^I could not find INS exams\. Here is the closest I found\./);
    assert.match(fallback.answer, /\*\*Artificial Intelligence\*\* \(CPS 416\): Monday 12 January 2099, 09:00–12:00, Exam Hall 1\./);
});

test('exams can be found by lecturer', async () => {
    ctx.accountsDb.exec('SELECT 1');
    ctx.db.prepare(`UPDATE exams SET lecturer = 'Dr. Awa Ceesay' WHERE course_code = 'CPS 416'`).run();
    ctx.stub.slots = { lecturer_name: 'Awa Ceesay', exam: true };
    const body = await ask('Which exams does Dr. Awa Ceesay have?');
    assert.deepEqual(codes(body.matches), ['CPS 416']);
    assert.equal(body.matches[0].lecturer, 'Dr. Awa Ceesay');
});

test('a repeated first question is answered from memory, and a follow-up never is', async () => {
    answerCache.enabled = true;
    try {
        ctx.stub.answer = 'Monday at 08:30.';
        const first = await ask('When is CPS 416?');
        assert.equal(first.answer, 'Monday at 08:30.');
        assert.equal(ctx.stub.calls.length, 1);

        ctx.stub.calls.length = 0;
        ctx.stub.answer = 'A different answer.';
        const second = await ask('  when is CPS 416  ');
        assert.equal(second.answer, 'Monday at 08:30.');
        assert.deepEqual(codes(second.matches), ['CPS 416']);
        assert.equal(ctx.stub.calls.length, 0, 'no model call for the repeat');

        // streamed repeats work too
        const events = await readEvents(await ctx.post('/api/chat?stream=1', { question: 'When is CPS 416?' }));
        assert.deepEqual(events.map((e) => e.event), ['meta', 'chunk', 'done']);
        assert.equal(events[1].text, 'Monday at 08:30.');

        // the same words as a follow-up depend on the conversation, so they are worked out afresh
        const followUp = await ask('When is CPS 416?', [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'Hello!' }]);
        assert.equal(followUp.answer, 'A different answer.');

        // loading a file changes the answers, so memory is not used after it
        ctx.db.prepare(`INSERT INTO sources (source_file, type, semester, ingested_at) VALUES ('later.xlsx','timetable','S1', datetime('now', '+1 minute'))`).run();
        assert.equal((await ask('When is CPS 416?')).answer, 'A different answer.');
        ctx.db.prepare(`DELETE FROM sources WHERE source_file = 'later.xlsx'`).run();

        const cachedRows = ctx.accountsDb.prepare(`SELECT COUNT(*) AS n FROM question_log WHERE cached = 1`).get().n;
        assert.ok(cachedRows >= 2, 'repeats are logged as answered from memory');
    } finally {
        answerCache.enabled = false;
        answerCache.clear();
    }
});

test('the question log records what was asked and how it went, without the student', async () => {
    ctx.stub.slots = { title_kw: 'Underwater Basket Weaving' };
    await ask('When is Underwater Basket Weaving?');
    const row = ctx.accountsDb.prepare(`SELECT * FROM question_log ORDER BY id DESC LIMIT 1`).get();
    assert.equal(row.question, 'When is Underwater Basket Weaving?');
    assert.equal(row.outcome, 'not_found');
    assert.equal(row.model_calls, 1);
    assert.deepEqual(JSON.parse(row.filters), { title: 'Underwater Basket Weaving' });
    assert.ok(!Object.keys(row).some((k) => /user|student|email|mat/i.test(k)), 'no column identifies the student');

    const stats = await (await admin('GET', '/questions?days=1')).json();
    assert.ok(stats.totals.not_found >= 1);
    assert.ok(stats.unanswered.some((q) => q.question === 'When is Underwater Basket Weaving?' && q.outcome === 'not_found'));
    assert.ok(stats.questions >= stats.totals.not_found);
});

test('an abbreviation is understood from the initials of a loaded course title', async () => {
    ctx.stub.slots = { title_kw: 'os' };
    const os = await ask('when is os');
    assert.deepEqual(codes(os.matches), ['CPS 313']);
    assert.equal(os.filters.title, 'Operating Systems', 'and the answer names the course, not the abbreviation');

    // "Data Communications and Network": small words do not count towards the initials
    ctx.stub.slots = { title_kw: 'dcn' };
    assert.deepEqual(codes((await ask('where is dcn held')).matches), ['CPS 220']);

    // initials that fit no course still find nothing, rather than something unrelated
    ctx.stub.slots = { title_kw: 'xyz' };
    assert.deepEqual((await ask('when is xyz')).matches, []);
});

test('course aliases are data an admin can change', async () => {
    // "AI" is seeded; students also call Data Communications "nets", which nothing can work out
    ctx.stub.slots = { title_kw: 'nets' };
    assert.deepEqual((await ask('who teaches nets')).matches, []);

    const added = await admin('POST', '/aliases', { alias: 'nets', title: 'Data Communications and Network' });
    assert.equal(added.status, 201);
    assert.ok((await added.json()).aliases.some((a) => a.alias === 'nets' && a.title === 'Data Communications and Network'));

    ctx.stub.calls.length = 0;
    const body = await ask('who teaches nets');
    assert.deepEqual(codes(body.matches), ['CPS 220']);
    assert.equal(body.filters.title, 'Data Communications and Network');
    assert.deepEqual(kinds(), ['answer'], 'a known alias needs no model call to be understood');
    assert.match(ctx.stub.calls[0].body.messages[0].content, /"nets": "Data Communications and Network"/, 'and the model is given the glossary');

    assert.equal((await admin('POST', '/aliases', { alias: 'x', title: '' })).status, 400);
    assert.equal((await admin('DELETE', '/aliases/nets')).status, 200);
    assert.equal((await admin('DELETE', '/aliases/nets')).status, 404);
    ctx.stub.slots = { title_kw: 'nets' };
    assert.deepEqual((await ask('who teaches nets')).matches, []);
});

test('answers come from the current semester only', async () => {
    const settings = async () => (await admin('GET', '/settings')).json();
    assert.equal((await settings()).active_semester, null, 'one semester loaded: nothing to choose');

    // next semester's file arrives, with a different lecturer for the same course
    ctx.db.prepare(`INSERT INTO timetable (dept,course_code,course_title,day,start_time,end_time,venue,lecturer,source_file,semester)
                    VALUES ('CS','CPS 416','Artificial Intelligence','Fri','14:00','16:00','Lab 9','Dr. New Lecturer','next.xlsx','S2')`).run();
    ctx.db.prepare(`INSERT INTO sources (source_file, type, semester, ingested_at) VALUES ('next.xlsx','timetable','S2', datetime('now', '+1 hour'))`).run();
    try {
        assert.equal((await settings()).active_semester, 'S2', 'the newest upload decides, unless an admin pins one');
        assert.deepEqual((await ask('when is cps 416')).matches.map((m) => [m.day, m.venue]), [['Fri', 'Lab 9']]);

        const pinned = await admin('PUT', '/settings', { current_semester: 'S1' });
        assert.equal((await pinned.json()).active_semester, 'S1');
        assert.deepEqual((await ask('when is cps 416')).matches.map((m) => m.day), ['Mon']);

        await admin('PUT', '/settings', { current_semester: '*' });
        assert.deepEqual((await ask('when is cps 416')).matches.map((m) => m.day), ['Mon', 'Fri']);

        const all = await settings();
        assert.deepEqual(all.semesters.map((s) => s.semester), ['S2', 'S1']);
        assert.equal(all.current_semester, '*');
    } finally {
        await admin('PUT', '/settings', { current_semester: null });
        ctx.db.prepare(`DELETE FROM timetable WHERE source_file = 'next.xlsx'`).run();
        ctx.db.prepare(`DELETE FROM sources WHERE source_file = 'next.xlsx'`).run();
    }
});

test('every admin has their own sign-in, and what they change is recorded under their name', async () => {
    const second = ctx.auth('second-admin', 'another-test-pass');
    const r = await fetch(`${ctx.base}/api/admin/settings`, {
        method: 'PUT',
        headers: { ...second, 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_semester: null }),
    });
    assert.equal(r.status, 200);
    assert.equal((await fetch(`${ctx.base}/api/admin/log`, { headers: ctx.auth('second-admin', 'test-pass') })).status, 401, 'one admin cannot use another\'s password');

    const { log } = await (await admin('GET', '/log')).json();
    assert.deepEqual({ admin: log[0].admin, action: log[0].action, target: log[0].target, detail: log[0].detail },
        { admin: 'second-admin', action: 'setting', target: 'current_semester', detail: 'automatic' });
    assert.ok(log.some((entry) => entry.admin === 'admin' && entry.action === 'alias'));
});

test('the health check says what an operator needs: version, mode, semester and how the model is doing', async () => {
    ctx.stub.answer = 'ok';
    await ask('when is cps 416');
    const health = await (await fetch(`${ctx.base}/api/health`)).json();
    assert.match(health.version, /^\d+\.\d+\.\d+/);
    assert.equal(health.mode, 'development');
    assert.equal(health.ai.state, 'ok');

    ctx.stub.busyTimes = 50;
    await ask('What does Lamin Jobe take?');
    const busy = await (await fetch(`${ctx.base}/api/health`)).json();
    assert.equal(busy.ok, true, 'the server itself is still up');
    assert.equal(busy.ai.state, 'busy');
    assert.ok(busy.ai.last_error_at >= busy.ai.last_ok_at);
});

test('production refuses unsafe settings, and says which', async () => {
    const { productionProblems } = await import('../src/env.js');
    const problems = productionProblems().join('\n');
    assert.match(problems, /ORIGIN is "\*"/);
    assert.match(problems, /SMTP_HOST is not set/);
    assert.match(problems, /admin password for "admin" is shorter than 12 characters/);
    assert.doesNotMatch(problems, /GROQ_API_KEY/, 'only what is actually wrong is listed');
});

// ---- found by the independent review of this code ----

test('a pinned semester with nothing loaded any more is ignored, not an empty timetable', async () => {
    await admin('PUT', '/settings', { current_semester: 'A term that was deleted' });
    try {
        const settings = await (await admin('GET', '/settings')).json();
        assert.equal(settings.current_semester, 'A term that was deleted');
        assert.equal(settings.active_semester, null, 'falls back to everything loaded');
        assert.deepEqual(codes((await ask('when is cps 416')).matches), ['CPS 416']);
    } finally {
        await admin('PUT', '/settings', { current_semester: null });
    }
});

test('the automatic semester follows the label, not which file was uploaded last', async () => {
    // an old term's file is corrected and re-uploaded after the current term's files
    ctx.db.prepare(`INSERT INTO timetable (dept,course_code,course_title,day,start_time,end_time,venue,lecturer,source_file,semester)
                    VALUES ('CS','CPS 416','Artificial Intelligence','Sat','09:00','11:00','Old Lab','Dr. Old','old-term.xlsx','S0')`).run();
    ctx.db.prepare(`INSERT INTO sources (source_file, type, semester, ingested_at) VALUES ('old-term.xlsx','timetable','S0', datetime('now', '+2 hours'))`).run();
    try {
        const settings = await (await admin('GET', '/settings')).json();
        assert.equal(settings.active_semester, 'S1');
        assert.deepEqual((await ask('when is cps 416')).matches.map((m) => m.day), ['Mon']);
    } finally {
        ctx.db.prepare(`DELETE FROM timetable WHERE source_file = 'old-term.xlsx'`).run();
        ctx.db.prepare(`DELETE FROM sources WHERE source_file = 'old-term.xlsx'`).run();
    }
});

test('a short follow-up that only names a day is read with the conversation, not as a new question', async () => {
    ctx.stub.slots = { course_code: 'CPS416', day: 'Tue' };
    await ask('on Tuesday?', [{ role: 'user', text: 'When is CPS 416?' }, { role: 'assistant', text: 'Monday 08:30.' }]);
    assert.equal(kinds()[0], 'slots', 'the model is given the earlier turns');
    assert.match(ctx.stub.calls[0].body.messages.at(-1).content, /User: When is CPS 416\?/);

    // the same words with no conversation before them are a question of their own
    ctx.stub.calls.length = 0;
    await ask('on Tuesday?');
    assert.ok(!kinds().includes('slots'));
});

test('"Monday to Thursday" covers the days in between', async () => {
    const body = await ask('Show the CS classes Monday to Thursday');
    assert.deepEqual(body.filters.day, ['Mon', 'Tue', 'Wed', 'Thu']);
    assert.deepEqual(codes(body.matches), ['CPS 416', 'CPS 313', 'ICT 202', 'CPS 220']);
});

test('a list that was cut short is not reported as the total', async () => {
    const { scheduleSummary } = await import('../src/chat/compose.js');
    const exam = (i) => ({ kind: 'exam', course_title: `Course ${i}`, date: `2099-01-${String(10 + i).padStart(2, '0')}`, start_time: '09:00' });
    const now = { iso: '2026-11-21' };
    const twenty = Array.from({ length: 20 }, (_, i) => exam(i));
    assert.match(scheduleSummary({ matches: twenty, filters: { exam: true }, exam: true, now, partial: true }), /^Here are the next \*\*20 exams\*\*/);
    assert.match(scheduleSummary({ matches: twenty.slice(0, 4), filters: { exam: true }, exam: true, now, partial: false }), /^There are \*\*4 exams\*\*/);
    const fifty = Array.from({ length: 50 }, (_, i) => ({ course_title: `C${i}`, day: 'Mon', start_time: '08:00' }));
    assert.match(scheduleSummary({ matches: fifty, filters: { day: 'Mon' }, exam: false, now }), /^Here are the first \*\*50 classes on Monday\*\*.*There may be more/);
});

test('an empty reply from the model is answered from the rows and not remembered', async () => {
    answerCache.enabled = true;
    try {
        ctx.stub.answer = '';
        const body = await ask('where is cps 220 held');
        assert.match(body.answer, /\*\*Data Communications and Network\*\* \(CPS 220\): Thursday, 08:30–11:00, Hall A/);
        ctx.stub.answer = 'In Hall A on Thursday.';
        assert.equal((await ask('where is cps 220 held')).answer, 'In Hall A on Thursday.', 'the empty reply was not cached');
    } finally {
        answerCache.enabled = false;
        answerCache.clear();
    }
});

test('a misspelt lecturer is found, and the answer says which name it searched instead', async () => {
    ctx.stub.slots = { lecturer_name: 'Lamin Jobbe' };
    const body = await ask('what does Lamin Jobbe teach');
    assert.deepEqual(codes(body.matches), ['CPS 313', 'CPS 220']);
    assert.equal(body.filters.lecturer, 'Lamin Jobe');
    assert.match(ctx.stub.calls.find((c) => c.kind === 'answer').body.messages[0].content, /Nothing matched the search first asked for \(classes with Lamin Jobbe\)/);
});

test('the public health check does not repeat the provider\'s error text', async () => {
    ctx.stub.busyTimes = 50;
    await ask('What does Lamin Jobe take?');
    const health = await (await fetch(`${ctx.base}/api/health`)).json();
    assert.equal(health.ai.last_error_status, 429);
    assert.equal(health.ai.last_error, undefined);
    assert.doesNotMatch(JSON.stringify(health), /Rate limit reached/);
});

