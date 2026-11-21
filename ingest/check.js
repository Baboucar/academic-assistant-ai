// The one gate every reader's output passes through before it replaces what is
// loaded: values are put into one form (Mon..Sun, HH:MM, YYYY-MM-DD) and rows
// that cannot be used are left out with a reason, instead of being stored as
// they came and silently never matching a search.
import { toIsoDate, toTime } from './parsers/excel.js';

const DAYS = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
// One cell should never be a paragraph; anything longer is a misread
const MAX_CELL = 300;

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_CELL);

/** "Monday", "MON", "Tues", "mondays" -> "Mon"; anything else -> null */
export function toDay(value) {
    const word = String(value ?? '').trim().toLowerCase().replace(/[^a-z]/g, '');
    if (!/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*$/.test(word)) return null;
    const full = { mon: 'monday', tue: 'tuesday', wed: 'wednesday', thu: 'thursday', fri: 'friday', sat: 'saturday', sun: 'sunday' }[word.slice(0, 3)];
    // "mon", "tues", "thurs", "monday", "mondays"
    return full.startsWith(word.replace(/s$/, '')) || word === `${full}s` ? DAYS[word.slice(0, 3)] : null;
}

const isRealDate = (iso) => /^\d{4}-\d{2}-\d{2}$/.test(iso) && toIsoDate(iso) === iso;

const CHECKS = {
    // [dept, course_code, course_title, day, start_time, end_time, venue, lecturer]
    timetable(row) {
        if (row.length !== 8) return { reason: `expected 8 values, got ${row.length}` };
        const [dept, code, title, day, start, end, venue, lecturer] = row;
        if (!clean(code) && !clean(title)) return { reason: 'no course code or title' };
        const d = toDay(day);
        if (!d) return { reason: `"${clean(day)}" is not a day of the week` };
        const from = toTime(start);
        if (!from) return { reason: `start time "${clean(start)}" could not be read` };
        const to = clean(end) ? toTime(end) : '';
        if (to === null) return { reason: `end time "${clean(end)}" could not be read` };
        return { row: [clean(dept) || 'UNKNOWN', clean(code), clean(title), d, from, to, clean(venue), clean(lecturer)] };
    },

    // [dept, course_code, course_title, date, start_time, end_time, venue, lecturer]
    exams(row) {
        if (row.length !== 8) return { reason: `expected 8 values, got ${row.length}` };
        const [dept, code, title, date, start, end, venue, lecturer] = row;
        if (!clean(code) && !clean(title)) return { reason: 'no course code or title' };
        const iso = toIsoDate(date);
        if (!iso || !isRealDate(iso)) return { reason: `date "${clean(date)}" could not be read` };
        const from = clean(start) ? toTime(start) : '';
        const to = clean(end) ? toTime(end) : '';
        if (from === null || to === null) return { reason: `time "${clean(from === null ? start : end)}" could not be read` };
        return { row: [clean(dept) || 'UNKNOWN', clean(code), clean(title), iso, from, to, clean(venue), clean(lecturer)] };
    },

    // [date, title, description]
    calendar(row) {
        if (row.length !== 3) return { reason: `expected 3 values, got ${row.length}` };
        if (!clean(row[1])) return { reason: 'no title' };
        return { row: [clean(row[0]), clean(row[1]), String(row[2] ?? '').slice(0, 4000)] };
    },

    // [date, title, body]
    notices(row) {
        if (row.length !== 3) return { reason: `expected 3 values, got ${row.length}` };
        if (!clean(row[1])) return { reason: 'no title' };
        return { row: [clean(row[0]), clean(row[1]), String(row[2] ?? '').slice(0, 20000)] };
    },
};

/**
 * Check and tidy the rows a reader produced.
 * Returns { rows: the usable ones, rejected: [{ index, reason }] }.
 */
export function checkRows(type, rows) {
    const check = CHECKS[type];
    if (!check) throw new Error(`Unknown source type: ${type}`);
    const accepted = [];
    const rejected = [];
    (rows || []).forEach((row, index) => {
        const result = Array.isArray(row) ? check(row) : { reason: 'not a row' };
        if (result.row) accepted.push(result.row);
        else rejected.push({ index, reason: result.reason });
    });
    return { rows: accepted, rejected };
}

/**
 * Should a file's new rows be refused because they would wipe out most of what
 * is loaded from it? (An admin can replace them anyway with "force".)
 */
export function looksLikeDataLoss(before, after) {
    if (before === 0) return false;
    if (after === 0) return true;
    return before >= 10 && after < before * 0.5;
}
