// The exam timetable PDF reader, tested on hand-made "words with positions"
// that copy the quirks of a real UTG exam timetable (no real file is needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExamWords } from '../../ingest/parsers/examPdf.js';

const CHAR = 5;
/** Words of one line of text, left to right from x. */
function line(y, x, text) {
    const words = [];
    for (const s of text.split(' ')) {
        words.push({ s, x, y, w: s.length * CHAR });
        x += s.length * CHAR + 4;
    }
    return words;
}
const word = (s, x, y) => ({ s, x, y, w: s.length * CHAR });

// column positions of the body text
const X = { sn: 30, code: 60, title: 115, lecturer: 250, venue: 360, invigilators: 420, students: 495 };
const header = (y) => [
    word('S/n', X.sn, y), word('Code', X.code, y), word('Title', X.title, y), word('Lecturer', X.lecturer, y),
    word('Venue', X.venue, y), word('Invigilators', X.invigilators, y), word('No.', X.students, y), word('Students', X.students, y - 12),
];
/** One table row; each cell may have a second line. */
function row(y, cells, x = X) {
    const out = [];
    for (const column of Object.keys(X)) {
        const [first, second] = [].concat(cells[column] ?? '');
        if (first) out.push(...line(y, x[column], first));
        if (second) out.push(...line(y - 13, x[column], second));
    }
    return out;
}

// A PDF stores the headings of a page first, then its tables.
const PAGE_1 = [
    ...line(660, 144, 'Tuesday 1st December 2026, 9:00am - 11:00am'),
    ...line(500, 144, 'Tuesday 8th December 2025 15:00 - 17:00'), // the year is a typo in the file
    ...line(120, 144, 'Wednesday 9th December 2026. 11:00 - 1:00'), // its table starts on the next page
    ...header(630),
    ...row(597, { sn: '1', code: ['GEL', '101'], title: 'Use of English I', lecturer: 'Mr. Kebba Sowe', venue: 'Theater', invigilators: 'All', students: '242' }),
    ...row(560, { sn: '2', code: 'INS 420', title: ['Geographic Information', 'Systems'], lecturer: 'Mr. Alieu Njie', venue: 'Theater', invigilators: 'All', students: '10' }),
    // second table: misspelt labels that sit to the right of the text below them
    word('S/', 30, 480), word('n', 30, 468), word('Cod', 70, 480), word('e', 70, 468), word('Title', 125, 480),
    word('Vecturer', 262, 480), word('Lenue', 372, 480), word('Invigilator', 430, 480), word('s', 430, 468), word('No.Students', 500, 480),
    ...row(450, { sn: ['1', '0'], code: 'MTG101', title: 'Calculus I', lecturer: 'Mr.Modou Sarr', venue: 'Theater', invigilators: 'All', students: ['28', '4'] },
        { sn: 30, code: 58, title: 112, lecturer: 250, venue: 362, invigilators: 418, students: 495 }),
    // third table: only its header fits on this page
    ...header(100),
];
const PAGE_2 = [
    ...line(450, 129, 'WEEK 2 (Mon. 7 to Sat. 12 Dec. 2026)'), word('th', 300, 458),
    ...line(520, 79, 'FRIDAY 4 DEC. 2026 AND SATURDAY 5 DEC. 2026'), word('TH', 62, 527),
    ...line(497, 268, 'NO EXAMS'),
    ...line(400, 144, 'Thursday, 10th December 2026. 12:00pm - 14:00pm'),
    ...row(700, { sn: '11', code: 'CPS 402', title: 'Computational Mathematics', lecturer: ['Dr. Awa Mariama', 'Ceesay'], venue: 'Theater', invigilators: 'All', students: '53' }),
    ...row(660, { sn: '12', code: '`', title: ['Principles and Operations', 'of Wireless Networks'], lecturer: 'Mr. Lamin Jobe', venue: 'Theater', invigilators: 'All', students: '2' }),
    ...header(380),
    ...row(345, { sn: '13', code: ['TEL', '303'], title: 'E- Business for Development', lecturer: 'Mr. Lamin Jobe', venue: 'Hall B', invigilators: 'All', students: '1' }),
];

const { exams, warnings } = parseExamWords([PAGE_1, PAGE_2]);
const bySn = Object.fromEntries(exams.map((e) => [e.sn, e]));

test('reads every row once, in order', () => {
    assert.deepEqual(exams.map((e) => e.sn), ['1', '2', '10', '11', '12', '13']);
});

test('puts each cell in its column, joining text that wraps inside a cell', () => {
    assert.deepEqual(
        { ...bySn['2'], session: undefined },
        {
            page: 1, sn: '2', code: 'INS 420', title: 'Geographic Information Systems', lecturer: 'Mr. Alieu Njie',
            venue: 'Theater', invigilators: 'All', students: '10', date: '2026-12-01', start: '09:00', end: '11:00', session: undefined,
        },
    );
    assert.equal(bySn['1'].code, 'GEL 101');
    assert.equal(bySn['1'].title, 'Use of English I');
    assert.equal(bySn['1'].students, '242');
});

test('copes with misspelt header labels, labels offset from the text, and numbers split over two lines', () => {
    const exam = bySn['10'];
    assert.equal(exam.code, 'MTG 101');
    assert.equal(exam.title, 'Calculus I');
    assert.equal(exam.lecturer, 'Mr. Modou Sarr');
    assert.equal(exam.venue, 'Theater');
    assert.equal(exam.students, '284');
});

test('corrects a year that contradicts the weekday beside it, and says so', () => {
    assert.equal(bySn['10'].date, '2026-12-08');
    assert.equal(bySn['10'].start, '15:00');
    assert.ok(warnings.some((w) => /Tuesday 8th December 2025.*read as 2026/.test(w)), warnings.join('\n'));
});

test('carries a table over a page break, under the heading from the foot of the previous page', () => {
    for (const sn of ['11', '12']) {
        assert.equal(bySn[sn].page, 2);
        assert.equal(bySn[sn].date, '2026-12-09');
        // "11:00 - 1:00" ends at one in the afternoon
        assert.deepEqual([bySn[sn].start, bySn[sn].end], ['11:00', '13:00']);
    }
    assert.equal(bySn['11'].title, 'Computational Mathematics');
    assert.equal(bySn['11'].lecturer, 'Dr. Awa Mariama Ceesay');
});

test('ignores banners between tables, and keeps a row whose course code is missing', () => {
    assert.equal(bySn['12'].code, '');
    assert.equal(bySn['12'].title, 'Principles and Operations of Wireless Networks');
    assert.ok(warnings.some((w) => /no course code/.test(w)));
    // nothing from "WEEK 2 ...", "FRIDAY ... SATURDAY ..." or "NO EXAMS" leaked into a row
    assert.doesNotMatch(JSON.stringify(exams), /WEEK|FRIDAY|SATURDAY|NO EXAMS|\bTH\b/);
});

test('reads am/pm times, including "14:00pm", and tidies spacing', () => {
    const exam = bySn['13'];
    assert.deepEqual([exam.date, exam.start, exam.end], ['2026-12-10', '12:00', '14:00']);
    assert.equal(exam.code, 'TEL 303');
    assert.equal(exam.title, 'E-Business for Development');
    assert.equal(exam.venue, 'Hall B');
});

test('flags a jump in the serial numbers', () => {
    assert.ok(warnings.some((w) => /serial number 10 follows 2/.test(w)), warnings.join('\n'));
});

test('a page with no timetable on it gives no rows', () => {
    const notes = [line(700, 72, 'NOTES for Students: (1st to 19 th Dec.2026)'), line(680, 72, '1. Students must come along with valid identification.')].flat();
    assert.deepEqual(parseExamWords([notes]), { exams: [], warnings: [] });
});

// ---- files that are not as tidy as the real one ----

const read = (...pages) => parseExamWords(pages);
const one = (cells) => ({ invigilators: 'All', students: '10', venue: 'Theater', lecturer: 'Mr. Kebba Sowe', ...cells });

test('afternoon sessions written without am/pm are not stored as the small hours', () => {
    const { exams } = read([
        ...line(660, 144, 'Monday 7th December 2026 2:00 - 4:00'),
        ...line(500, 144, 'Monday 7th December 2026 9:00 - 1:00'),
        ...header(630),
        ...row(597, one({ sn: '1', code: 'ICT 101', title: 'Introduction to ICT' })),
        ...header(480),
        ...row(450, one({ sn: '2', code: 'ICT 102', title: 'Computing' })),
    ]);
    assert.deepEqual(exams.map((e) => [e.start, e.end]), [['14:00', '16:00'], ['09:00', '13:00']]);
});

test('a heading it cannot read leaves the table out, instead of giving it the previous date', () => {
    const { exams, warnings } = read([
        ...line(660, 144, 'Monday 7th December 2026 9:00 - 11:00'),
        ...line(500, 144, 'Tues 8/12/26 from nine'), // not a form the reader knows
        ...header(630),
        ...row(597, one({ sn: '1', code: 'ICT 101', title: 'Introduction to ICT' })),
        ...header(480),
        ...row(450, one({ sn: '2', code: 'ICT 102', title: 'Computing' })),
    ]);
    assert.deepEqual(exams.map((e) => [e.sn, e.date]), [['1', '2026-12-07']]);
    assert.ok(warnings.some((w) => /could not read "Tues 8\/12\/26 from nine"/.test(w) && /left out/.test(w)), warnings.join('\n'));
});

test('a table whose header row is not recognised still gets the heading above it, with a note', () => {
    const { exams, warnings } = read([
        ...line(660, 144, 'Monday 7th December 2026 9:00 - 11:00'),
        ...line(500, 144, 'Tuesday 8th December 2026 9:00 - 11:00'),
        ...header(630),
        ...row(597, one({ sn: '1', code: 'ICT 101', title: 'Introduction to ICT' })),
        // header row in another wording: "No | Course | Subject | ..."
        word('No', 30, 480), word('Course', 60, 480), word('Subject', 115, 480), word('Staff', 250, 480), word('Place', 360, 480),
        ...row(450, one({ sn: '2', code: 'ICT 102', title: 'Computing' })),
    ]);
    assert.deepEqual(exams.map((e) => [e.sn, e.code, e.date]), [['1', 'ICT 101', '2026-12-07'], ['2', 'ICT 102', '2026-12-08']]);
    assert.ok(warnings.some((w) => /no header row the reader recognises/.test(w)));
});

test('serial numbers written "3." are read, and a table with none is split on course codes', () => {
    const dotted = read([
        ...line(660, 144, 'Monday 7th December 2026 9:00 - 11:00'),
        ...header(630),
        ...row(597, one({ sn: '3.', code: 'ICT 101', title: 'Introduction to ICT' })),
        ...row(560, one({ sn: '4)', code: 'ICT 102', title: 'Computing' })),
    ]);
    assert.deepEqual(dotted.exams.map((e) => [e.sn, e.code]), [['3', 'ICT 101'], ['4', 'ICT 102']]);

    const none = read([
        ...line(660, 144, 'Monday 7th December 2026 9:00 - 11:00'),
        ...header(630),
        ...row(597, one({ code: ['GEL', '101'], title: 'Use of English I' })),
        ...row(560, one({ code: 'ICT102', title: ['Introduction to', 'Computing'] })),
    ]);
    assert.deepEqual(none.exams.map((e) => [e.code, e.title]), [['GEL 101', 'Use of English I'], ['ICT 102', 'Introduction to Computing']]);
});

test('page numbers, footers and unknown banners never end up inside a row', () => {
    const { exams } = read([
        ...line(660, 144, 'Monday 7th December 2026 9:00 - 11:00'),
        ...line(300, 40, 'EXAM BREAK'), // a banner the reader has no rule for, at the left margin
        ...header(630),
        ...row(597, one({ sn: '1', code: 'ICT 101', title: 'Introduction to ICT' })),
        ...line(40, 115, 'Page 2 of 12'),
        ...line(60, 250, 'Registrar'),
    ]);
    assert.equal(exams.length, 1);
    assert.equal(exams[0].title, 'Introduction to ICT');
    assert.equal(exams[0].lecturer, 'Mr. Kebba Sowe');
    assert.doesNotMatch(JSON.stringify(exams), /Page|Registrar|EXAM|BREAK/);
});

test('a header row repeated at the top of the next page continues the same session', () => {
    const { exams } = read(
        [
            ...line(660, 144, 'Monday 7th December 2026 9:00 - 11:00'),
            ...header(630),
            ...row(597, one({ sn: '1', code: 'ICT 101', title: 'Introduction to ICT' })),
        ],
        [
            ...header(700),
            ...row(667, one({ sn: '2', code: 'ICT 102', title: 'Computing' })),
        ],
    );
    assert.deepEqual(exams.map((e) => [e.sn, e.page, e.date]), [['1', 1, '2026-12-07'], ['2', 2, '2026-12-07']]);
});

test('a one-row table whose labels sit to the right of the text is still split into the right columns', () => {
    const { exams } = read([
        ...line(660, 144, 'Monday 7th December 2026 9:00 - 11:00'),
        // every label 14 to the right of the cell text below it, and not overlapping it
        word('S/n', 44, 630), word('Code', 74, 630), word('Title', 129, 630), word('Lecturer', 264, 630),
        word('Venue', 374, 630), word('Invigilators', 434, 630), word('No.', 509, 630),
        ...row(597, { sn: '1', code: 'IT1', title: 'Law', lecturer: 'Li Wu', venue: 'Hall', invigilators: 'All', students: '9' }),
    ]);
    assert.deepEqual(
        exams.map((e) => [e.sn, e.title, e.lecturer, e.venue, e.invigilators, e.students]),
        [['1', 'Law', 'Li Wu', 'Hall', 'All', '9']],
    );
});

test('a cell that is really a paragraph is cut short and flagged, and a huge page is capped', () => {
    // 120 words crammed into one title cell
    const essay = Array.from({ length: 120 }, (_, i) => word(`word${i}`, 115, 597 - (i % 3) * 13));
    const { exams, warnings } = read([
        ...line(660, 144, 'Monday 7th December 2026 9:00 - 11:00'),
        ...header(630),
        word('1', 30, 597), word('ICT', 60, 597), word('101', 60, 584),
        ...essay,
        word('Theater', 360, 597), word('All', 420, 597), word('10', 495, 597),
    ]);
    assert.ok(exams[0].title.length <= 200);
    assert.ok(warnings.some((w) => /cut short/.test(w)));

    const flood = Array.from({ length: 50000 }, (_, i) => word('x', 100 + (i % 400), 700 - (i % 600)));
    const started = Date.now();
    const result = read(flood);
    assert.ok(Date.now() - started < 3000, 'a page of junk is dealt with quickly');
    assert.ok(result.warnings.some((w) => /far more text than a timetable page/.test(w)));
});

test('pathological heading text does not stall the reader', () => {
    const page = [
        ...Array.from({ length: 4000 }, (_, i) => word(i % 2 ? 'Monday' : '7th', 40 + (i % 50) * 8, 700 - Math.floor(i / 50) * 9)),
        ...line(100, 144, 'Monday 7th December 2026 9:00 - 11:00'),
    ];
    const started = Date.now();
    read(page);
    assert.ok(Date.now() - started < 3000);
});

test('a table at the top of a page under a heading it cannot read is left out, not given the previous page\'s date', () => {
    for (const heading of ['Tuesday 8th December 2026 9am - 11am', 'TUESDAY 8TH DECEMBER 2026 (MORNING SESSION)']) {
        const { exams, warnings } = read(
            [
                ...line(660, 144, 'Monday 7th December 2026 9:00 - 11:00'),
                ...header(630),
                ...row(597, one({ sn: '1', code: 'ICT 101', title: 'Introduction to ICT' })),
            ],
            [
                ...line(720, 144, heading),
                ...header(700),
                ...row(667, one({ sn: '2', code: 'ICT 102', title: 'Computing' })),
            ],
        );
        assert.deepEqual(exams.map((e) => e.code), ['ICT 101'], heading);
        assert.ok(warnings.some((w) => /could not read/.test(w) && /left out/.test(w)), warnings.join('\n'));
    }
});

test('two tables under one heading share its date', () => {
    const { exams, warnings } = read([
        ...line(660, 144, 'Monday 7th December 2026 9:00 - 11:00'),
        ...header(630),
        ...row(597, one({ sn: '1', code: 'ICT 101', title: 'Introduction to ICT' })),
        ...header(540),
        ...row(507, one({ sn: '2', code: 'ICT 102', title: 'Computing' })),
    ]);
    assert.deepEqual(exams.map((e) => [e.code, e.date]), [['ICT 101', '2026-12-07'], ['ICT 102', '2026-12-07']]);
    assert.deepEqual(warnings, []);
});

