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

/* ------------------------------------------------------------------ */
/* 1. PDF -> words with positions                                      */
/* ------------------------------------------------------------------ */

/** Every page as a list of words: { s, x, y, w }, in the order the PDF stores them. */
export async function readPdfWords(pathToPdf) {
    const pages = [];
    const pagerender = (pageData) =>
        pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false }).then((content) => {
            pages.push(
                content.items
                    .map((item) => ({
                        s: String(item.str || '').trim(),
                        x: item.transform[4],
                        y: item.transform[5],
                        w: Number(item.width) || 0,
                    }))
                    .filter((word) => word.s),
            );
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
        // "11:00 - 1:00" means one o'clock in the afternoon
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
        let students = null;
        for (let i = last + 1; i < words.length && i - last <= 4; i++) {
            const w = words[i];
            if (w.used || Math.abs(w.y - title.y) > 16 || !/^(s|no\.?|students|no\.\s*students)$/i.test(w.s)) break;
            if (!students && /^no/i.test(w.s)) students = w;
            last = i;
        }

        const between = words
            .slice(t + 1, words.indexOf(invigilators))
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
 * Where each column starts, for one table on one page. Words never cross a
 * cell border, so a border must sit in a gap that no word covers; for each
 * column it is the last such gap before that column's label.
 */
function columnStarts(labels, bodyWords) {
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
        const label = labels[COLUMNS[c]];
        const previous = labels[COLUMNS[c - 1]];
        const fitting = gaps.filter(([from, to]) => to <= label.x + 1 && from >= previous.x);
        const gap = fitting[fitting.length - 1];
        starts.push(gap ? (gap[0] + gap[1]) / 2 : label.x - 3);
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

/** Turn the words under a table header into rows, reading cell by cell. */
function readRows(bodyWords, labels) {
    if (!bodyWords.length) return [];
    const starts = columnStarts(labels, bodyWords);
    const columnOf = (word) => {
        let c = 0;
        while (c + 1 < starts.length && word.x >= starts[c + 1]) c++;
        return c;
    };

    const rows = [];
    let row = null;
    const open = () => {
        row = { sn: [], code: [], title: [], lecturer: [], venue: [], invigilators: [], students: [] };
        rows.push(row);
    };
    const pastNumber = () => row && COLUMNS.slice(1).some((c) => row[c].length);

    for (const word of bodyWords) {
        const column = COLUMNS[columnOf(word)];
        if (column === 'sn' && /^\d+$/.test(word.s)) {
            // a serial number starts a row; "1" then "0" on two lines is one number
            if (!row || pastNumber()) open();
            row.sn.push(word.s);
            continue;
        }
        if (!row) {
            // words before the first row belong to no table (stray text on the page)
            if (column === 'code' && /^([A-Z]{3,4}|[A-Z]{2,4}\d{3})$/.test(word.s)) open();
            else continue;
        }
        row[column].push(word.s);
    }

    return rows
        .map((r) => ({
            sn: r.sn.join(''),
            code: cleanCode(r.code),
            title: cleanText(r.title),
            lecturer: cleanText(r.lecturer),
            venue: cleanText(r.venue),
            invigilators: cleanText(r.invigilators),
            // a number too long for its cell wraps: "28" over "4" is 284
            students: r.students.join('').replace(/\D/g, ''),
        }))
        .filter((r) => r.code || r.title);
}

/* ------------------------------------------------------------------ */
/* 4. Putting it together                                              */
/* ------------------------------------------------------------------ */

/**
 * Words with positions (one list per page) -> exams.
 * Returns { exams: [{ page, sn, code, title, lecturer, venue, invigilators, students, date, start, end, session }], warnings }.
 */
export function parseExamWords(pages) {
    const warnings = [];
    const layout = pages.map((source, index) => {
        const words = source.map((w) => ({ ...w }));
        const headings = findHeadings(words, index + 1);

        // drop banner lines such as "WEEK 2 (...)" and "NO EXAMS"
        const lines = [];
        for (const word of words) {
            if (word.used) continue;
            const line = lines.find((l) => Math.abs(l[0].y - word.y) <= 1.5);
            if (line) line.push(word);
            else lines.push([word]);
        }
        for (const line of lines) {
            if (BANNER_RE.test(line.map((w) => w.s).join(' '))) for (const w of line) w.used = 'banner';
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
        const add = (bodyWords) => {
            if (!table || !bodyWords.length) return;
            const rows = readRows(bodyWords, table.labels);
            if (rows.length && !table.heading) {
                warnings.push(`Page ${page}: ${rows.length} row(s) have no dated heading above them and were left out.`);
                return;
            }
            if (rows.length && !table.heading.date) return;
            for (const row of rows) {
                exams.push({
                    page,
                    ...row,
                    date: table.heading.date,
                    start: table.heading.start,
                    end: table.heading.end,
                    session: table.heading.label,
                });
            }
        };

        // rows before the first header carry on the table from the previous page
        add(free(0, headers.length ? headers[0].first : words.length));

        headers.forEach((header, h) => {
            // the heading for a table is the nearest one above it on the page
            const above = headings.filter((x) => x.y > header.y).sort((a, b) => a.y - b.y)[0];
            const heading = above || waiting || null;
            if (!heading) warnings.push(`Page ${page}: a table has no dated heading above it.`);
            if (heading === waiting) waiting = null;
            table = { labels: header.labels, heading };
            add(free(header.last + 1, h + 1 < headers.length ? headers[h + 1].first : words.length));
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
