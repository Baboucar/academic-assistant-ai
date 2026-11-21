// Day and time helpers. Everything is resolved in the configured timezone so
// "today" means today on campus, not wherever the server happens to run.

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const DAY_WORDS = {
    mon: 'Mon', monday: 'Mon', mondays: 'Mon',
    tue: 'Tue', tues: 'Tue', tuesday: 'Tue', tuesdays: 'Tue',
    wed: 'Wed', weds: 'Wed', wednesday: 'Wed', wednesdays: 'Wed',
    thu: 'Thu', thur: 'Thu', thurs: 'Thu', thursday: 'Thu', thursdays: 'Thu',
    fri: 'Fri', friday: 'Fri', fridays: 'Fri',
    sat: 'Sat', saturday: 'Sat', saturdays: 'Sat',
    sun: 'Sun', sunday: 'Sun', sundays: 'Sun',
};

/** Normalise any weekday spelling to "Mon".."Sun", or null. */
export function toDay3(value) {
    if (!value) return null;
    return DAY_WORDS[String(value).trim().toLowerCase()] || null;
}

/** Current date/time in a timezone: { iso, day3, weekday, time }. */
export function nowIn(timeZone, date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value || '';
    return {
        iso: `${get('year')}-${get('month')}-${get('day')}`,
        weekday: get('weekday'),
        day3: get('weekday').slice(0, 3),
        time: `${get('hour')}:${get('minute')}`,
    };
}

export function shiftDay(day3, offset) {
    const i = DAYS.indexOf(day3);
    if (i === -1) return null;
    return DAYS[(((i + offset) % 7) + 7) % 7];
}

/** Weekday of a YYYY-MM-DD date, or null if it is not a real date. */
export function dayFromISO(dateISO) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateISO || ''))) return null;
    const d = new Date(`${dateISO}T12:00:00Z`);
    if (Number.isNaN(d.getTime())) return null;
    return DAYS[(d.getUTCDay() + 6) % 7];
}

/**
 * Find a day in free text: explicit weekdays first, then relative words
 * ("today", "tomorrow", "yesterday", "day after tomorrow", "tonight").
 */
export function dayFromText(text, today3) {
    const q = String(text || '').toLowerCase();

    // Bare "wed", "sat" and "sun" are ordinary words, so those need the full name.
    const explicit = q.match(
        /\b(mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|mon|tues?|weds|thu(?:rs?)?|fri)\b/,
    );
    if (explicit) return toDay3(explicit[1]);

    if (!today3) return null;
    if (/\bday after tomorrow\b/.test(q)) return shiftDay(today3, 2);
    if (/\b(tomorrow|tmrw|tmr)\b/.test(q)) return shiftDay(today3, 1);
    if (/\byesterday\b/.test(q)) return shiftDay(today3, -1);
    if (/\b(today|tonight|this (?:morning|afternoon|evening))\b/.test(q)) return today3;
    return null;
}

/** Move a YYYY-MM-DD date by a number of days. */
export function shiftISO(dateISO, days) {
    const d = new Date(`${dateISO}T12:00:00Z`);
    if (Number.isNaN(d.getTime())) return null;
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

/** The calendar date meant by "today", "tomorrow", "yesterday" in free text, or null. */
export function dateFromText(text, todayISO) {
    const q = String(text || '').toLowerCase();
    if (!todayISO) return null;
    if (/\bday after tomorrow\b/.test(q)) return shiftISO(todayISO, 2);
    if (/\b(tomorrow|tmrw|tmr)\b/.test(q)) return shiftISO(todayISO, 1);
    if (/\byesterday\b/.test(q)) return shiftISO(todayISO, -1);
    if (/\b(today|tonight|this (?:morning|afternoon|evening))\b/.test(q)) return todayISO;
    return null;
}

/** Every weekday named in free text, in the order given, without repeats: "Monday and Tuesday" -> ["Mon", "Tue"]. */
export function daysFromText(text) {
    const q = String(text || '').toLowerCase();
    const found = q.matchAll(
        /\b(mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|mon|tues?|weds|thu(?:rs?)?|fri)\b/g,
    );
    return [...new Set([...found].map((m) => toDay3(m[1])).filter(Boolean))];
}

/** Order timetable rows by how soon they start, counting from now. */
export function sortUpcoming(rows, now) {
    const todayIdx = DAYS.indexOf(now.day3);
    const rank = (row) => {
        const day = toDay3(String(row.day || '').slice(0, 3)) || toDay3(row.day);
        const idx = DAYS.indexOf(day);
        if (idx === -1 || todayIdx === -1) return Number.MAX_SAFE_INTEGER;
        const start = String(row.start_time || '').padStart(5, '0');
        let offset = (idx - todayIdx + 7) % 7;
        // a class earlier today has already started: its next sitting is in a week
        if (offset === 0 && start <= now.time) offset = 7;
        const [h = 0, m = 0] = start.split(':').map(Number);
        return offset * 24 * 60 + (h || 0) * 60 + (m || 0);
    };
    return [...rows].sort((a, b) => rank(a) - rank(b));
}
