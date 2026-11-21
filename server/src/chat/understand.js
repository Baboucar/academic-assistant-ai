// Turning a question into a search, and running it.
//
// Most of the work is done by code, not by the model:
//   - simple questions ("What classes are on today?", "When is CPS 313?") are
//     read by quickParse with no model call at all;
//   - for the rest the model extracts the pieces (extractSlots), and code then
//     overrides whatever it can be certain of (days, dates, departments);
//   - if the model is unavailable, whatever quickParse recognised is used.
import { env } from '../env.js';
import { HttpError } from '../errors.js';
import { Queries } from '../db/queries.js';
import { Aliases } from '../db/aliases.js';
import { extractSlots } from '../ai/slotExtractor.js';
import { dateFromText, dayFromISO, dayFromText, daysFromText, nowIn, sortUpcoming } from '../utils/dates.js';

export const CLARIFY_QUESTION = 'Which department do you want?';
export const ALL_DEPARTMENTS = 'All departments';

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Department labels that are also ordinary words: these count only when typed
// in capitals or next to a word like "department".
const ORDINARY_WORDS = new Set(['IT', 'IS', 'AS', 'IN', 'ON', 'AT', 'ED', 'ART', 'ARTS', 'LAW', 'ALL', 'ANY', 'NEW', 'MED', 'BUS']);

/**
 * A department named in the question, from the labels in use in the uploaded
 * files. Never the start of a course code ("ICT 202").
 */
export function deptFromText(question, departments) {
    for (const dept of departments) {
        const d = escapeRegex(dept);
        const asTyped = new RegExp(`(^|[^A-Za-z0-9])${d}(?![A-Za-z0-9])(?!\\s*\\d)`);
        const anyCase = new RegExp(`(^|[^a-z0-9])${d}(?![a-z0-9])(?!\\s*\\d)`, 'i');
        const inContext = new RegExp(
            `(^|[^a-z0-9])${d}\\s+(department|dept|school|classes|class|timetable|schedule|exams?|students)\\b` +
                `|\\b(for|in)\\s+${d}(?![a-z0-9])(?!\\s*\\d)`,
            'i',
        );
        if (asTyped.test(question) || inContext.test(question)) return dept;
        if (!ORDINARY_WORDS.has(dept) && anyCase.test(question)) return dept;
    }
    return null;
}

/** Patterns code can be sure of, used to correct or stand in for the model. */
export function extractHeuristics(question, today3 = null) {
    const q = String(question || '').toLowerCase();
    const named = daysFromText(q);
    return {
        // "today" / "tomorrow" / a weekday
        day: dayFromText(q, today3),
        // "Monday and Tuesday": every day named, so the search covers them all
        days: named.length > 1 ? named : null,
        dept: null, // filled in by buildContext, which knows the departments in use
        title_kw: Aliases.find(question),
        wantsNext: /\bnext\s+(class|lecture|lesson|session)\b|\bwhat(?:'s| is)\s+next\b/.test(q),
        // exam timetable rather than weekly classes
        exam: /\b(exams?|examinations?|papers?)\b/.test(q),
    };
}

// Words that say nothing about what to search for. If a question is only these
// plus things code recognises, the model is not needed to read it.
const FILLER = new Set(
    (
        'a an the is are was were be do does did can could would will shall may i we you me us my our your ' +
        'what whats which who when where how show give list tell get see view check find display ' +
        'have has there any all on for in of at to and or by with from please pls kindly ' +
        'class classes lecture lectures lesson lessons course courses schedule schedules timetable timetables ' +
        'teach teaches teaching taught lecturer lecturers held hold holding take takes taking place ' +
        'time times start starts starting begin begins date dates venue department dept students student ' +
        'this week upcoming coming scheduled happening going full whole entire it s like want need know'
    ).split(' '),
);
// ...except that these make a question depend on the conversation so far
const REFERS_BACK = /\b(it|that|those|them|they|there|same|also|about|instead|again|him|her|his)\b/;
// a word before three digits that is not a course prefix ("room 101")
const NOT_A_COURSE_PREFIX = new Set(['room', 'lab', 'hall', 'year', 'at', 'in', 'on', 'by', 'to', 'of', 'no', 'level', 'block', 'the']);

/**
 * Read a question with code only.
 * Returns { slots, found, complete }: `found` is true when something searchable
 * was recognised; `complete` is true when nothing else in the question needs
 * interpreting, so the model call can be skipped.
 */
export function quickParse(question, { departments = [], hasHistory = false } = {}) {
    const text = String(question || '');
    let rest = ` ${text.toLowerCase()} `;
    const take = (pattern) => {
        const before = rest;
        rest = rest.replace(pattern, ' ');
        return rest !== before;
    };

    const slots = {
        intent: 'generic', course_code: null, title_kw: null, dept: null, day: null,
        date_iso: null, time: null, lecturer_name: null, venue: null, exam: false,
    };

    // course code: "CPS 313", "cps313"
    const code = rest.match(/(^|[^a-z0-9])([a-z]{2,4})\s?(\d{3})(?![a-z0-9])/);
    if (code && !NOT_A_COURSE_PREFIX.has(code[2])) {
        slots.course_code = `${code[2]}${code[3]}`.toUpperCase();
        rest = rest.replace(code[0], ' ');
    }

    const alias = Aliases.match(text);
    if (alias) {
        slots.title_kw = alias.title;
        take(new RegExp(escapeRegex(alias.text.toLowerCase())));
    }

    const dept = deptFromText(text, departments);
    if (dept) {
        slots.dept = dept;
        take(new RegExp(`(^|[^a-z0-9])${escapeRegex(dept.toLowerCase())}(?![a-z0-9])`));
    }

    if (take(/\bnext\s+(class|lecture|lesson|session)\b/g)) slots.intent = 'next_class';
    if (take(/\b(exams?|examinations?|papers?)\b/g)) slots.exam = true;

    const days = daysFromText(text);
    const relative = /\b(day after tomorrow|tomorrow|tmrw|tmr|today|tonight|yesterday|this (?:morning|afternoon|evening))\b/g;
    const hasRelative = relative.test(rest);
    take(/\b(mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|mon|tues?|weds|thu(?:rs?)?|fri)\b/g);
    take(relative);

    const leftover = rest.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !FILLER.has(w));
    const found = Boolean(
        slots.course_code || slots.title_kw || slots.dept || slots.exam || slots.intent === 'next_class' || days.length || hasRelative,
    );
    // A follow-up needs the conversation, so the model reads it: one that points back
    // ("what about it on Tuesday?"), one that carries on ("and the exam?"), or one
    // that names no course, department or day of its own ("when is the exam?").
    const lower = text.toLowerCase();
    // ...or one that is only a day or a department ("on Tuesday?", "CS"), which changes
    // one thing about the question before it
    const namesCourse = Boolean(slots.course_code || slots.title_kw);
    const anchored = namesCourse || Boolean(slots.dept || days.length || hasRelative);
    const brief = lower.split(/\s+/).filter(Boolean).length <= 4;
    const followUp =
        hasHistory &&
        (REFERS_BACK.test(lower) || /^\s*(and|also|then|but|or|ok|okay|so)\b/.test(lower) || !anchored || (!namesCourse && brief));
    return { slots, found, complete: found && leftover.length === 0 && !followUp };
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

// Try to derive a lecturer name from other columns when the lecturer column is empty.
// Many PDFs embed the lecturer inside the course title or even the course code cell.
function deriveLecturerFallback(row) {
    const fields = [row.lecturer, row.course_title, row.course_code, row.venue].filter(Boolean).join('  ');
    if (!fields) return '';
    const honorific = '(Mr\\.|Mrs\\.|Ms\\.|Dr\\.|Prof\\.)\\s*';
    const nameCore = '[A-Z][a-z]+';
    const m = fields.match(new RegExp(`${honorific}?${nameCore}(?:\\s+${nameCore}){1,3}`));
    return m ? m[0].replace(/\s{2,}/g, ' ').trim() : '';
}

const isSet = (value) => (Array.isArray(value) ? value.length > 0 : Boolean(value));
/** The filters that were actually applied, without the empty ones. */
export const appliedFilters = (filters) => Object.fromEntries(Object.entries(filters || {}).filter(([, v]) => isSet(v)));

/**
 * Run a list of searches from most to least specific and keep the first that
 * finds something. Returns { matches, filters, asked }: `filters` is the search
 * that produced the rows, and `asked` is the original one when they differ, so
 * the answer can say what was and was not found.
 */
function firstMatch(original, attempts, run) {
    for (const attempt of attempts) {
        const matches = run(attempt);
        if (matches.length) {
            const relaxed = attempt !== original;
            return { matches, filters: attempt, asked: relaxed ? original : null };
        }
    }
    return { matches: [], filters: original, asked: null };
}

/**
 * What to tell the student was not found, when the rows come from a looser or
 * corrected search. Dropping a course code the model only guessed is not worth
 * mentioning (the title was what they asked for); a lecturer's name that had
 * to be changed to find anyone is.
 */
function disclose(found, original, askedLecturer) {
    if (!found.matches.length) return null;
    const used = found.filters;
    if (askedLecturer && used.lecturer && askedLecturer.toLowerCase() !== String(used.lecturer).toLowerCase()) {
        return { ...(found.asked || original), lecturer: askedLecturer };
    }
    if (!found.asked) return null;
    const onlyGuessedCode = found.asked.course && !used.course && used.title &&
        Object.keys(found.asked).every((key) => key === 'course' || JSON.stringify(found.asked[key] ?? null) === JSON.stringify(used[key] ?? null));
    return onlyGuessedCode ? null : found.asked;
}

/** Class questions: search the weekly timetable. */
function classContext(question, { slots, heur, now }) {
    const nextClass = slots.intent === 'next_class' || heur.wantsNext;
    const askedLecturer = slots.lecturer_name || null;
    const filters = {
        course: slots.course_code || null,
        // a registered alias first, then initials of a loaded title ("OS" -> "Operating Systems")
        title: Queries.titleForInitials(Aliases.canonical(slots.title_kw || heur.title_kw || null)),
        // spelled as the timetable spells it, when the student was a letter or two off
        lecturer: Queries.correctLecturer(slots.lecturer_name) || null,
        dept: slots.dept || heur.dept || null,
        // A day named in the question itself is certain; otherwise trust the model
        // (which may have carried it over from an earlier turn). "Next class" looks
        // across the whole week unless the user named a day.
        day: heur.days || heur.day || (nextClass ? null : slots.day || dayFromISO(slots.date_iso)),
        time: slots.time || null,
        venue: slots.venue || null,
    };

    // With no filters at all (small talk, off-topic) there is nothing to look up
    const searched = Object.values(filters).some(isSet);
    let found = { matches: [], filters, asked: null };
    if (searched) {
        const attempts = [filters];
        // a course code from the model may be a guess: fall back to the title
        if (filters.course && filters.title) attempts.push({ ...filters, course: null });
        found = firstMatch(filters, attempts, (f) =>
            Queries.flexibleSearch({
                course: f.course, titleKw: f.title, lecturerKw: f.lecturer, day3: f.day, dept: f.dept, time: f.time, venueKw: f.venue,
            }),
        );
        // last resort: the title on its own
        if (!found.matches.length && filters.title) {
            const matches = Queries.fuzzyByTitle(filters.title);
            if (matches.length) {
                const used = { course: null, title: filters.title, lecturer: null, dept: null, day: null, time: null, venue: null };
                const same = Object.keys(used).every((k) => !isSet(filters[k]) || k === 'title');
                found = { matches, filters: same ? filters : used, asked: same ? null : filters };
            }
        }
    }

    let matches = found.matches.map((row) => {
        if (row.lecturer && String(row.lecturer).trim()) return row;
        const guess = deriveLecturerFallback(row);
        return guess ? { ...row, lecturer: guess } : row;
    });
    // "next class" shows the soonest few, not every sitting
    const total = matches.length;
    if (nextClass && matches.length) matches = sortUpcoming(matches, now).slice(0, 5);

    return {
        filters: found.filters,
        asked: disclose(found, filters, askedLecturer),
        matches, searched, nextClass, exam: false,
        partial: nextClass && total > matches.length,
    };
}

/** Exam questions: search the exam timetable, upcoming sittings first. */
function examContext(question, { slots, heur, now }) {
    // "tomorrow" is certain. A date from the model counts only when the question
    // itself has a number in it: otherwise the model is echoing a date from an
    // earlier answer, which would wrongly narrow the search.
    const date = dateFromText(question, now.iso) || (/\d/.test(question) ? slots.date_iso : null) || null;
    const askedLecturer = slots.lecturer_name || null;
    const filters = {
        exam: true,
        course: slots.course_code || null,
        // a registered alias first, then initials of a loaded title ("OS" -> "Operating Systems")
        title: Queries.titleForInitials(Aliases.canonical(slots.title_kw || heur.title_kw || null)),
        lecturer: Queries.correctLecturer(slots.lecturer_name) || null,
        dept: slots.dept || heur.dept || null,
        date,
        // a weekday only narrows the search when no exact date is known
        day: date ? null : heur.days || dayFromText(question, null) || slots.day || null,
        venue: slots.venue || null,
    };
    const isNarrow = (f) => Object.entries(f).some(([key, value]) => key !== 'exam' && isSet(value));
    const only = (keys) => ({ exam: true, course: null, title: null, lecturer: null, dept: null, date: null, day: null, venue: null, ...keys });

    // Most specific first. A course code may be a guess, and the department and
    // day are hints, so they are dropped one at a time if nothing matches.
    const attempts = [filters];
    if (filters.course && filters.title) attempts.push({ ...filters, course: null });
    if (filters.dept) attempts.push({ ...filters, dept: null });
    if (filters.course || filters.title) {
        attempts.push(only({ course: filters.course, title: filters.title }));
        if (filters.course && filters.title) attempts.push(only({ title: filters.title }));
    } else if (filters.lecturer) {
        attempts.push(only({ lecturer: filters.lecturer }));
    }

    const run = (f) => {
        const narrowed = isNarrow(f);
        const search = (fromISO, limit) =>
            Queries.searchExams({
                course: f.course, titleKw: f.title, lecturerKw: f.lecturer, dept: f.dept, dateISO: f.date, day3: f.day, venueKw: f.venue, fromISO, limit,
            });
        // "Show the exam timetable" with nothing else: the next exams, not all of them
        const upcoming = search(now.iso, narrowed ? 50 : 20);
        // nothing still to come: maybe it has already been written
        return upcoming.length || !narrowed ? upcoming : search(null, 50);
    };
    // when a filter had to be dropped, `asked` keeps the original so the answer can say so
    const { matches: rows, filters: used, asked } = firstMatch(filters, attempts, run);

    const matches = rows.map((row) => ({ ...row, day: dayFromISO(row.date), kind: 'exam' }));
    return {
        filters: used,
        asked: disclose({ matches: rows, filters: used, asked }, filters, askedLecturer),
        matches, searched: true, nextClass: false, exam: true,
        // an unnarrowed "show the exams" lists only the next 20
        partial: !isNarrow(used) && rows.length >= 20,
    };
}

/**
 * Turn a question (plus the earlier turns) into a search and its rows.
 *
 * Returns {
 *   question, history   the question actually answered (a department reply re-asks the earlier one)
 *   slots               what was extracted
 *   filters             the search that produced the rows
 *   asked               the original search, when it had to be relaxed to find anything (else null)
 *   matches             the rows
 *   searched            false when nothing searchable was recognised (small talk, or not understood)
 *   nextClass, exam, now
 *   clarify             departments to choose from, when the assistant should ask instead of answer
 *   degraded            true when the model was unavailable and code alone read the question
 * }
 * `meter.modelCalls` is increased for each model call made.
 */
export async function buildContext(askedQuestion, askedHistory = [], { signal, meter = { modelCalls: 0 } } = {}) {
    const now = nowIn(env.TIMEZONE);
    const departments = Queries.departments();

    // "CS" in reply to "Which department do you want?" re-asks the earlier question for CS
    const reply = departmentReply(askedQuestion, askedHistory, departments);
    const question = reply ? reply.question : askedQuestion;
    const history = reply ? reply.history : askedHistory;

    const quick = quickParse(question, { departments, hasHistory: history.length > 0 });
    let slots = quick.slots;
    let degraded = false;
    if (!quick.complete) {
        try {
            meter.modelCalls++;
            slots = await extractSlots(question, { history: history.slice(-6), now, signal });
        } catch (e) {
            // the provider is busy or down: carry on with what code recognised, if anything
            if (e?.name === 'AbortError' || !(e instanceof HttpError) || !quick.found) throw e;
            degraded = true;
        }
    }

    const heur = extractHeuristics(question, now.day3);
    heur.dept = reply?.dept || deptFromText(question, departments);
    if (reply?.dept) slots = { ...slots, dept: reply.dept };

    const context = heur.exam || slots.exam ? examContext(question, { slots, heur, now }) : classContext(question, { slots, heur, now });
    // not on top of a search that already had to be loosened: one thing at a time
    const clarify = reply?.all || context.asked ? null : departmentsToAskAbout(context.filters, context.matches, departments);
    return { ...context, question, history, slots, now, clarify, degraded };
}
