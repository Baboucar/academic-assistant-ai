// Saving things out of the app: a conversation as text, and the classes or
// exams behind an answer as a calendar file (.ics) or a spreadsheet (.csv).
import { dayName, examDateLong, groupSchedule, timeRange } from '@/lib/format';
import { mdToPlain } from '@/lib/markdown';

/** A weekly class is repeated in the calendar for this many weeks (about one semester). */
export const CLASS_WEEKS = 15;

const isExam = (row) => row?.kind === 'exam' || Boolean(row?.date);
const courseName = (row) => [row.course_code, row.course_title].filter(Boolean).join(' ').trim() || 'Class';

// ---------------------------------------------------------------------- answer

/**
 * An answer as plain text, for Copy and Read aloud. When the rows are shown as a
 * schedule the answer text only summarises them, so the schedule is added.
 */
export function answerToText(message) {
    const text = mdToPlain(message?.text || '');
    if (!message?.schedule || !message.sources?.length) return text;

    const lines = [];
    for (const group of groupSchedule(message.sources)) {
        lines.push('', `${group.label}:`);
        for (const row of group.rows) {
            const time = timeRange(row.start_time, row.end_time).replace('–', ' to ');
            lines.push([courseName(row), time, row.venue, row.lecturer].filter(Boolean).join(', ') + '.');
        }
    }
    return `${text}\n${lines.join('\n')}`.trim();
}

// ---------------------------------------------------------------- conversation

/** A conversation as plain text, ready to save or paste. */
export function conversationToText(conversation, { student = '', now = new Date() } = {}) {
    const lines = [
        'UTG Academic Assistant',
        conversation?.title ? `Chat: ${conversation.title}` : '',
        student ? `Student: ${student}` : '',
        `Saved: ${now.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`,
        '',
    ].filter((line, i) => line || i === 4);

    for (const m of conversation?.messages || []) {
        if (m.role === 'user') {
            lines.push(`You: ${m.text}`, '');
            continue;
        }
        const text = m.status === 'error' ? `(No answer: ${m.error || 'something went wrong'})` : mdToPlain(m.text);
        lines.push(`Assistant: ${text || '(no answer)'}`);
        for (const row of m.sources || []) {
            const when = isExam(row) ? examDateLong(row.date) : dayName(row.day);
            const parts = [courseName(row), when, timeRange(row.start_time, row.end_time), row.venue, row.lecturer];
            lines.push(`  - ${parts.filter(Boolean).join(' | ')}`);
        }
        lines.push('');
    }
    return `${lines.join('\n').trimEnd()}\n`;
}

// ------------------------------------------------------------------------- csv

function csvCell(value) {
    let text = String(value ?? '');
    // a cell starting with = + - @ would be run as a formula by spreadsheet apps
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Classes and exams as CSV (opens in Excel, Google Sheets, Numbers). */
export function rowsToCsv(rows) {
    const header = ['Type', 'Course code', 'Course title', 'Day', 'Date', 'Start', 'End', 'Venue', 'Lecturer'];
    const body = (rows || []).map((row) => [
        isExam(row) ? 'Exam' : 'Class',
        row.course_code,
        row.course_title,
        dayName(row.day),
        row.date || '',
        row.start_time,
        row.end_time,
        row.venue,
        row.lecturer,
    ]);
    return `${[header, ...body].map((cells) => cells.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

// ------------------------------------------------------------------------- ics

const DAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const two = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}`;

function hhmm(value) {
    const m = String(value || '').match(/^(\d{1,2}):(\d{2})/);
    return m ? `${two(m[1])}${m[2]}00` : null;
}

const icsText = (value) =>
    String(value ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Lines longer than 75 characters must be folded onto continuation lines. */
function fold(line) {
    const parts = [];
    let rest = line;
    while (rest.length > 74) {
        parts.push(rest.slice(0, 74));
        rest = ` ${rest.slice(74)}`;
    }
    parts.push(rest);
    return parts.join('\r\n');
}

/** First date on or after `from` that falls on the given weekday. */
function nextWeekday(day, from) {
    const index = DAY_INDEX[String(day || '').trim().slice(0, 3).toLowerCase()];
    if (index === undefined) return null;
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    d.setDate(d.getDate() + ((index - d.getDay() + 7) % 7));
    return d;
}

function eventFor(row, now) {
    const start = hhmm(row.start_time);
    const end = hhmm(row.end_time);
    let date;
    let repeat = '';

    if (isExam(row)) {
        const m = String(row.date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!m) return null;
        date = `${m[1]}${m[2]}${m[3]}`;
    } else {
        const first = nextWeekday(row.day, now);
        if (!first) return null;
        date = ymd(first);
        repeat = `RRULE:FREQ=WEEKLY;COUNT=${CLASS_WEEKS}`;
    }

    // Times are written without a timezone, so the calendar shows them as local time
    const when = start
        ? [`DTSTART:${date}T${start}`, `DTEND:${date}T${end && end > start ? end : start}`]
        : [`DTSTART;VALUE=DATE:${date}`];
    const name = courseName(row);
    const uid = `${isExam(row) ? 'exam' : 'class'}-${date}-${start || 'allday'}-${name}`.replace(/[^A-Za-z0-9-]/g, '');

    return [
        'BEGIN:VEVENT',
        `UID:${uid}@utg-academic-assistant`,
        `DTSTAMP:${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}`,
        ...when,
        repeat,
        `SUMMARY:${icsText(isExam(row) ? `Exam: ${name}` : name)}`,
        row.venue ? `LOCATION:${icsText(row.venue)}` : '',
        row.lecturer ? `DESCRIPTION:${icsText(`Lecturer: ${row.lecturer}`)}` : '',
        'END:VEVENT',
    ].filter(Boolean);
}

/**
 * Classes and exams as a calendar file. Exams are single events on their date;
 * classes repeat weekly for CLASS_WEEKS weeks from their next sitting.
 * Rows without a usable day or date are left out.
 */
export function rowsToIcs(rows, { now = new Date() } = {}) {
    const events = (rows || []).map((row) => eventFor(row, now)).filter(Boolean);
    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//UTG Academic Assistant//EN',
        'CALSCALE:GREGORIAN',
        ...events.flat(),
        'END:VCALENDAR',
    ];
    return { ics: `${lines.map(fold).join('\r\n')}\r\n`, count: events.length };
}

// -------------------------------------------------------------------- download

/** A safe file name from free text. */
export function fileNameFrom(text, fallback = 'utg-assistant') {
    const base = String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
    return base || fallback;
}

/** Hand a text file to the browser's download. */
export function downloadText(filename, text, mime = 'text/plain') {
    const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
