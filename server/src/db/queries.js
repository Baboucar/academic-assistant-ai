import { db } from './connect.js';
import { Settings } from './accounts.js';
import { Aliases } from './aliases.js';

const TT_COLUMNS =
    'id, dept, course_code, course_title, day, start_time, end_time, venue, lecturer, source_file';

const DAY_ORDER = `CASE UPPER(SUBSTR(day,1,3))
        WHEN 'MON' THEN 1 WHEN 'TUE' THEN 2 WHEN 'WED' THEN 3
        WHEN 'THU' THEN 4 WHEN 'FRI' THEN 5 WHEN 'SAT' THEN 6 WHEN 'SUN' THEN 7 ELSE 9 END`;

// Combined searchable blob for fuzzy text matching. Lecturer names are often
// embedded in the course_code or course_title cell of a parsed PDF.
const blob = (...cols) => `UPPER(${cols.map((c) => `COALESCE(${c},'')`).join(` || ' ' || `)})`;
const SEARCH_BLOB = blob('course_code', 'course_title', 'lecturer', 'venue');
// A course is found by its code and title only: matching a title against lecturer
// names would make "AI" find a lecturer called Saikou.
const TITLE_BLOB = blob('course_code', 'course_title');
const EXAM_BLOB = blob('course_code', 'course_title');
const EXAM_COLUMNS = 'id, dept, course_code, course_title, date, start_time, end_time, venue, lecturer, source_file';
// strftime('%w') numbers the week from Sunday = 0
const WEEKDAY_NUMBER = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

/** Semester labels that actually have class or exam rows loaded, newest label first. */
function loadedSemesters() {
    return db
        .prepare(
            `SELECT semester FROM (SELECT semester FROM timetable UNION SELECT semester FROM exams)
             WHERE semester IS NOT NULL AND TRIM(semester) <> ''`,
        )
        .all()
        .map((r) => r.semester)
        // "2026-2027 S2" > "2026-2027 S1" > "2025-2026 S2": the label itself, not when a
        // file happened to be uploaded, so correcting an old file never switches the term
        .sort((x, y) => y.localeCompare(x, 'en', { numeric: true, sensitivity: 'base' }));
}

/**
 * Which semester answers come from. An admin can pin one (or choose all, "*").
 * Otherwise, when rows from more than one semester are loaded, it is the
 * latest label, so last term's rows do not mix into this term's answers.
 * A pinned semester with nothing loaded any more is ignored rather than
 * leaving every search empty.
 */
export function activeSemester() {
    const pinned = Settings.get('current_semester');
    if (pinned === '*') return null;
    const loaded = loadedSemesters();
    if (pinned && loaded.includes(pinned)) return pinned;
    return loaded.length > 1 ? loaded[0] : null;
}

// Words that do not count towards a course's initials: "Data Communications and Network" is DCN
const SMALL_WORDS = new Set(['AND', 'OF', 'THE', 'TO', 'IN', 'FOR', 'ON', 'A', 'AN', 'WITH']);
const NUMBERING = /^(I{1,3}|IV|V|VI|\d+)$/;

let acronyms = { version: null, byInitials: new Map() };
/**
 * Course titles by their initials, from the titles actually loaded:
 * "OS" -> ["Operating Systems"], "HCI" -> ["Human Computer Interaction"].
 * This is how an abbreviation nobody registered as an alias is still understood.
 */
function titlesByInitials() {
    const semester = activeSemester();
    const row = db.prepare(`SELECT COALESCE(MAX(ingested_at), '') AS latest, COUNT(*) AS n FROM sources`).get();
    const version = `${row.latest}:${row.n}:${semester || ''}`;
    if (acronyms.version === version) return acronyms.byInitials;

    const byInitials = new Map();
    const titles = db
        .prepare(
            `SELECT DISTINCT course_title AS title FROM (
               SELECT course_title, semester FROM timetable UNION SELECT course_title, semester FROM exams
             ) WHERE course_title IS NOT NULL AND TRIM(course_title) <> '' AND (@semester IS NULL OR semester = @semester)`,
        )
        .all({ semester });
    for (const { title } of titles) {
        // "Operating Systems II" and "Operating Systems" share the name "Operating Systems"
        const named = String(title).replace(/[^A-Za-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !NUMBERING.test(w.toUpperCase()));
        const counted = named.filter((w) => !SMALL_WORDS.has(w.toUpperCase()));
        if (counted.length < 2) continue;
        const initials = counted.map((w) => w[0].toUpperCase()).join('');
        if (!byInitials.has(initials)) byInitials.set(initials, new Set());
        byInitials.get(initials).add(named.join(' '));
    }
    acronyms = { version, byInitials };
    return byInitials;
}

/** Is this a single short word that could be a course's initials, and not already a known alias? */
function asInitials(text) {
    const parts = words(text || '');
    if (parts.length !== 1 || parts[0].length < 2 || parts[0].length > 6 || !/^[A-Z]+$/.test(parts[0])) return null;
    return Aliases.canonical(text) === text ? parts[0] : null;
}

/**
 * Every name to search for when a course is asked about: the aliases an admin
 * set (see aliases.js), plus any loaded title whose initials spell the word.
 */
export function expandTitleAliases(s) {
    const phrases = Aliases.phrasesFor(s);
    const initials = asInitials(s);
    if (initials) phrases.push(...(titlesByInitials().get(initials) || []));
    return [...new Set(phrases)];
}

const words = (text) => String(text).toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

/** Search words of a lecturer's name: initials are dropped unless there is nothing else. */
const TITLES = new Set(['MR', 'MRS', 'MS', 'MISS', 'DR', 'PROF', 'PROFESSOR', 'ASSOC', 'ENGR']);
function nameTokens(text) {
    const all = words(text).filter((w) => !TITLES.has(w));
    const long = all.filter((w) => w.length >= 3);
    return long.length ? long : all.length ? [all.join(' ')] : [];
}

/** Search words of a venue: every word counts, so "Lab 2" is not the same as "Lab 1". */
const venueTokens = (text) => words(text);

/** Search words of a course title: ordinary words, plus short names that are known aliases ("AI"). */
function titleTokens(phrase) {
    return words(phrase).filter((w) => w.length >= 3 || Aliases.shortTokens().has(w));
}

// the column with punctuation turned into spaces, padded, so a whole word can be matched
const spaced = (column) =>
    `(' ' || REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(${column}, '/', ' '), ',', ' '), '.', ' '), '-', ' '), '&', ' ') || ' ')`;

/**
 * One search word against a column. An ordinary word may be part of a longer
 * one ("PROGRAM" in "PROGRAMMING"); a short one ("AI", "2", "OS") must be a
 * whole word, or it would match half the timetable.
 */
function wordMatch(column, word, params) {
    if (word.length >= 3 && !/\s/.test(word)) {
        params.push(`%${word}%`);
        return `${column} LIKE ?`;
    }
    params.push(`% ${word} %`);
    return `${spaced(column)} LIKE ?`;
}

/** (wordA AND wordB) OR (wordC AND wordD) across every name a course goes by. */
function titleClause(titleKw, column, params) {
    const groups = [];
    for (const phrase of expandTitleAliases(titleKw)) {
        const toks = titleTokens(phrase);
        if (!toks.length) continue;
        groups.push(`(${toks.map((t) => wordMatch(column, t, params)).join(' AND ')})`);
    }
    if (groups.length) return `(${groups.join(' OR ')})`;
    // only very short words that are not a known alias ("OS"): a whole word, or nothing
    const whole = words(titleKw).join(' ');
    return whole ? wordMatch(column, whole, params) : null;
}

/** How many single-letter edits turn one word into another (capped: anything over `max` is just "too many"). */
function editDistance(a, b, max = 2) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const current = [i];
        for (let j = 1; j <= b.length; j++) {
            current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        previous = current;
    }
    return previous[b.length];
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
            const clause = titleClause(titleKw, TITLE_BLOB, params);
            if (clause) where.push(clause);
        }

        // 3) Lecturer and 4) venue keywords — every token must appear somewhere in the row.
        if (lecturerKw) for (const tok of nameTokens(lecturerKw)) where.push(`(${wordMatch(SEARCH_BLOB, tok, params)})`);
        // a room number must be in the venue itself: "2" also appears in "Web Programming 2"
        if (venueKw) for (const tok of venueTokens(venueKw)) where.push(`(${wordMatch(tok.length >= 3 ? SEARCH_BLOB : `UPPER(COALESCE(venue,''))`, tok, params)})`);

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

        // 8) Only the semester answers come from
        const semester = activeSemester();
        if (semester) {
            where.push(`semester = ?`);
            params.push(semester);
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
        const semester = activeSemester();
        if (semester) params.push(semester);
        return db
            .prepare(
                `SELECT ${TT_COLUMNS} FROM timetable WHERE ${clause} ${semester ? 'AND semester = ?' : ''}
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
            for (const tok of venueTokens(venueKw)) where.push(`(${wordMatch(`UPPER(COALESCE(venue,''))`, tok, params)})`);
        }
        if (lecturerKw) {
            for (const tok of nameTokens(lecturerKw)) where.push(`(${wordMatch(`UPPER(COALESCE(lecturer,''))`, tok, params)})`);
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
        const semester = activeSemester();
        if (semester) {
            where.push(`semester = ?`);
            params.push(semester);
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

    /**
     * The course an abbreviation stands for, when exactly one loaded title has
     * those initials ("OS" -> "Operating Systems"). Otherwise the text as given.
     */
    titleForInitials(text) {
        const initials = asInitials(text);
        const titles = initials ? [...(titlesByInitials().get(initials) || [])] : [];
        return titles.length === 1 ? titles[0] : text;
    },

    /**
     * A lecturer's name as it is spelled in the timetable, when what was typed is
     * one or two letters off ("Kujabbi" for "Kujabi"). Returns the name unchanged
     * when every word is already known or nothing close enough exists.
     */
    correctLecturer(name) {
        const typed = nameTokens(name || '').filter((w) => !/\s/.test(w));
        if (!typed.length) return name;
        const semester = activeSemester();
        const known = new Set(
            db
                .prepare(
                    `SELECT DISTINCT lecturer FROM (SELECT lecturer, semester FROM timetable UNION SELECT lecturer, semester FROM exams)
                     WHERE lecturer IS NOT NULL AND lecturer <> '' AND (@semester IS NULL OR semester = @semester)`,
                )
                .all({ semester })
                .flatMap((row) => words(row.lecturer).filter((w) => w.length >= 3)),
        );
        if (!known.size) return name;

        let changed = false;
        const fixed = typed.map((word) => {
            if (known.has(word) || word.length < 4) return word;
            const allowed = word.length >= 8 ? 2 : 1;
            let best = null;
            for (const candidate of known) {
                if (candidate[0] !== word[0]) continue; // a typo rarely changes the first letter
                const distance = editDistance(word, candidate, allowed);
                if (distance <= allowed && (!best || distance < best.distance)) best = { candidate, distance };
            }
            if (!best) return word;
            changed = true;
            return best.candidate;
        });
        // back to ordinary capitalisation for display: "KUJABI" -> "Kujabi"
        return changed ? fixed.map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(' ') : name;
    },

    /** Department labels in use, e.g. ["CS", "INS", "LAW"]. Files with no label are left out. */
    departments() {
        return db
            .prepare(
                `SELECT DISTINCT UPPER(TRIM(dept)) AS dept FROM (
                   SELECT dept, semester FROM timetable UNION SELECT dept, semester FROM exams
                 ) WHERE dept IS NOT NULL AND TRIM(dept) <> '' AND UPPER(TRIM(dept)) <> 'UNKNOWN'
                   AND (@semester IS NULL OR semester = @semester)
                 ORDER BY 1`,
            )
            .all({ semester: activeSemester() })
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

    /** Every semester label in use, newest upload first, with how many files carry it. */
    semesters() {
        return db
            .prepare(
                `SELECT semester, COUNT(*) AS files, MAX(ingested_at) AS latest FROM sources
                 WHERE semester IS NOT NULL AND TRIM(semester) <> ''
                 GROUP BY semester ORDER BY latest DESC`,
            )
            .all();
    },

    /** Changes whenever the loaded files change: used to drop cached answers. */
    dataVersion() {
        const row = db.prepare(`SELECT COALESCE(MAX(ingested_at), '') AS latest, COUNT(*) AS n FROM sources`).get();
        return `${row.latest}:${row.n}`;
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
