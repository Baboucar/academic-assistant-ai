import { describe, expect, it } from 'vitest'
import { dayName, fileSize, filterLabels, parseDbDate, plural, timeAgo, timeRange } from '../format.js'

describe('format helpers', () => {
  it('expands day abbreviations', () => {
    expect(dayName('Mon')).toBe('Monday')
    expect(dayName('THURSDAY')).toBe('Thursday')
    expect(dayName('Daily')).toBe('Daily')
  })

  it('formats time ranges', () => {
    expect(timeRange('08:30', '11:00')).toBe('08:30–11:00')
    expect(timeRange('08:30', '')).toBe('08:30')
  })

  it('reads SQLite timestamps as UTC', () => {
    expect(parseDbDate('2026-11-19 10:02:11').toISOString()).toBe('2026-11-19T10:02:11.000Z')
    expect(parseDbDate('nonsense')).toBeNull()
  })

  it('describes how long ago something happened', () => {
    const now = new Date('2026-11-21T12:00:00Z')
    expect(timeAgo('2026-11-21 11:59:40', now)).toBe('just now')
    expect(timeAgo('2026-11-21 11:57:00', now)).toBe('3 minutes ago')
    expect(timeAgo('2026-11-21 09:00:00', now)).toBe('3 hours ago')
    expect(timeAgo('2026-11-20 12:00:00', now)).toBe('yesterday')
    expect(timeAgo('2026-10-01 12:00:00', now)).toBe('1 Oct 2026')
    expect(timeAgo('')).toBe('—')
  })

  it('pluralises counts', () => {
    expect(plural(1, 'row')).toBe('1 row')
    expect(plural(0, 'row')).toBe('0 rows')
    expect(plural(2, 'matching class', 'matching classes')).toBe('2 matching classes')
  })

  it('formats file sizes', () => {
    expect(fileSize(512)).toBe('512 B')
    expect(fileSize(20480)).toBe('20 KB')
    expect(fileSize(5 * 1024 * 1024)).toBe('5.0 MB')
  })

  it('labels the filters a search used', () => {
    expect(filterLabels({ course: null, title: 'Artificial Intelligence', dept: 'CS', day: 'Mon' }))
      .toEqual(['Artificial Intelligence', 'CS', 'Monday'])
    expect(filterLabels({ course: 'CPS416', title: 'Artificial Intelligence' })).toEqual(['CPS416'])
    expect(filterLabels(null)).toEqual([])
  })
})
