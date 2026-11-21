import { describe, expect, it } from 'vitest'
import { answerToText, CLASS_WEEKS, conversationToText, fileNameFrom, rowsToCsv, rowsToIcs } from '../export.js'

const CLASS = { id: 1, course_code: 'CPS 416', course_title: 'Artificial Intelligence', day: 'Mon', start_time: '08:30', end_time: '11:00', venue: 'Lab 2', lecturer: 'Dr. Awa Ceesay' }
const EXAM = { id: 2, kind: 'exam', course_code: 'CPS 313', course_title: 'Operating Systems', date: '2026-12-08', day: 'Tue', start_time: '09:00', end_time: '12:00', venue: 'Exam Hall 2' }

// Saturday 21 November 2026, 20:00 local time
const NOW = new Date(2026, 10, 21, 20, 0, 0)

describe('rowsToIcs', () => {
  it('makes an exam a single event on its date', () => {
    const { ics, count } = rowsToIcs([EXAM], { now: NOW })
    expect(count).toBe(1)
    expect(ics).toContain('BEGIN:VCALENDAR\r\nVERSION:2.0')
    expect(ics).toContain('DTSTART:20261208T090000\r\nDTEND:20261208T120000')
    expect(ics).toContain('SUMMARY:Exam: CPS 313 Operating Systems')
    expect(ics).toContain('LOCATION:Exam Hall 2')
    expect(ics).not.toContain('RRULE')
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true)
  })

  it('repeats a class weekly from its next sitting', () => {
    const { ics } = rowsToIcs([CLASS], { now: NOW })
    // the Monday after Saturday 21 November
    expect(ics).toContain('DTSTART:20261123T083000\r\nDTEND:20261123T110000')
    expect(ics).toContain(`RRULE:FREQ=WEEKLY;COUNT=${CLASS_WEEKS}`)
    expect(ics).toContain('DESCRIPTION:Lecturer: Dr. Awa Ceesay')
  })

  it('starts today when the class is on today\'s weekday', () => {
    const { ics } = rowsToIcs([{ ...CLASS, day: 'Saturday' }], { now: NOW })
    expect(ics).toContain('DTSTART:20261121T083000')
  })

  it('escapes text, folds long lines and skips rows it cannot place', () => {
    const long = { ...EXAM, course_title: 'Systems; Signals, and a very long course title that goes on and on past the line limit', venue: 'Hall\nB' }
    const { ics, count } = rowsToIcs([long, { ...CLASS, day: 'someday' }, { ...EXAM, date: 'soon' }], { now: NOW })
    expect(count).toBe(1)
    expect(ics).toContain(String.raw`Systems\; Signals\, and`)
    expect(ics).toContain('LOCATION:Hall\\nB')
    for (const line of ics.split('\r\n')) expect(line.length).toBeLessThanOrEqual(75)
  })

  it('makes an exam with no time an all-day event', () => {
    const { ics } = rowsToIcs([{ ...EXAM, start_time: '', end_time: '' }], { now: NOW })
    expect(ics).toContain('DTSTART;VALUE=DATE:20261208')
    expect(ics).not.toContain('DTEND')
  })
})

describe('rowsToCsv', () => {
  it('writes one line per row under a header', () => {
    expect(rowsToCsv([CLASS, EXAM]).split('\r\n')).toEqual([
      'Type,Course code,Course title,Day,Date,Start,End,Venue,Lecturer',
      'Class,CPS 416,Artificial Intelligence,Monday,,08:30,11:00,Lab 2,Dr. Awa Ceesay',
      'Exam,CPS 313,Operating Systems,Tuesday,2026-12-08,09:00,12:00,Exam Hall 2,',
      '',
    ])
  })

  it('quotes awkward cells and defuses spreadsheet formulas', () => {
    const csv = rowsToCsv([{ ...CLASS, course_title: 'Signals, "Systems"', venue: '=HYPERLINK("http://evil")', lecturer: '+44 123' }])
    expect(csv).toContain('"Signals, ""Systems"""')
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`)
    expect(csv).toContain(",'+44 123")
  })
})

describe('conversationToText', () => {
  it('writes the questions, answers and the rows they came from', () => {
    const text = conversationToText({
      title: 'When is AI?',
      messages: [
        { role: 'user', text: 'When is AI?' },
        { role: 'assistant', text: '**Artificial Intelligence** is on Monday.', status: 'done', sources: [CLASS] },
        { role: 'user', text: 'And the OS exam?' },
        { role: 'assistant', text: 'On 8 December.', status: 'done', sources: [EXAM] },
        { role: 'user', text: 'broken' },
        { role: 'assistant', text: '', status: 'error', error: 'The AI model is busy right now.' },
      ],
    }, { student: '22216000', now: NOW })

    expect(text).toContain('Chat: When is AI?')
    expect(text).toContain('Student: 22216000')
    expect(text).toContain('You: When is AI?')
    expect(text).toContain('Assistant: Artificial Intelligence is on Monday.') // Markdown removed
    expect(text).toContain('  - CPS 416 Artificial Intelligence | Monday | 08:30–11:00 | Lab 2 | Dr. Awa Ceesay')
    expect(text).toContain('  - CPS 313 Operating Systems | Tuesday 8 December 2026 | 09:00–12:00 | Exam Hall 2')
    expect(text).toContain('Assistant: (No answer: The AI model is busy right now.)')
  })
})

describe('answerToText', () => {
  it('is just the text when the rows are not shown as a schedule', () => {
    expect(answerToText({ text: '**Monday** at 08:30.', sources: [CLASS], schedule: false })).toBe('Monday at 08:30.')
  })

  it('adds the schedule when the text only summarises it', () => {
    const text = answerToText({ text: 'Two things.', sources: [CLASS, EXAM], schedule: true })
    expect(text).toBe([
      'Two things.',
      '',
      'Monday:',
      'CPS 416 Artificial Intelligence, 08:30 to 11:00, Lab 2, Dr. Awa Ceesay.',
      '',
      'Tuesday 8 December 2026:',
      'CPS 313 Operating Systems, 09:00 to 12:00, Exam Hall 2.',
    ].join('\n'))
  })
})

describe('fileNameFrom', () => {
  it('makes a safe short name, with a fallback', () => {
    expect(fileNameFrom('Exams · CPS 416 / "AI"')).toBe('exams-cps-416-ai')
    expect(fileNameFrom('???', 'utg-chat')).toBe('utg-chat')
    expect(fileNameFrom('a'.repeat(100)).length).toBe(40)
  })
})
