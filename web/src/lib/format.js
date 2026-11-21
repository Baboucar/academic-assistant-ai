// Small display helpers shared by the chat and admin screens.

const DAY_NAMES = {
    mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
    fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
};

/** "Mon" / "MONDAY" -> "Monday". Unknown values pass through. */
export function dayName(day) {
    const key = String(day || '').trim().slice(0, 3).toLowerCase();
    return DAY_NAMES[key] || String(day || '');
}

/** "2026-01-12" -> "Mon 12 Jan 2026". Anything else passes through. */
export function examDate(dateISO) {
    const m = String(dateISO || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return String(dateISO || '');
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
    if (Number.isNaN(d.getTime())) return String(dateISO);
    return d
        .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
        .replace(',', '');
}

/** "2026-01-12" -> "Monday 12 January 2026". Anything else passes through. */
export function examDateLong(dateISO) {
    const m = String(dateISO || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return String(dateISO || '');
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
    if (Number.isNaN(d.getTime())) return String(dateISO);
    return d
        .toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
        .replace(',', '');
}

/**
 * Group classes by day, or exams by date, keeping the order they arrived in:
 * [{ label: 'Monday', rows: [...] }, ...].
 */
export function groupSchedule(rows) {
    const groups = new Map();
    for (const row of rows || []) {
        const exam = row.kind === 'exam' || Boolean(row.date);
        const label = (exam ? examDateLong(row.date) : dayName(row.day)) || 'Day not set';
        if (!groups.has(label)) groups.set(label, { label, rows: [] });
        groups.get(label).rows.push(row);
    }
    return [...groups.values()];
}

/** "08:30", "11:00" -> "08:30–11:00". */
export function timeRange(start, end) {
    const a = String(start || '').trim();
    const b = String(end || '').trim();
    if (a && b) return `${a}–${b}`;
    return a || b || '';
}

/** SQLite "YYYY-MM-DD HH:MM:SS" (UTC) -> Date, or null. */
export function parseDbDate(value) {
    if (!value) return null;
    const d = new Date(String(value).replace(' ', 'T') + 'Z');
    return Number.isNaN(d.getTime()) ? null : d;
}

/** "3 minutes ago", "yesterday", or a short date for anything older than a week. */
export function timeAgo(value, now = new Date()) {
    const d = value instanceof Date ? value : parseDbDate(value);
    if (!d) return '—';
    const seconds = Math.round((now.getTime() - d.getTime()) / 1000);
    if (seconds < 45) return 'just now';

    const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return rtf.format(-minutes, 'minute');
    const hours = Math.round(minutes / 60);
    if (hours < 24) return rtf.format(-hours, 'hour');
    const days = Math.round(hours / 24);
    if (days < 7) return rtf.format(-days, 'day');
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fullDate(value) {
    const d = value instanceof Date ? value : parseDbDate(value);
    if (!d) return '';
    return d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

export function fileSize(bytes) {
    if (!Number.isFinite(bytes)) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Search filters from the server -> short labels like ["Monday", "CS"]. */
export function filterLabels(filters) {
    if (!filters) return [];
    const labels = [];
    if (filters.exam) labels.push('Exams');
    if (filters.course) labels.push(filters.course);
    else if (filters.title) labels.push(filters.title);
    if (filters.lecturer) labels.push(filters.lecturer);
    if (filters.dept) labels.push(filters.dept);
    if (filters.date) labels.push(examDate(filters.date));
    for (const day of [].concat(filters.day || [])) labels.push(dayName(day));
    if (filters.time) labels.push(filters.time);
    if (filters.venue) labels.push(filters.venue);
    return labels;
}
