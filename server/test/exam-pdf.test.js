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
