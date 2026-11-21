// Made-up timetable data for the answer-quality evaluation (see README.md here).
//
// Nothing in this file comes from a real timetable. The course codes and titles
// are in the style UTG uses; the lecturers are invented, and any likeness to a
// real person is accidental. Keep it that way: this file is committed, real
// timetables are not.
//
// The expected answers in questions.js are written against these rows, so a
// change here usually means a change there. `node scripts/eval.js --list`
// checks the two files against each other without calling the model.
//
// Things that are deliberate:
//   - Three departments (CS, INS, LAW) have classes on every day from Monday to
//     Saturday, so a broad question ("what is on Thursday?") has to be answered
//     with "Which department do you want?". Nothing is on Sunday.
//   - Artificial Intelligence is CPS 313 and CPS 416 is another course. An
//     assistant that assumes a code for "AI" gets those questions wrong.
//   - Some courses meet twice a week (CPS 313, ICT 202, INS 302, LAW 203).
//   - Dr. Kujabi teaches in two departments.
//   - Exams are in January 2099, so they are "upcoming" whenever this runs. Two
//     exams are in 2020, so they have always "already been written".
//   - MTH 203 has classes but no exam.

/** Semester label on every row. The server tests use the same one. */
export const SEMESTER = 'S1';

export const CLASS_SOURCE = 'eval-classes.xlsx';
export const EXAM_SOURCE = 'eval-exams.xlsx';

const klass = (dept, course_code, course_title, day, start_time, end_time, venue, lecturer) => ({
    dept, course_code, course_title, day, start_time, end_time, venue, lecturer,
});

/** Weekly classes. day is Mon..Sat, times are HH:MM. */
export const CLASSES = [
    // ---- CS ----
    klass('CS', 'CPS 313', 'Artificial Intelligence', 'Mon', '08:30', '11:00', 'Computer Lab 2', 'Dr. Binta Marong'),
    klass('CS', 'CPS 304', 'Operating Systems', 'Mon', '11:30', '14:00', 'Chancery Hall A', 'Mr. Dembo Sowe'),
    klass('CS', 'ICT 202', 'Computer Programming II', 'Mon', '14:30', '17:00', 'Computer Lab 1', 'Ms. Haddy Colley'),
    klass('CS', 'CPS 404', 'Data Communications and Network', 'Tue', '08:30', '11:00', 'Chancery Hall A', 'Mr. Dembo Sowe'),
    klass('CS', 'CPS 305', 'Software Engineering', 'Tue', '11:30', '14:00', 'Lecture Room 4', 'Prof. Kebba Dampha'),
    klass('CS', 'ICT 210', 'Data Structures and Algorithms', 'Tue', '14:30', '17:00', 'Computer Lab 2', 'Dr. Binta Marong'),
    klass('CS', 'ICT 110', 'Introduction to Programming', 'Wed', '08:30', '11:00', 'Lecture Room 2', 'Ms. Haddy Colley'),
    klass('CS', 'CPS 403', 'Cloud Computing', 'Wed', '11:30', '14:00', 'Chancery Hall B', 'Mr. Dembo Sowe'),
    klass('CS', 'CPS 416', 'Compiler Construction', 'Wed', '14:30', '17:00', 'Lecture Room 4', 'Prof. Kebba Dampha'),
    klass('CS', 'CPS 405', 'Database Systems II', 'Thu', '08:30', '11:00', 'Computer Lab 2', 'Dr. Binta Marong'),
    klass('CS', 'CPS 330', 'Human Computer Interaction', 'Thu', '11:30', '14:00', 'Chancery Hall B', 'Dr. Jainaba Kujabi'),
    klass('CS', 'MTH 203', 'Linear Algebra', 'Thu', '14:30', '17:00', 'Chancery Hall A', 'Mr. Modou Jarju'),
    klass('CS', 'ICT 202', 'Computer Programming II', 'Fri', '09:00', '11:00', 'Computer Lab 1', 'Ms. Haddy Colley'),
    klass('CS', 'CPS 302', 'Automata and Languages', 'Fri', '11:30', '14:00', 'Lecture Room 4', 'Prof. Kebba Dampha'),
    klass('CS', 'CPS 313', 'Artificial Intelligence', 'Sat', '10:00', '12:00', 'Computer Lab 2', 'Dr. Binta Marong'),
    klass('CS', 'CPS 417', 'Big Data Analytics', 'Sat', '12:30', '14:30', 'Chancery Hall A', 'Mr. Dembo Sowe'),

    // ---- INS ----
    klass('INS', 'INS 302', 'Systems Analysis and Design', 'Mon', '08:30', '11:00', 'Lecture Room 2', 'Mr. Saikou Manjang'),
    klass('INS', 'INS 410', 'Information Security and Auditing', 'Mon', '14:30', '17:00', 'Kanifing Annex', 'Dr. Jainaba Kujabi'),
    klass('INS', 'INS 312', 'E-Business for Development', 'Tue', '08:30', '11:00', 'Lecture Room 2', 'Mrs. Ndey Bojang'),
    klass('INS', 'INS 311', 'Data Engineering', 'Tue', '14:30', '17:00', 'Kanifing Annex', 'Mr. Saikou Manjang'),
    klass('INS', 'INS 403', 'Computer Forensics', 'Wed', '08:30', '11:00', 'Kanifing Annex', 'Dr. Jainaba Kujabi'),
    klass('INS', 'MGT 110', 'Introduction to Management', 'Wed', '11:30', '14:00', 'Lecture Room 2', 'Mrs. Ndey Bojang'),
    klass('INS', 'INS 420', 'Geographic Information Systems', 'Thu', '08:30', '11:00', 'Kanifing Annex', 'Mr. Saikou Manjang'),
    klass('INS', 'INS 303', 'Information Resource Management', 'Thu', '14:30', '17:00', 'Lecture Room 2', 'Mrs. Ndey Bojang'),
    klass('INS', 'INS 411', 'Entrepreneurship and Digital Innovation', 'Fri', '08:30', '11:00', 'Chancery Hall B', 'Mrs. Ndey Bojang'),
    klass('INS', 'INS 302', 'Systems Analysis and Design', 'Fri', '14:30', '17:00', 'Lecture Room 2', 'Mr. Saikou Manjang'),
    klass('INS', 'INS 315', 'Research Methodology in IT', 'Sat', '09:00', '11:00', 'Kanifing Annex', 'Dr. Jainaba Kujabi'),
    klass('INS', 'INS 304', 'Project Management', 'Sat', '11:30', '13:30', 'Lecture Room 2', 'Mr. Saikou Manjang'),

    // ---- LAW ----
    klass('LAW', 'LAW 101', 'Legal Methods', 'Mon', '08:30', '11:00', 'Law Auditorium', 'Dr. Yankuba Sonko'),
    klass('LAW', 'LAW 203', 'Constitutional Law', 'Mon', '11:30', '14:00', 'Law Auditorium', 'Ms. Mariama Nyassi'),
    klass('LAW', 'LAW 205', 'Law of Contract', 'Tue', '08:30', '11:00', 'Law Auditorium', 'Mr. Alieu Sarr'),
    klass('LAW', 'LAW 301', 'Criminal Law', 'Tue', '11:30', '14:00', 'Moot Court', 'Dr. Yankuba Sonko'),
    klass('LAW', 'LAW 310', 'Family Law', 'Tue', '14:30', '17:00', 'Law Auditorium', 'Mr. Alieu Sarr'),
    klass('LAW', 'LAW 307', 'Law of Torts', 'Wed', '08:30', '11:00', 'Law Auditorium', 'Ms. Mariama Nyassi'),
    klass('LAW', 'LAW 309', 'Land Law', 'Wed', '14:30', '17:00', 'Moot Court', 'Mr. Alieu Sarr'),
    klass('LAW', 'LAW 402', 'Law of Evidence', 'Thu', '08:30', '11:00', 'Moot Court', 'Dr. Yankuba Sonko'),
    klass('LAW', 'LAW 405', 'Company Law', 'Thu', '11:30', '14:00', 'Law Auditorium', 'Mr. Alieu Sarr'),
    klass('LAW', 'LAW 203', 'Constitutional Law', 'Fri', '08:30', '11:00', 'Law Auditorium', 'Ms. Mariama Nyassi'),
    klass('LAW', 'LAW 412', 'Human Rights Law', 'Fri', '11:30', '14:00', 'Moot Court', 'Ms. Mariama Nyassi'),
    klass('LAW', 'LAW 420', 'Legal Drafting and Advocacy', 'Sat', '09:00', '11:00', 'Moot Court', 'Dr. Yankuba Sonko'),
];

const exam = (dept, course_code, course_title, date, start_time, end_time, venue, lecturer) => ({
    dept, course_code, course_title, date, start_time, end_time, venue, lecturer,
});

/** Exam sittings. date is YYYY-MM-DD. 12 January 2099 is a Monday. */
export const EXAMS = [
    // ---- still to come, whenever this runs ----
    exam('CS', 'CPS 313', 'Artificial Intelligence', '2099-01-12', '09:00', '11:00', 'Exam Hall 1', 'Dr. Binta Marong'),
    exam('CS', 'CPS 304', 'Operating Systems', '2099-01-12', '12:00', '14:00', 'Exam Hall 1', 'Mr. Dembo Sowe'),
    exam('INS', 'INS 302', 'Systems Analysis and Design', '2099-01-12', '15:00', '17:00', 'Exam Hall 2', 'Mr. Saikou Manjang'),
    exam('CS', 'ICT 202', 'Computer Programming II', '2099-01-13', '09:00', '11:00', 'Exam Hall 2', 'Ms. Haddy Colley'),
    exam('LAW', 'LAW 203', 'Constitutional Law', '2099-01-13', '09:00', '12:00', 'Law Auditorium', 'Ms. Mariama Nyassi'),
    exam('INS', 'INS 410', 'Information Security and Auditing', '2099-01-13', '12:00', '14:00', 'Exam Hall 1', 'Dr. Jainaba Kujabi'),
    exam('LAW', 'LAW 301', 'Criminal Law', '2099-01-14', '09:00', '12:00', 'Law Auditorium', 'Dr. Yankuba Sonko'),
    exam('CS', 'CPS 404', 'Data Communications and Network', '2099-01-14', '15:00', '17:00', 'Exam Hall 1', 'Mr. Dembo Sowe'),
    exam('CS', 'CPS 305', 'Software Engineering', '2099-01-15', '09:00', '11:00', 'Exam Hall 2', 'Prof. Kebba Dampha'),
    exam('INS', 'INS 403', 'Computer Forensics', '2099-01-15', '12:00', '14:00', 'Exam Hall 1', 'Dr. Jainaba Kujabi'),
    exam('LAW', 'LAW 205', 'Law of Contract', '2099-01-16', '09:00', '12:00', 'Law Auditorium', 'Mr. Alieu Sarr'),
    exam('CS', 'CPS 405', 'Database Systems II', '2099-01-16', '12:00', '14:00', 'Exam Hall 1', 'Dr. Binta Marong'),
    exam('CS', 'CPS 416', 'Compiler Construction', '2099-01-19', '09:00', '11:00', 'Exam Hall 2', 'Prof. Kebba Dampha'),
    exam('INS', 'INS 420', 'Geographic Information Systems', '2099-01-20', '09:00', '11:00', 'Exam Hall 2', 'Mr. Saikou Manjang'),
    exam('LAW', 'LAW 402', 'Law of Evidence', '2099-01-21', '09:00', '12:00', 'Moot Court', 'Dr. Yankuba Sonko'),

    // ---- already written, whenever this runs ----
    exam('CS', 'ICT 110', 'Introduction to Programming', '2020-01-10', '09:00', '11:00', 'Exam Hall 1', 'Ms. Haddy Colley'),
    exam('LAW', 'LAW 101', 'Legal Methods', '2020-01-13', '09:00', '12:00', 'Law Auditorium', 'Dr. Yankuba Sonko'),
];

/** Exams with a date before this count as past. Any date between 2021 and 2098 would do. */
const PAST_BEFORE = '2021-01-01';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** Weekday ("Mon".."Sun") of a YYYY-MM-DD date. */
export const dayOfDate = (dateISO) => DAYS[(new Date(`${dateISO}T12:00:00Z`).getUTCDay() + 6) % 7];

const unique = (list) => [...new Set(list)];
const has = (value, part) => String(value).toLowerCase().includes(String(part).toLowerCase());

/**
 * Class rows that fit a filter. Every key is optional:
 *   { dept, day (one day or a list), lecturer (part of the name), venue (part of the name), code }
 */
export function classRows({ dept, day, lecturer, venue, code } = {}) {
    const days = day ? [].concat(day) : null;
    return CLASSES.filter(
        (row) =>
            (!dept || row.dept === dept) &&
            (!days || days.includes(row.day)) &&
            (!lecturer || has(row.lecturer, lecturer)) &&
            (!venue || has(row.venue, venue)) &&
            (!code || row.course_code === code),
    );
}

/** Course codes of the classes that fit a filter, without repeats. See classRows. */
export const classCodes = (filter) => unique(classRows(filter).map((row) => row.course_code));

/**
 * Exam rows that fit a filter. Every key is optional:
 *   { dept, date, day (weekday of the date), lecturer, venue, code, upcoming (true = leave out past exams) }
 */
export function examRows({ dept, date, day, lecturer, venue, code, upcoming } = {}) {
    return EXAMS.filter(
        (row) =>
            (!dept || row.dept === dept) &&
            (!date || row.date === date) &&
            (!day || dayOfDate(row.date) === day) &&
            (!lecturer || has(row.lecturer, lecturer)) &&
            (!venue || has(row.venue, venue)) &&
            (!code || row.course_code === code) &&
            (!upcoming || row.date >= PAST_BEFORE),
    );
}

/** Course codes of the exams that fit a filter, without repeats. See examRows. */
export const examCodes = (filter) => unique(examRows(filter).map((row) => row.course_code));

/** Departments that have a class on a day, e.g. ["CS", "INS", "LAW"]. */
export const departmentsOn = (day) => unique(classRows({ day }).map((row) => row.dept));

/**
 * Put the fixture into an open better-sqlite3 database that already has the
 * app's tables (timetable, exams, sources). Uses the same columns as
 * server/test/helpers.js, plus the lecturer of each exam.
 */
export function insertFixture(db, { semester = SEMESTER } = {}) {
    const insertClass = db.prepare(`
      INSERT INTO timetable (dept,course_code,course_title,day,start_time,end_time,venue,lecturer,source_file,semester)
      VALUES (@dept,@course_code,@course_title,@day,@start_time,@end_time,@venue,@lecturer,@source_file,@semester)`);
    const insertExam = db.prepare(`
      INSERT INTO exams (dept,course_code,course_title,date,start_time,end_time,venue,lecturer,source_file,semester)
      VALUES (@dept,@course_code,@course_title,@date,@start_time,@end_time,@venue,@lecturer,@source_file,@semester)`);
    const insertSource = db.prepare(`INSERT INTO sources (source_file, type, semester) VALUES (?, ?, ?)`);

    db.transaction(() => {
        for (const row of CLASSES) insertClass.run({ ...row, source_file: CLASS_SOURCE, semester });
        insertSource.run(CLASS_SOURCE, 'timetable', semester);
        for (const row of EXAMS) insertExam.run({ ...row, source_file: EXAM_SOURCE, semester });
        insertSource.run(EXAM_SOURCE, 'exams', semester);
    })();

    return { classes: CLASSES.length, exams: EXAMS.length };
}
