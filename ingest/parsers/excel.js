import xlsx from 'xlsx';
export function parseExcelTimetable(path, deptGuess='UNKNOWN'){
  const wb=xlsx.readFile(path); const sheet=wb.Sheets[wb.SheetNames[0]];
  const rows=xlsx.utils.sheet_to_json(sheet,{defval:''}); const out=[];
  for(const r of rows){
    const cc=r.course_code||r.Course||r['Course Code']||r['course']||'';
    const title=r.course_title||r.Title||r['Course Title']||'';
    const day=r.day||r.Day||''; const s=r.start_time||r.Start||r['Start']||'';
    const e=r.end_time||r.End||r['End']||''; const venue=r.venue||r.Room||r.Hall||'';
    const lec=r.lecturer||r.Instructor||r.Teacher||'';
    if(cc && day && s && e){
      out.push([deptGuess,String(cc).trim(),String(title).trim(),String(day).trim(),
                String(s).trim(),String(e).trim(),String(venue).trim(),String(lec).trim()]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Exam timetables
// ---------------------------------------------------------------------------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n) => String(n).padStart(2, '0');

function iso(y, m, d) {
  y = Number(y); m = Number(m); d = Number(d);
  if (y < 100) y += 2000;
  const date = new Date(Date.UTC(y, m - 1, d));
  // rejects things like 31/02
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Any common way of writing a date -> "YYYY-MM-DD", or null. Day comes before month in 12/01/2026. */
export function toIsoDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return iso(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }
  if (typeof value === 'number' && value > 1) {
    const p = xlsx.SSF.parse_date_code(value); // Excel stores dates as day counts
    return p ? iso(p.y, p.m, p.d) : null;
  }
  const s = String(value || '').trim();
  if (!s) return null;

  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(m[1], m[2], m[3]);

  m = s.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) return iso(m[3], m[2], m[1]);

  const month = (name) => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
  m = s.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,})\.?,?\s+(\d{4})/); // 12th January 2026
  if (m && month(m[2])) return iso(m[3], month(m[2]), m[1]);
  m = s.match(/([A-Za-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/); // January 12, 2026
  if (m && month(m[1])) return iso(m[3], month(m[1]), m[2]);
  return null;
}

/** "9:00", "9.30am", "2 PM", "1430" or an Excel time cell -> "HH:MM", or null. */
export function toTime(value) {
  if (typeof value === 'number' && value >= 0 && value < 1) {
    const minutes = Math.round(value * 24 * 60);
    return `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;
  }
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return null;

  let h; let min; let half;
  let m = s.match(/^(\d{1,2})[:.](\d{2})(?::\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?$/);
  if (m) [, h, min, half] = m;
  else if ((m = s.match(/^(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.)$/))) { [, h, half] = m; min = 0; }
  else if ((m = s.match(/^(\d{2})(\d{2})(?:\s*h(?:rs?)?)?$/))) [, h, min] = m;
  else return null;

  h = Number(h); min = Number(min);
  if (half) {
    const pm = half.startsWith('p');
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
  }
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
}

/** "9:00 - 12:00", "9am to 12pm" -> ["09:00", "12:00"]; a single time -> [time, null]. */
export function toTimeRange(value) {
  if (typeof value === 'number') return [toTime(value), null];
  const parts = String(value ?? '').split(/\s*(?:–|—|-|\bto\b)\s*/i).filter(Boolean);
  return [toTime(parts[0]), parts.length > 1 ? toTime(parts[1]) : null];
}

// Column names seen on exam timetables, compared with spaces and punctuation removed
const EXAM_COLUMNS = {
  code: ['coursecode', 'code', 'course', 'coursecodes', 'courseno'],
  title: ['coursetitle', 'title', 'coursename', 'name', 'subject', 'paper'],
  date: ['date', 'examdate', 'dateofexam', 'day'],
  start: ['starttime', 'start', 'from', 'begins', 'timestart'],
  end: ['endtime', 'end', 'to', 'finish', 'ends', 'timeend'],
  time: ['time', 'examtime', 'period', 'session'],
  venue: ['venue', 'room', 'hall', 'location', 'place', 'examvenue'],
  lecturer: ['lecturer', 'instructor', 'examiner', 'teacher', 'courselecturer'],
  dept: ['dept', 'department', 'programme', 'program', 'school'],
};

const cell = (v) => String(v ?? '').trim();

/**
 * Read an exam timetable spreadsheet (every sheet).
 * Returns rows of [dept, course_code, course_title, date, start_time, end_time, venue, lecturer].
 * A row needs a date and a course code or title; rows without them are skipped.
 */
export function parseExcelExams(path, deptGuess = 'UNKNOWN') {
  const wb = xlsx.readFile(path);
  const out = [];

  for (const sheetName of wb.SheetNames) {
    const rows = xlsx.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
    for (const raw of rows) {
      const byKey = {};
      for (const [k, v] of Object.entries(raw)) byKey[k.toLowerCase().replace(/[^a-z0-9]/g, '')] = v;
      const pick = (field) => {
        for (const name of EXAM_COLUMNS[field]) {
          if (byKey[name] !== undefined && cell(byKey[name]) !== '') return byKey[name];
        }
        return '';
      };

      const date = toIsoDate(pick('date'));
      const code = cell(pick('code'));
      const title = cell(pick('title'));
      if (!date || (!code && !title)) continue;

      let start = toTime(pick('start'));
      let end = toTime(pick('end'));
      if (!start) {
        const [a, b] = toTimeRange(pick('time'));
        start = a;
        end = end || b;
      }

      out.push([cell(pick('dept')).toUpperCase() || deptGuess, code, title, date, start || '', end || '', cell(pick('venue')), cell(pick('lecturer'))]);
    }
  }
  return out;
}
