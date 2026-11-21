// ingest/parsers/examPdf.js
//
// Reads an exam timetable PDF laid out as a dated session heading
// ("Tuesday 1st December 2026, 9:00am - 11:00am") above a small table:
//
//   S/n | Code | Title | Lecturer | Venue | Invigilators | No. Students
//
// The text of such a PDF comes out as loose words, so the reader works from
// where each word sits on the page:
//   - a heading is recognised by its wording, wherever it is in the text;
//   - a table is recognised by its header row, and its columns by the gaps
//     between the words underneath (the labels themselves may be misspelt);
//   - a table may carry on over a page break, without a second header row;
//   - a heading at the foot of a page belongs to the table that starts the next.
import fs from 'fs';
import pdfParse from 'pdf-parse';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const dayName = (index) => WEEKDAYS[index].charAt(0).toUpperCase() + WEEKDAYS[index].slice(1);
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n) => String(n).padStart(2, '0');

// "Thursday, 17th December 2026. 9:00am - 11:00am" (punctuation and am/pm are optional)
const HEADING_RE = new RegExp(
    '\\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\\s*,?\\s+' + // weekday
        '(\\d{1,2})\\s*(?:st|nd|rd|th)?\\s+' + // day
        '([a-z]{3,9})\\.?,?\\s+' + // month
        '(\\d{4})\\s*[.,]*\\s*' + // year
        '(\\d{1,2})[:.](\\d{2})\\s*(am|pm)?\\s*(?:-|–|—|to)\\s*' + // start
        '(\\d{1,2})[:.](\\d{2})\\s*(am|pm)?', // end
    'gi',
);

// Lines that are not part of any table: "WEEK 2 (Mon. 7th to Sat. 12th Dec. 2026)", "NO EXAMS",
// "FRIDAY 4TH DEC. 2026 AND SATURDAY 5TH DEC. 2026" (a weekday and a year, but no session time)
const BANNER_RE =
    /\bWEEK\s*\d+\b|\bNO\s+EXAMS?\b|\bPUBLIC\s+HOLIDAY\b|\b(MON|TUES?|WED(NES)?|THU(RS)?|FRI|SAT(UR)?|SUN)(DAY)?\b.*\b20\d{2}\b/i;

const COLUMNS = ['sn', 'code', 'title', 'lecturer', 'venue', 'invigilators', 'students'];

// A timetable is a few hundred short words per page. These limits keep a huge
// or hostile file from tying up the reader or storing a paragraph in a cell.
const MAX_PAGES = 300;
const MAX_WORDS_PER_PAGE = 6000;
const MAX_WORD_LENGTH = 80;
const MAX_CELL_LENGTH = 200;
const MAX_WARNINGS = 60;

/* ------------------------------------------------------------------ */
/* 1. PDF -> words with positions                                      */
/* ------------------------------------------------------------------ */

/** Every page as a list of words: { s, x, y, w }, in the order the PDF stores them. */
export async function readPdfWords(pathToPdf) {
    const pages = [];
    const pagerender = (pageData) =>
        pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false }).then((content) => {
            if (pages.length < MAX_PAGES + 1) {
                pages.push(
                    content.items
                        .map((item) => ({
                            s: String(item.str || '').replace(/\s+/g, ' ').trim().slice(0, MAX_WORD_LENGTH),
                            x: Number(item.transform[4]) || 0,
                            y: Number(item.transform[5]) || 0,
                            w: Number(item.width) || 0,
                        }))
                        .filter((word) => word.s),
                );
            }
            return '';
        });
    await pdfParse(fs.readFileSync(pathToPdf), { pagerender });
    return pages;
}

/* ------------------------------------------------------------------ */
/* 2. Session headings                                                 */
/* ------------------------------------------------------------------ */

function clock(hour, minute, half) {
    let h = Number(hour);
    const m = Number(minute);
    // "14:00pm" appears in real timetables: am/pm only means something up to 12
    if (half && h <= 12) {
        const pm = half.toLowerCase() === 'pm';
        if (h === 12) h = pm ? 12 : 0;
        else if (pm) h += 12;
    } else if (!half && h >= 1 && h <= 6) {
        // "2:00 - 4:00" with no am/pm: no exam sits at two in the morning
        h += 12;
    }
    return h > 23 || m > 59 ? null : h * 60 + m;
}
const hhmm = (minutes) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

/** Find the session headings on a page. Marks the words they use. */
function findHeadings(words, page) {
    const starts = [];
    let text = '';
    for (const word of words) {
        starts.push(text.length);
        text += `${word.s} `;
    }
    const wordAt = (offset) => {
        let i = starts.length - 1;
        while (i > 0 && starts[i] > offset) i--;
        return i;
    };

    const headings = [];
    for (const m of text.matchAll(HEADING_RE)) {
        const month = MONTHS.indexOf(m[3].slice(0, 3).toLowerCase()) + 1;
        const start = clock(m[5], m[6], m[7]);
        let end = clock(m[8], m[9], m[10]);
        if (!month || start === null || end === null) continue;
        // "11:00 - 1:00" means one o'clock in the afternoon (already handled for 1 to 6;
        // this covers anything else that would otherwise end before it starts)
        if (end <= start && end + 12 * 60 > start && end + 12 * 60 < 24 * 60) end += 12 * 60;

        const first = wordAt(m.index);
        const last = wordAt(m.index + m[0].length - 1);
        for (let i = first; i <= last; i++) words[i].used = 'heading';
        headings.push({
            page,
            y: words[first].y,
            label: m[0].replace(/\s+/g, ' ').trim(),
            weekday: WEEKDAYS.indexOf(m[1].toLowerCase()),
            day: Number(m[2]),
            month,
            year: Number(m[4]),
            start: hhmm(start),
            end: end > start ? hhmm(end) : '',
        });
    }
    return headings;
}

const weekdayOf = (year, month, day) => {
    const d = new Date(Date.UTC(year, month - 1, day));
    return d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? d.getUTCDay() : -1;
};

/**
 * Give every heading its date. A year that disagrees with the weekday written
 * next to it (a "2025" left over in a 2026 timetable) is corrected to the
 * year the rest of the document uses, when that makes the weekday right.
 */
function datedHeadings(headings, warnings) {
    const counts = new Map();
    for (const h of headings) counts.set(h.year, (counts.get(h.year) || 0) + 1);
    const usual = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

    for (const h of headings) {
        let year = h.year;
        const stated = weekdayOf(year, h.month, h.day);
        if (stated !== h.weekday) {
            if (usual && usual !== year && weekdayOf(usual, h.month, h.day) === h.weekday) {
                warnings.push(`Page ${h.page}: "${h.label}" was read as ${usual}: that date is a ${dayName(h.weekday)} in ${usual}, not in ${year}.`);
                year = usual;
            } else if (stated === -1) {
                warnings.push(`Page ${h.page}: "${h.label}" is not a real date, so its exams were left out.`);
                h.date = null;
                continue;
            } else {
                warnings.push(`Page ${h.page}: "${h.label}" does not fall on a ${dayName(h.weekday)}. The date was kept as written.`);
            }
        }
        h.date = `${year}-${pad(h.month)}-${pad(h.day)}`;
    }
}

/* ------------------------------------------------------------------ */
/* 3. Tables                                                           */
/* ------------------------------------------------------------------ */

const sameLine = (a, b) => Math.abs(a.y - b.y) <= 2;

/**
 * Find table header rows on a page. A header is the word "Title" with "Code"
 * to its left and "Invigilators" to its right on the same line; the lecturer
 * and venue labels are simply the two words in between (they are sometimes
 * misspelt, e.g. "Lenue").
 */
function findTableHeaders(words) {
    const headers = [];
    for (let t = 0; t < words.length; t++) {
        const title = words[t];
        if (title.used || !/^title$/i.test(title.s)) continue;

        // walk left through "Cod(e)" and "S/n" (which may be split over two lines)
        let first = t;
        let code = null;
        for (let i = t - 1; i >= 0 && t - i <= 6; i--) {
            const w = words[i];
            if (w.used || Math.abs(w.y - title.y) > 16) break;
            if (/^cod(e)?$/i.test(w.s) && sameLine(w, title)) code = w;
            else if (!/^(s\/?n?|\/n|n|e)$/i.test(w.s)) break;
            first = i;
        }
        if (!code) continue;

        // walk right to "Invigilators", then through "No." / "Students"
        let last = t;
        let invigilators = null;
        for (let i = t + 1; i < words.length && i - t <= 8; i++) {
            const w = words[i];
            if (w.used || Math.abs(w.y - title.y) > 16) break;
            last = i;
            if (/^invigilators?$/i.test(w.s) && sameLine(w, title)) {
                invigilators = w;
                break;
            }
        }
        if (!invigilators) continue;
        const invigilatorsAt = last;
        let students = null;
        for (let i = last + 1; i < words.length && i - last <= 4; i++) {
            const w = words[i];
            if (w.used || Math.abs(w.y - title.y) > 16 || !/^(s|no\.?|students|no\.\s*students)$/i.test(w.s)) break;
            if (!students && /^no/i.test(w.s)) students = w;
            last = i;
        }

        const between = words
            .slice(t + 1, invigilatorsAt)
            .filter((w) => sameLine(w, title) && w.x > title.x && w.x < invigilators.x)
            .sort((a, b) => a.x - b.x);
        if (between.length < 2) continue;

        const sn = words.slice(first, t).find((w) => w !== code && w.x < code.x);
        const labels = {
            sn: sn || { x: code.x - 28, w: 10 },
            code,
            title,
            lecturer: between[0],
            venue: between[between.length - 1],
            invigilators,
            students: students || { x: invigilators.x + invigilators.w + 12, w: 10 },
        };
        for (let i = first; i <= last; i++) words[i].used = 'header';
        headers.push({ first, last, y: title.y, labels });
    }
    return headers;
}

/**
 * How far the header labels sit to the right of the text under them. In some
 * tables every label is indented by the same amount; finding that amount lets
 * each column's start be placed exactly, even when a cell's text does not
 * overlap its label. It is the offset that lines up the most columns.
 */
function labelOffset(labels, bodyWords) {
    const starts = COLUMNS.slice(1).map((c) => labels[c].x);
    const xs = bodyWords.map((w) => w.x);
    const candidates = new Set([0]);
    for (const start of starts) {
        for (const x of xs) {
            const offset = start - x;
            if (Math.abs(offset) <= 20) candidates.add(Math.round(offset * 2) / 2);
        }
    }
    let best = { offset: 0, score: -1 };
    for (const offset of candidates) {
        const score = starts.filter((start) => xs.some((x) => Math.abs(start - offset - x) <= 1.5)).length;
        if (score > best.score || (score === best.score && Math.abs(offset) < Math.abs(best.offset))) best = { offset, score };
    }
    // fewer than three columns agreeing is not evidence of anything
    return best.score >= 3 ? best.offset : 0;
}

/**
 * Where each column starts, for one table on one page. Words never cross a
 * cell border, so a border must sit in a gap that no word covers; for each
 * column it is the last such gap before where that column's text starts.
 */
function columnStarts(labels, bodyWords) {
    const offset = labelOffset(labels, bodyWords);
    const spans = [...COLUMNS.map((c) => labels[c]), ...bodyWords]
        .map((w) => [w.x, w.x + Math.max(w.w, 1)])
        .sort((a, b) => a[0] - b[0]);
    const gaps = [];
    let covered = spans[0][1];
    for (const [from, to] of spans) {
        if (from > covered + 0.5) gaps.push([covered, from]);
        covered = Math.max(covered, to);
    }

    const starts = [-Infinity];
    for (let c = 1; c < COLUMNS.length; c++) {
        const textStart = labels[COLUMNS[c]].x - Math.max(offset, 0);
        const previous = labels[COLUMNS[c - 1]].x - Math.max(offset, 0);
        const fitting = gaps.filter(([from, to]) => to <= textStart + 1.5 && from >= previous);
        const gap = fitting[fitting.length - 1];
        starts.push(gap ? (gap[0] + gap[1]) / 2 : textStart - 3);
    }
    return starts;
}

const cleanCode = (parts) => {
    const text = parts.join(' ').replace(/[^A-Za-z0-9/ ]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
    // "MTG101" -> "MTG 101"
    return text.replace(/\b([A-Z]{2,4})\s*(\d{3})\b/g, '$1 $2');
};
const cleanText = (parts) =>
    parts
        .join(' ')
        .replace(/\s+/g, ' ')
        .replace(/\s+([,.;:])/g, '$1')
        .replace(/\b([A-Za-z])-\s+(?=\w)/g, '$1-') // "E- Business" -> "E-Business"
        .replace(/\b(Mr|Mrs|Ms|Dr|Prof)\.(?=[A-Za-z])/g, '$1. ') // "Mr.Abubacarr" -> "Mr. Abubacarr"
        .trim();

const SERIAL = /^\d+[.)]?$/;
const cell = (parts, warnings, what) => {
    const text = cleanText(parts);
    if (text.length <= MAX_CELL_LENGTH) return text;
    warnings.push(`${what} was cut short: it is far longer than a table cell.`);
    return text.slice(0, MAX_CELL_LENGTH);
};

/**
 * Turn the words under a table header into rows, reading cell by cell.
 * Returns { rows, orphans }: `orphans` are words that came before the first
 * row and belong to none (stray text, or the tail of a row from the page before).
 */
function readRows(bodyWords, labels, warnings, page) {
    if (!bodyWords.length) return { rows: [], orphans: [] };
    const starts = columnStarts(labels, bodyWords);
    const columnOf = (word) => {
        let c = 0;
        while (c + 1 < starts.length && word.x >= starts[c + 1]) c++;
        return c;
    };

    const rows = [];
    const orphans = [];
    let row = null;
    const open = (word) => {
        row = { y: word.y, top: word.y, sn: [], code: [], title: [], lecturer: [], venue: [], invigilators: [], students: [] };
        rows.push(row);
    };
    const pastNumber = () => row && COLUMNS.slice(1).some((c) => row[c].length);
    const pastCode = () => row && COLUMNS.slice(2).some((c) => row[c].length);

    bodyWords.forEach((word, i) => {
        const column = COLUMNS[columnOf(word)];
        if (column === 'sn' && SERIAL.test(word.s)) {
            // a serial number starts a row; "1" then "0" on two lines is one number
            if (!row || pastNumber()) open(word);
            row.sn.push(word.s.replace(/\D/g, ''));
            return;
        }
        // A course code where the previous row is already past its own code starts a
        // row too (a table with no serial numbers). "GEL" followed by "101" counts.
        const next = bodyWords[i + 1];
        const startsCode =
            column === 'code' &&
            (/^[A-Z]{2,4}\d{3}$/.test(word.s) ||
                (/^[A-Z]{2,4}$/.test(word.s) && next && /^\d{3}$/.test(next.s) && COLUMNS[columnOf(next)] === 'code'));
        if (startsCode && (!row || pastCode())) open(word);

        if (!row) {
            orphans.push(word);
            return;
        }
        // A cell has a few lines at most. Anything far below the row (a page number,
        // a footer, a note under the table) is not part of it.
        if (word.y < row.top - 60 || word.y > row.top + 25) {
            orphans.push(word);
            return;
        }
        row.top = Math.max(row.top, word.y);
        row[column].push(word.s);
    });

    const where = (r) => `Page ${page}, exam no. ${r.sn.join('') || '?'}`;
    return {
        orphans,
        rows: rows
            .map((r) => ({
                y: r.y,
                sn: r.sn.join(''),
                code: cleanCode(r.code).slice(0, 40),
                title: cell(r.title, warnings, `${where(r)}: the title`),
                lecturer: cell(r.lecturer, warnings, `${where(r)}: the lecturer`),
                venue: cell(r.venue, warnings, `${where(r)}: the venue`),
                invigilators: cell(r.invigilators, warnings, `${where(r)}: the invigilators`),
                // a number too long for its cell wraps: "28" over "4" is 284
                students: r.students.join('').replace(/\D/g, '').slice(0, 6),
            }))
            .filter((r) => r.code || r.title),
    };
}

/* ------------------------------------------------------------------ */
/* 4. Putting it together                                              */
/* ------------------------------------------------------------------ */

/**
 * A line between y = `from` and y = `to` that looks like a session heading (a
 * weekday and a number) but was not read as one: for telling the admin what
 * the reader could not understand.
 */
function headingLikeLine(words, from, to) {
    const lines = new Map();
    for (const word of words) {
        if (word.used || word.y <= from || word.y >= to) continue;
        const key = Math.round(word.y);
        const line = lines.get(key) || lines.get(key - 1) || lines.get(key + 1);
        if (line) line.push(word);
        else lines.set(key, [word]);
    }
    for (const line of lines.values()) {
        const text = line.map((w) => w.s).join(' ').slice(0, 120);
        if (/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/i.test(text) && /\d/.test(text) && line.length <= 14) return text;
    }
    return null;
}

// Words too small to be the tail of a split row: ordinal endings set as superscripts
const SUPERSCRIPT = /^(st|nd|rd|th)$/i;

/**
 * Words with positions (one list per page) -> exams.
 * Returns { exams: [{ page, sn, code, title, lecturer, venue, invigilators, students, date, start, end, session }], warnings }.
 */
export function parseExamWords(sourcePages) {
    const warnings = [];
    let pages = sourcePages;
    if (pages.length > MAX_PAGES) {
        warnings.push(`Only the first ${MAX_PAGES} pages were read (the file has more).`);
        pages = pages.slice(0, MAX_PAGES);
    }

    const layout = pages.map((source, index) => {
        let words = source.map((w) => ({ ...w }));
        if (words.length > MAX_WORDS_PER_PAGE) {
            warnings.push(`Page ${index + 1} has far more text than a timetable page; only the first ${MAX_WORDS_PER_PAGE} words were read.`);
            words = words.slice(0, MAX_WORDS_PER_PAGE);
        }
        const headings = findHeadings(words, index + 1);

        // drop banner lines such as "WEEK 2 (...)" and "NO EXAMS"
        const lines = new Map(); // rounded y -> words on that line
        for (const word of words) {
            if (word.used) continue;
            const key = Math.round(word.y);
            const line = lines.get(key) || lines.get(key - 1) || lines.get(key + 1);
            if (line) line.push(word);
            else lines.set(key, [word]);
        }
        for (const line of lines.values()) {
            const text = line.map((w) => w.s).join(' ');
            if (text.length <= 400 && BANNER_RE.test(text)) for (const w of line) w.used = 'banner';
        }

        return { words, headings, headers: findTableHeaders(words) };
    });

    datedHeadings(layout.flatMap((p) => p.headings), warnings);

    const exams = [];
    let table = null; // the table being read: { labels, heading }
    let waiting = null; // a heading at the foot of the previous page, with its table still to come

    layout.forEach(({ words, headings, headers }, index) => {
        const page = index + 1;
        const free = (from, to) => words.slice(from, to).filter((w) => !w.used);

        /**
         * Read one stretch of table text. `below` is the y of the header row it sits
         * under on this page (Infinity for rows carried over from the page before).
         */
        const add = (bodyWords, below) => {
            if (!table || !bodyWords.length) return;
            const { rows, orphans } = readRows(bodyWords, table.labels, warnings, page);

            // Text before the first row of a carried-over table may be the tail of a row
            // that was split by the page break. It cannot be re-attached safely, so say so.
            const stray = orphans.filter((w) => !SUPERSCRIPT.test(w.s) && rows.length && w.y > rows[0].y);
            if (below === Infinity && stray.length) {
                warnings.push(
                    `Page ${page} starts with text that is not part of a row ("${stray.slice(0, 6).map((w) => w.s).join(' ')}"). ` +
                        `If a row was split across the page break, check the last exam on page ${page - 1}.`,
                );
            }

            let dropped = 0;
            const noted = new Set();
            for (const row of rows) {
                // A dated heading between the header row and this row means a table whose
                // own header row was not recognised: its rows belong to that heading.
                const between = headings.filter((h) => h.y > row.y && h.y < below).sort((a, b) => a.y - b.y)[0];
                const heading = between || table.heading;
                if (between && between !== table.heading && !noted.has(between)) {
                    noted.add(between);
                    warnings.push(
                        `Page ${page}: the table under "${between.label}" has no header row the reader recognises. ` +
                            'Its rows were read using the columns of the table above; check them.',
                    );
                }
                if (!heading || !heading.date) {
                    dropped++;
                    continue;
                }
                const { y, ...fields } = row;
                exams.push({ page, ...fields, date: heading.date, start: heading.start, end: heading.end, session: heading.label });
            }
            if (dropped && !table.heading) {
                warnings.push(`Page ${page}: ${dropped} row(s) have no dated heading the reader could read above them and were left out.`);
            }
        };

        // rows before the first header carry on the table from the previous page
        add(free(0, headers.length ? headers[0].first : words.length), Infinity);

        headers.forEach((header, h) => {
            // The heading for a table is the nearest one above it on the page - unless
            // another table sits between them, in which case that heading is not its own.
            const above = headings.filter((x) => x.y > header.y).sort((a, b) => a.y - b.y)[0];
            const previousHeader = headers.filter((other) => other.y > header.y).sort((a, b) => a.y - b.y)[0];
            const taken = above && previousHeader && previousHeader.y < above.y;
            // text above this table that looks like a dated heading but could not be read
            const unread = headingLikeLine(words, header.y, previousHeader ? previousHeader.y : Infinity);

            let heading = null;
            if (above && !taken) heading = above;
            else if (!above && waiting) heading = waiting; // its heading was at the foot of the page before
            else if (!above && h === 0 && table && !unread) heading = table.heading; // the header row repeated after a page break
            if (heading === waiting) waiting = null;
            if (!heading) {
                warnings.push(
                    `Page ${page}: a table has no dated heading the reader could read above it` +
                        (unread ? ` (it could not read "${unread}")` : '') +
                        '. Its rows were left out rather than given the wrong date.',
                );
            }
            table = { labels: header.labels, heading };
            add(free(header.last + 1, h + 1 < headers.length ? headers[h + 1].first : words.length), header.y);
        });

        // a heading below every table on the page is waiting for the next page's table
        const lowestHeader = headers.length ? Math.min(...headers.map((h) => h.y)) : Infinity;
        const dangling = headings.filter((x) => x.y < lowestHeader).sort((a, b) => a.y - b.y)[0];
        waiting = dangling || null;
    });

    // serial numbers normally count up by one: a jump suggests a row was misread
    for (let i = 1; i < exams.length; i++) {
        const before = Number(exams[i - 1].sn);
        const now = Number(exams[i].sn);
        if (before && now && now !== before + 1) {
            warnings.push(`Page ${exams[i].page}: serial number ${now} follows ${before}. Check the rows around it.`);
        }
    }
    for (const exam of exams) {
        if (!exam.code) warnings.push(`Page ${exam.page}: "${exam.title}" (no. ${exam.sn || '?'}) has no course code in the file.`);
    }
    if (warnings.length > MAX_WARNINGS) {
        const extra = warnings.length - MAX_WARNINGS;
        warnings.length = MAX_WARNINGS;
        warnings.push(`...and ${extra} more notes like these.`);
    }
    return { exams, warnings };
}

/**
 * Exam timetable PDF -> rows for the `exams` table:
 * [dept, course_code, course_title, date, start_time, end_time, venue, lecturer]
 * `rows.warnings` lists anything that was corrected or looked wrong.
 */
export async function parseExamPdf(pathToPdf, deptGuess = 'UNKNOWN') {
    const { exams, warnings } = parseExamWords(await readPdfWords(pathToPdf));
    const rows = exams.map((e) => [deptGuess, e.code, e.title, e.date, e.start, e.end, e.venue, e.lecturer]);
    rows.warnings = warnings;
    return rows;
}
