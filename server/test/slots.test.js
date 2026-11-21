import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSlots, parseSlotJson } from '../src/ai/slotExtractor.js';

test('parseSlotJson accepts plain, fenced and wrapped JSON', () => {
    assert.deepEqual(parseSlotJson('{"day":"Mon"}'), { day: 'Mon' });
    assert.deepEqual(parseSlotJson('```json\n{"day":"Mon"}\n```'), { day: 'Mon' });
    assert.deepEqual(parseSlotJson('Here you go: {"day":"Mon"} hope it helps'), { day: 'Mon' });
    assert.equal(parseSlotJson('not json at all'), null);
    assert.equal(parseSlotJson('[1,2]'), null);
});

test('normalizeSlots cleans every field', () => {
    const slots = normalizeSlots({
        intent: 'who_teaches',
        course_code: 'ict 202',
        title_kw: '  Web Programming II ',
        dept: 'cs',
        day: 'Tuesday',
        date_iso: '2026-11-24',
        time: '8:30',
        lecturer_name: 'Dr. Awa Ceesay',
        venue: ' Lab 2 ',
        exam: true,
    });
    assert.deepEqual(slots, {
        intent: 'who_teaches',
        course_code: 'ICT202',
        title_kw: 'Web Programming II',
        dept: 'CS',
        day: 'Tue',
        date_iso: '2026-11-24',
        time: '08:30',
        lecturer_name: 'Awa Ceesay',
        venue: 'Lab 2',
        exam: true,
    });
});

test('normalizeSlots drops junk instead of passing it to SQL', () => {
    const slots = normalizeSlots({
        intent: 'drop_tables',
        day: 'someday',
        date_iso: 'tomorrow',
        time: 'noon',
        course_code: { nested: true },
        lecturer_name: ['a'],
    });
    assert.equal(slots.intent, 'generic');
    assert.equal(slots.day, null);
    assert.equal(slots.date_iso, null);
    assert.equal(slots.time, null);
    assert.equal(slots.course_code, null);
    assert.equal(slots.lecturer_name, null);
});

test('normalizeSlots survives a missing or non-object reply', () => {
    assert.equal(normalizeSlots(null).intent, 'generic');
    assert.equal(normalizeSlots('nope').day, null);
});

test('AI maps to the UTG course code', () => {
    const slots = normalizeSlots({ title_kw: 'AI' });
    assert.equal(slots.course_code, 'CPS416');
    assert.equal(slots.dept, 'CPS');
});
