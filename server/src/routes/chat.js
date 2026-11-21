// server/src/routes/chat.js
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../env.js';
import { HttpError, wrap } from '../errors.js';
import { Queries } from '../db/queries.js';
import { extractSlots } from '../ai/slotExtractor.js';
import { complete, completeStream } from '../ai/groq.js';
import { dateFromText, dayFromISO, dayFromText, daysFromText, nowIn, sortUpcoming } from '../utils/dates.js';

export const chat = Router();

const NOT_FOUND = 'I could not find it.';
// From this many rows on, the app draws them as a schedule and the model only summarises
const SCHEDULE_FROM = 3;

const Body = z.object({
    question: z.string().trim().min(1, 'question is required').max(500, 'question is too long'),
    // Earlier turns, oldest first, so follow-ups like "What about Tuesday?" make sense
    history: z
        .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(8000) }))
        .max(20)
        .optional()
        .default([]),
});

// Try to derive a lecturer name from other columns when the lecturer column is empty.
// Many PDFs embed the lecturer inside the course title or even the course code cell.
function deriveLecturerFallback(row) {
    const fields = [row.lecturer, row.course_title, row.course_code, row.venue]
        .filter(Boolean)
        .join('  ');
    if (!fields) return '';

    // Common honorifics and a simple proper-name detector (2–4 capitalized words)
    const honorific = '(Mr\\.|Mrs\\.|Ms\\.|Dr\\.|Prof\\.)\\s*';
    const nameCore = '[A-Z][a-z]+';
    const namePat = new RegExp(`${honorific}?${nameCore}(?:\\s+${nameCore}){1,3}`);
    const m = fields.match(namePat);
    if (m) return m[0].replace(/\s{2,}/g, ' ').trim();
    return '';
}

// Map common acronyms/aliases to canonical course title keywords
function normalizeTitleKw(s) {
    if (!s) return s;
    const t = String(s).trim().toUpperCase();
    // Add more aliases here as needed
    if (t === 'AI') return 'Artificial Intelligence';
    // Data Communications and Network family
    if (t === 'DCN') return 'Data Communications and Network';
    // Normalize common DCN phrasing variants (plural/ampersand)
    if (/^DATA\s+COMMUNICATIONS?\s*(?:AND|&)\s*NETWORKS?$/i.test(s)) {
        return 'Data Communications and Network';
    }
    if (/^DATA\s+COMMUNICATIONS?\s*(?:AND|&)\s*NETWORKING$/i.test(s)) {
        return 'Data Communications and Network';
    }
    // If user writes just the short form of the course title, normalize to canonical
    if (t === 'DATA COMMUNICATIONS' || t === 'DATA COMMUNICATION') {
        return 'Data Communications and Network';
    }
    if (t === 'DATA COMMUNICATIONS AND NETWORKING' || t === 'DATA COMMUNICATION AND NETWORK') {
        return 'Data Communications and Network';
    }
    return s;
}

// Known acronym → full title mapping for better answers
const ACRONYM_MAP = {
    AI: 'Artificial Intelligence',
    DCN: 'Data Communications and Network',
};

// Lightweight heuristic parser to backfill slots when the LLM misses them
export function extractHeuristics(question, today3 = null) {
    const q = String(question || '').toLowerCase();

    // day detection, including "today" / "tomorrow"
    const day = dayFromText(q, today3);

    // department detection ("CS", but not the prefix of a course code like "ICT 202")
    let dept = null;
    const mDept = q.match(/\b(cs|ins|ict|tel|cps)\b(?!\s*\d)/i);
    if (mDept) dept = mDept[1].toUpperCase();

    // title keyword detection (common aliases)
    let title_kw = null;
    if (/\bai\b/.test(q) || /artificial\s+intelligence/i.test(question)) {
        title_kw = 'Artificial Intelligence';
    } else if (
        /(data\s+communication(s)?\s*(?:and|&)\s*network(s|ing)?)/i.test(question) ||
        /\bDCN\b/i.test(question)
    ) {
        title_kw = 'Data Communications and Network';
    }

    const wantsNext = /\bnext\s+(class|lecture|lesson|session)\b|\bwhat(?:'s| is)\s+next\b/.test(q);

    // exam timetable rather than weekly classes
    const exam = /\b(exams?|examinations?|papers?)\b/.test(q);

    // "Monday and Tuesday": every day named, so the search covers them all
    const named = daysFromText(q);
    const days = named.length > 1 ? named : null;

    return { day, days, dept, title_kw, wantsNext, exam };
}

// ---- Asking which department ----
// A broad question ("What classes are on tomorrow?") can match several
// departments or schools. Rather than mix them, the assistant asks which one.
const CLARIFY_QUESTION = 'Which department do you want?';
const ALL_DEPARTMENTS = 'All departments';

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A department named in the question, from the labels actually in use. A label
 * can be an ordinary word ("LAW", "IT"), so it counts only when typed in capitals
 * or next to a word like "department" or "classes" - and never as the start of
 * a course code ("ICT 202").
 */
function deptFromText(question, departments) {
    for (const dept of departments) {
        const d = escapeRegex(dept);
        const asTyped = new RegExp(`(^|[^A-Za-z0-9])${d}(?![A-Za-z0-9])(?!\\s*\\d)`);
        const inContext = new RegExp(
            `(^|[^a-z0-9])${d}\\s+(department|dept|school|classes|class|timetable|schedule|exams?|students)\\b` +
                `|\\b(for|in)\\s+${d}(?![a-z0-9])(?!\\s*\\d)`,
            'i',
        );
        if (asTyped.test(question) || inContext.test(question)) return dept;
    }
    return null;
}

/**
 * Is this message the reply to "Which department do you want?" If so, return
 * the question it belongs to and the choice: { question, history, dept | all }.
 */
function departmentReply(question, history, departments) {
    const lastAssistant = [...history].reverse().find((t) => t.role === 'assistant');
    if (!lastAssistant || !lastAssistant.text.includes(CLARIFY_QUESTION)) return null;
    const asked = history.map((t) => t.role).lastIndexOf('user');
    if (asked === -1) return null;

    const said = question.trim().replace(/[.!?]+$/, '').replace(/\s+department$/i, '').toUpperCase();
    const original = { question: history[asked].text.slice(0, 500), history: history.slice(0, asked) };
    if (/^(ALL|ALL DEPARTMENTS|ALL OF THEM|EVERYTHING|ANY|BOTH)$/.test(said)) return { ...original, all: true };
    const dept = departments.find((d) => d === said);
    return dept ? { ...original, dept } : null;
}

/** Departments among the rows, when the question did not narrow things down itself. */
function departmentsToAskAbout(filters, matches, departments) {
    const narrowed = ['course', 'title', 'lecturer', 'dept', 'venue'].some((key) => filters[key]);
    if (narrowed) return null;
    const found = [...new Set(matches.map((row) => String(row.dept || '').trim().toUpperCase()))].filter((d) =>
        departments.includes(d),
    );
    return found.length > 1 ? found : null;
}

/**
 * Turn a question (plus the earlier turns) into search filters and matching rows.
 * Returns { question, history, slots, filters, matches, now, nextClass, exam, clarify }.
 * `clarify` is set (to a list of departments) when the assistant should ask
 * which one is meant instead of answering.
 */
export async function buildContext(askedQuestion, askedHistory = [], { signal } = {}) {
    const now = nowIn(env.TIMEZONE);
    const departments = Queries.departments();

    // "CS" in reply to "Which department do you want?" re-asks the earlier question for CS
    const reply = departmentReply(askedQuestion, askedHistory, departments);
    const question = reply ? reply.question : askedQuestion;
    const history = reply ? reply.history : askedHistory;

    // 1) Extract slots with the LLM, 1b) heuristics for patterns it may miss
    const slots = await extractSlots(question, { history: history.slice(-6), now, signal });
    const heur = extractHeuristics(question, now.day3);
    heur.dept = reply?.dept || heur.dept || deptFromText(question, departments);
    if (reply?.dept) slots.dept = reply.dept;

    const context =
        heur.exam || slots.exam
            ? // Exam questions are answered from the exam timetable, which has dates, not weekdays
              examContext(question, { slots, heur, now })
            : classContext(question, { slots, heur, now });

    const ask = reply?.all ? null : departmentsToAskAbout(context.filters, context.matches, departments);
    return { ...context, question, history, clarify: ask };
}

/** Class questions: search the weekly timetable. */
function classContext(question, { slots, heur, now }) {

    // 2) Normalise slots for our query layer
    const nextClass = slots.intent === 'next_class' || heur.wantsNext;
    const filters = {
        course: slots.course_code || null,
        title: normalizeTitleKw(slots.title_kw || heur.title_kw || null),
        lecturer: slots.lecturer_name || null,
        dept: slots.dept || heur.dept || null,
        // A day named in the question itself is certain; otherwise trust the model
        // (which may have carried it over from an earlier turn). "Next class" looks
        // across the whole week unless the user named a day.
        day: heur.days || heur.day || (nextClass ? null : slots.day || dayFromISO(slots.date_iso)),
        time: slots.time || null,
        venue: slots.venue || null,
    };

    // 3) Query timetable. With no filters at all (small talk, off-topic) there is
    // nothing to look up: do not hand the model an arbitrary page of rows.
    let matches = [];
    if (Object.values(filters).some(Boolean)) {
        const search = (f) =>
            Queries.flexibleSearch({
                course: f.course,
                titleKw: f.title,
                lecturerKw: f.lecturer,
                day3: f.day,
                dept: f.dept,
                time: f.time,
                venueKw: f.venue,
            });

        matches = search(filters);
        // The code may be a guess (e.g. "AI" -> CPS416): retry on the title, keeping day/dept
        if (!matches.length && filters.course && filters.title) {
            matches = search({ ...filters, course: null });
        }
        // Last resort: fuzzy title match on its own
        if (!matches.length && filters.title) {
            matches = Queries.fuzzyByTitle(filters.title);
        }
    }

    // Enrich missing lecturer from other fields where possible
    matches = matches.map((r) => {
        if (!r.lecturer || String(r.lecturer).trim() === '') {
            const guess = deriveLecturerFallback(r);
            if (guess) return { ...r, lecturer: guess };
        }
        return r;
    });

    if (nextClass && matches.length) {
        matches = sortUpcoming(matches, now).slice(0, 5);
    }

    return { slots, filters, matches, now, nextClass, exam: false };
}

/** Exam questions: search the exam timetable, upcoming sittings first. */
function examContext(question, { slots, heur, now }) {
    // "tomorrow" is certain. A date from the model counts only when the question
    // itself has a number in it: otherwise the model is echoing a date from an
    // earlier answer, which would wrongly narrow the search.
    const date = dateFromText(question, now.iso) || (/\d/.test(question) ? slots.date_iso : null) || null;
    const filters = {
        exam: true,
        course: slots.course_code || null,
        title: normalizeTitleKw(slots.title_kw || heur.title_kw || null),
        lecturer: slots.lecturer_name || null,
        dept: slots.dept || heur.dept || null,
        date,
        // a weekday only narrows the search when no exact date is known
        day: date ? null : heur.days || dayFromText(question, null) || slots.day || null,
        venue: slots.venue || null,
    };

    const search = (f, fromISO, limit) =>
        Queries.searchExams({
            course: f.course,
            titleKw: f.title,
            lecturerKw: f.lecturer,
            dept: f.dept,
            dateISO: f.date,
            day3: f.day,
            venueKw: f.venue,
            fromISO,
            limit,
        });

    const narrowed = Object.entries(filters).some(([key, value]) => key !== 'exam' && value);
    // Most specific first. The code may be a guess ("AI" -> CPS416), and the
    // department and day are only hints, so they are dropped if nothing matches.
    const attempts = [filters];
    if (filters.course && filters.title) attempts.push({ ...filters, course: null });
    if (filters.course || filters.title) attempts.push({ course: filters.course, title: filters.title });
    else if (filters.lecturer) attempts.push({ lecturer: filters.lecturer });
    if (filters.course && filters.title) attempts.push({ title: filters.title });

    let matches = [];
    for (const attempt of attempts) {
        // "Show the exam timetable" with nothing else: the next exams, not all of them
        matches = search(attempt, now.iso, narrowed ? 50 : 20);
        // nothing still to come: maybe it has already been written
        if (!matches.length && narrowed) matches = search(attempt, null, 50);
        if (matches.length) break;
    }

    matches = matches.map((row) => ({ ...row, day: dayFromISO(row.date), kind: 'exam' }));
    return { slots, filters, matches, now, nextClass: false, exam: true };
}

function answerMessages(question, history, { matches, filters, now, nextClass, exam }) {
    const asSchedule = matches.length >= SCHEDULE_FROM;
    const searched = Object.fromEntries(Object.entries(filters || {}).filter(([, value]) => value));
    const system = `
You are the UTG Academic Assistant, a timetable assistant for the University of The Gambia.

You receive:
- The conversation so far and the user's latest question.
- A JSON ARRAY of matching timetable rows. Class rows have dept, course_code, course_title, day,
  start_time, end_time, venue, lecturer. Exam rows have "kind": "exam" and a "date" (YYYY-MM-DD)
  instead of a day.

Rules:
- Answer timetable questions ONLY from the data in this JSON array.
- Do NOT invent any course, time, venue or lecturer that is not present in the JSON data.
- If the array is empty and the user asked about a class, course, lecturer, venue or schedule,
  reply exactly: "${NOT_FOUND}" You may add one short sentence suggesting they check the
  spelling or try the course code.
- If the array is empty because the user is greeting you, thanking you or asking what you can do,
  reply briefly and say you can answer questions about courses, lecturers, venues and schedules.
- If the user asks "how many", count the rows in the array and state that count explicitly,
  optionally followed by a short list.
- The rows are everything the search found for the filters listed with them. Say that something does
  not exist (no class on a day, no exam for a course) only when those filters covered it; never guess
  about a day, course or department the search did not look at.
- Otherwise give a concise answer including day, time range, venue and lecturer whenever relevant.
- Resolve words like "it", "that course" or "what about Tuesday" from the conversation.
- When the user uses an acronym, expand it using the glossary below; prefer the full course title.
  For example, say "Artificial Intelligence" instead of just "AI".
${nextClass ? '- The rows are ordered by how soon they start from now: the first row is the next class.\n' : ''}${
        exam
            ? '- The user is asking about EXAMS. The rows are exam sittings ordered by date, soonest first. Call them exams, and give each date written out (for example "Monday 12 January 2026") with the time range and venue. If an exam date is before today, say it has already taken place.\n'
            : ''
    }
Formatting:
${
        asSchedule
            ? `- The app shows these ${matches.length} rows as a schedule directly under your reply, with every day, time, venue and lecturer.
  Do NOT list or repeat the rows. Reply with one or two short sentences only: say how many there are
  and what they cover (for example which days, or the first and last date), and answer anything
  specific that was asked (a count, the first one, the next one, who teaches most of them).
- Use **bold** sparingly, for the one or two key facts.`
            : `- Use light Markdown. Put course titles and time ranges in **bold**.
- For two classes, use a bullet list with one class per line.`
    }
- No tables, no code blocks, no headings.

Acronym glossary (authoritative):
${JSON.stringify(ACRONYM_MAP, null, 2)}
`;

    const rows = matches.map(({ id, source_file, ...row }) => row);
    return [
        { role: 'system', content: system },
        ...history.slice(-6).map((t) => ({ role: t.role, content: String(t.text).slice(0, 1200) })),
        {
            role: 'user',
            content:
                `Question: ${question}\n\n` +
                `Today is ${now.weekday} ${now.iso}, ${now.time}.\n\n` +
                // so the model knows what the rows do and do not cover
                `The timetable was searched with these filters: ${JSON.stringify(searched)}.\n` +
                `Matches JSON (array of ${rows.length} rows):\n${JSON.stringify(rows, null, 2)}`,
        },
    ];
}

const SSE_HEADERS = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // tell nginx not to buffer the stream
};

const DAY_NAMES = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };

/** "There are classes on Sunday in 2 departments: CS and INS. Which department do you want?" */
function clarifyText({ clarify, filters, exam }) {
    const list = clarify.length === 2 ? clarify.join(' and ') : `${clarify.slice(0, -1).join(', ')} and ${clarify.at(-1)}`;
    const days = [].concat(filters.day || []).map((d) => DAY_NAMES[d]).filter(Boolean);
    const when = days.length ? ` on ${days.join(' and ')}` : '';
    return `There are ${exam ? 'exams' : 'classes'}${when} in ${clarify.length} departments: ${list}. ${CLARIFY_QUESTION}`;
}

/**
 * POST /api/chat           -> { answer, slots, filters, matches, schedule }
 * POST /api/chat?stream=1  -> Server-Sent Events:
 *   { event: 'meta', slots, filters, matches, schedule, clarify? }   once, before the answer
 *   { event: 'chunk', text }                     as the model writes
 *   { event: 'error', message }                  if the model fails mid-answer
 *   { event: 'done' }                            at the end
 */
chat.post(
    '/chat',
    wrap(async (req, res) => {
        const parsed = Body.safeParse(req.body || {});
        if (!parsed.success) {
            throw new HttpError(400, parsed.error.issues[0]?.message || 'Invalid request');
        }
        const { question, history } = parsed.data;
        const isStream = ['1', 'true'].includes(String(req.query.stream || '').toLowerCase());

        // Stop paying for tokens nobody will read if the client goes away
        const aborter = new AbortController();
        res.on('close', () => {
            if (!res.writableFinished) aborter.abort();
        });
        const { signal } = aborter;

        let context;
        try {
            context = await buildContext(question, history, { signal });
        } catch (e) {
            if (e?.name === 'AbortError') return;
            throw e;
        }
        const { slots, filters } = context;

        // Several departments match and none was named: ask, without spending a model call
        const clarify = context.clarify ? { options: [...context.clarify, ALL_DEPARTMENTS] } : null;
        const matches = clarify ? [] : context.matches;
        // tells the client to show the rows as a schedule rather than tucked away
        const schedule = matches.length >= SCHEDULE_FROM;

        if (clarify) {
            const answer = clarifyText(context);
            if (!isStream) return res.json({ answer, slots, filters, matches, schedule, clarify });
            res.writeHead(200, SSE_HEADERS);
            res.write(`data: ${JSON.stringify({ event: 'meta', slots, filters, matches, schedule, clarify })}\n\n`);
            res.write(`data: ${JSON.stringify({ event: 'chunk', text: answer })}\n\n`);
            res.write(`data: ${JSON.stringify({ event: 'done' })}\n\n`);
            return res.end();
        }

        const messages = answerMessages(context.question, context.history, context);

        if (!isStream) {
            try {
                const answer = (await complete(messages, { signal })) || NOT_FOUND;
                return res.json({ answer, slots, filters, matches, schedule });
            } catch (e) {
                if (e?.name === 'AbortError') return;
                throw e;
            }
        }

        res.writeHead(200, SSE_HEADERS);
        const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

        send({ event: 'meta', slots, filters, matches, schedule });
        try {
            let wrote = false;
            for await (const text of completeStream(messages, { signal })) {
                wrote = true;
                send({ event: 'chunk', text });
            }
            if (!wrote) send({ event: 'chunk', text: NOT_FOUND });
            send({ event: 'done' });
        } catch (e) {
            if (e?.name !== 'AbortError' && !signal.aborted) {
                if (!(e instanceof HttpError)) console.error(e);
                send({
                    event: 'error',
                    message: e instanceof HttpError ? e.message : 'The answer was interrupted. Please try again.',
                });
            }
        } finally {
            res.end();
        }
    }),
);
