import { db } from './connect.js';

const TT_COLUMNS =
    'id, dept, course_code, course_title, day, start_time, end_time, venue, lecturer, source_file';

const DAY_ORDER = `CASE UPPER(SUBSTR(day,1,3))
        WHEN 'MON' THEN 1 WHEN 'TUE' THEN 2 WHEN 'WED' THEN 3
        WHEN 'THU' THEN 4 WHEN 'FRI' THEN 5 WHEN 'SAT' THEN 6 WHEN 'SUN' THEN 7 ELSE 9 END`;

// Combined searchable blob for fuzzy text matching. Lecturer names are often
// embedded in the course_code or course_title cell of a parsed PDF.
const blob = (...cols) => `UPPER(${cols.map((c) => `COALESCE(${c},'')`).join(` || ' ' || `)})`;
const SEARCH_BLOB = blob('course_code', 'course_title', 'lecturer', 'venue');
const TITLE_BLOB = blob('course_code', 'course_title', 'lecturer');
const EXAM_BLOB = blob('course_code', 'course_title');
const EXAM_COLUMNS = 'id, dept, course_code, course_title, date, start_time, end_time, venue, lecturer, source_file';
// strftime('%w') numbers the week from Sunday = 0
const WEEKDAY_NUMBER = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

// Short title tokens we still want to match (acronyms)
const SHORT_TITLE_TOKENS = new Set(['AI', 'DCN']);

const DCN_FAMILY = [
    'DATA COMMUNICATIONS AND NETWORK',
    'DATA COMMUNICATIONS AND NETWORKS',
    'DATA COMMUNICATION AND NETWORK',
    'DATA COMMUNICATION AND NETWORKS',
    'DATA COMMUNICATIONS AND NETWORKING',
    'DATA COMMUNICATIONS',
    'DATA COMMUNICATION',
];

/**
 * Title aliases: some courses appear under two names in the PDF, like
 * "Intelligent Systems/ Artificial Intelligence". Returns phrases to OR-match.
 */
export function expandTitleAliases(s) {
    if (!s) return [];
    const u = String(s).trim().toUpperCase();
    if (u === 'ARTIFICIAL INTELLIGENCE' || u === 'AI') {
        return ['ARTIFICIAL INTELLIGENCE', 'INTELLIGENT SYSTEMS'];
    }
    if (u === 'INTELLIGENT SYSTEMS') {
        return ['INTELLIGENT SYSTEMS', 'ARTIFICIAL INTELLIGENCE'];
    }
    if (u === 'DCN' || DCN_FAMILY.includes(u)) return DCN_FAMILY;
    return [s];
}

function tokens(phrase, { keepShort = false } = {}) {
    return String(phrase)
        .toUpperCase()
        .replace(/[^A-Z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3 || (keepShort && SHORT_TITLE_TOKENS.has(w)));
}

/** (tokA AND tokB) OR (tokC AND tokD) across the alias phrases of a title. */
function titleClause(titleKw, column, params) {
    const groups = [];
    for (const phrase of expandTitleAliases(titleKw)) {
        const toks = tokens(phrase, { keepShort: true });
        if (!toks.length) continue;
        groups.push(`(${toks.map(() => `${column} LIKE ?`).join(' AND ')})`);
        params.push(...toks.map((t) => `%${t}%`));
    }
    return groups.length ? `(${groups.join(' OR ')})` : null;
}

export const Queries = {
    flexibleSearch({ course, titleKw, lecturerKw, day3, dept, time, venueKw } = {}) {
        const where = [];
        const params = [];

        // 1) Course code — most specific. If we have this, we rely primarily on it.
        if (course) {
            // allow combined codes e.g. "CPS 416/ CPS 313 Intelligent Systems..."
            where.push(`REPLACE(UPPER(course_code),' ','') LIKE ?`);
            params.push(`%${String(course).toUpperCase().replace(/\s+/g, '')}%`);
        }

        // 2) Title keywords — ONLY when we do NOT already have a course code.
        // (Prevents "Intelligent Systems" from matching every "... Systems" course.)
        if (!course && titleKw) {
            const clause = titleClause(titleKw, SEARCH_BLOB, params);
            if (clause) where.push(clause);
        }

        // 3) Lecturer and 4) venue keywords — every token must appear somewhere in the row.
        for (const kw of [lecturerKw, venueKw]) {
            if (!kw) continue;
            for (const tok of tokens(kw)) {
                where.push(`(${SEARCH_BLOB} LIKE ?)`);
                params.push(`%${tok}%`);
            }
        }

        // 5) Department filter
        if (dept) {
            where.push(`UPPER(dept) = ?`);
            params.push(String(dept).toUpperCase());
        }

        // 6) Day filter: one day, or several ("Monday and Tuesday")
        const days = [].concat(day3 || []).map((d) => String(d).slice(0, 3).toUpperCase());
        if (days.length) {
            where.push(`UPPER(SUBSTR(day,1,3)) IN (${days.map(() => '?').join(',')})`);
            params.push(...days);
        }

        // 7) Time filter — classes that cover a given time
        if (time) {
            where.push(`(start_time <= ? AND end_time >= ?)`);
            params.push(time, time);
        }

        const sql = `
      SELECT ${TT_COLUMNS}
      FROM timetable
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ${DAY_ORDER}, start_time ASC, course_code ASC
      LIMIT 50
    `;
        return db.prepare(sql).all(...params);
    },

    // Basic fuzzy match by course title (with fallback across code/lecturer too)
    fuzzyByTitle(titleKw) {
        if (!titleKw) return [];
        const params = [];
        const clause = titleClause(titleKw, TITLE_BLOB, params);
        if (!clause) return [];
        return db
            .prepare(
                `SELECT ${TT_COLUMNS} FROM timetable WHERE ${clause}
         ORDER BY ${DAY_ORDER}, start_time ASC, course_code ASC LIMIT 50`,
            )
            .all(...params);
    },

    /**
     * Exam sittings, soonest first. `fromISO` keeps only exams on or after that date.
     */
    searchExams({ course, titleKw, lecturerKw, dept, dateISO, day3, venueKw, fromISO, limit = 50 } = {}) {
        const where = [];
        const params = [];

        if (course) {
            where.push(`REPLACE(UPPER(course_code),' ','') LIKE ?`);
            params.push(`%${String(course).toUpperCase().replace(/\s+/g, '')}%`);
        }
        if (!course && titleKw) {
            const clause = titleClause(titleKw, EXAM_BLOB, params);
            if (clause) where.push(clause);
        }
        if (venueKw) {
            for (const tok of tokens(venueKw)) {
                where.push(`UPPER(COALESCE(venue,'')) LIKE ?`);
                params.push(`%${tok}%`);
            }
        }
        if (lecturerKw) {
            for (const tok of tokens(lecturerKw)) {
                where.push(`UPPER(COALESCE(lecturer,'')) LIKE ?`);
                params.push(`%${tok}%`);
            }
        }
        if (dept) {
            where.push(`UPPER(dept) = ?`);
            params.push(String(dept).toUpperCase());
        }
        if (dateISO) {
            where.push(`date = ?`);
            params.push(dateISO);
        }
        const weekdays = []
            .concat(day3 || [])
            .map((d) => WEEKDAY_NUMBER[String(d).slice(0, 3).toUpperCase()])
            .filter((n) => n !== undefined);
        if (!dateISO && weekdays.length) {
            where.push(`CAST(strftime('%w', date) AS INTEGER) IN (${weekdays.map(() => '?').join(',')})`);
            params.push(...weekdays);
        }
        if (fromISO) {
            where.push(`date >= ?`);
            params.push(fromISO);
        }

        const sql = `
      SELECT ${EXAM_COLUMNS}
      FROM exams
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY date ASC, start_time ASC, course_code ASC
      LIMIT ?
    `;
        return db.prepare(sql).all(...params, Math.max(1, Math.min(50, Number(limit) || 50)));
    },

    /** All classes on a day, optionally for one department. */
    getDaySchedule(day3, dept) {
        return this.flexibleSearch({ day3, dept });
    },

    /** First sitting of a course on or after the given weekday. */
    findNextClass(courseCode, fromDay3) {
        const rows = this.flexibleSearch({ course: courseCode });
        if (!rows.length) return null;
        const order = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
        const from = Math.max(0, order.indexOf(String(fromDay3 || '').slice(0, 3).toUpperCase()));
        const offset = (r) => {
            const i = order.indexOf(String(r.day || '').slice(0, 3).toUpperCase());
            return i === -1 ? 99 : (i - from + 7) % 7;
        };
        return [...rows].sort((a, b) => offset(a) - offset(b))[0];
    },

    searchCalendar(keyword) {
        const like = `%${String(keyword).toUpperCase()}%`;
        return db
            .prepare(
                `SELECT id, date, title, description, source_file FROM calendar
         WHERE UPPER(COALESCE(title,'') || ' ' || COALESCE(description,'')) LIKE ?
         ORDER BY date ASC LIMIT 50`,
            )
            .all(like);
    },

    searchNotices(keyword) {
        const like = `%${String(keyword).toUpperCase()}%`;
        return db
            .prepare(
                `SELECT id, date, title, body, source_file FROM notices
         WHERE UPPER(COALESCE(title,'') || ' ' || COALESCE(body,'')) LIKE ?
         ORDER BY date DESC LIMIT 50`,
            )
            .all(like);
    },

    /** Department labels in use, e.g. ["CS", "INS", "LAW"]. Files with no label are left out. */
    departments() {
        return db
            .prepare(
                `SELECT DISTINCT UPPER(TRIM(dept)) AS dept FROM (
                   SELECT dept FROM timetable UNION SELECT dept FROM exams
                 ) WHERE dept IS NOT NULL AND TRIM(dept) <> '' AND UPPER(TRIM(dept)) <> 'UNKNOWN'
                 ORDER BY 1`,
            )
            .all()
            .map((row) => row.dept);
    },

    /** Ingested files, optionally of one type, with how many rows each produced. */
    listSources(type) {
        const sql = `
      SELECT s.type, s.source_file, s.semester, s.ingested_at, s.dept,
        CASE s.type
          WHEN 'timetable' THEN (SELECT COUNT(*) FROM timetable t WHERE t.source_file = s.source_file)
          WHEN 'exams'     THEN (SELECT COUNT(*) FROM exams     e WHERE e.source_file = s.source_file)
          WHEN 'calendar'  THEN (SELECT COUNT(*) FROM calendar  c WHERE c.source_file = s.source_file)
          ELSE                  (SELECT COUNT(*) FROM notices   n WHERE n.source_file = s.source_file)
        END AS row_count
      FROM sources s
      ${type ? 'WHERE s.type = ?' : ''}
      ORDER BY s.ingested_at DESC, s.source_file ASC
    `;
        return type ? db.prepare(sql).all(type) : db.prepare(sql).all();
    },

    counts() {
        const n = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
        return {
            timetable: n('timetable'),
            exams: n('exams'),
            calendar: n('calendar'),
            notices: n('notices'),
            sources: n('sources'),
        };
    },
};
