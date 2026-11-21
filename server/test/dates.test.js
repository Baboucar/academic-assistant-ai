import test from 'node:test';
import assert from 'node:assert/strict';
import { dayFromISO, dayFromText, nowIn, shiftDay, sortUpcoming, toDay3 } from '../src/utils/dates.js';

test('toDay3 normalises weekday spellings', () => {
    assert.equal(toDay3('monday'), 'Mon');
    assert.equal(toDay3('Thurs'), 'Thu');
    assert.equal(toDay3('TUE'), 'Tue');
    assert.equal(toDay3('someday'), null);
    assert.equal(toDay3(''), null);
});

test('nowIn reports the date in the requested timezone', () => {
    // 23:30 UTC on a Sunday is already Monday in Tokyo
    const date = new Date('2026-11-22T23:30:00Z');
    assert.deepEqual(nowIn('Africa/Banjul', date), { iso: '2026-11-22', weekday: 'Sunday', day3: 'Sun', time: '23:30' });
    assert.equal(nowIn('Asia/Tokyo', date).day3, 'Mon');
    assert.equal(nowIn('Asia/Tokyo', date).iso, '2026-11-23');
});

test('shiftDay wraps around the week', () => {
    assert.equal(shiftDay('Sun', 1), 'Mon');
    assert.equal(shiftDay('Mon', -1), 'Sun');
    assert.equal(shiftDay('Fri', 2), 'Sun');
});

test('dayFromISO returns the weekday or null', () => {
    assert.equal(dayFromISO('2026-11-23'), 'Mon');
    assert.equal(dayFromISO('2026-11-29'), 'Sun');
    assert.equal(dayFromISO('next week'), null);
    assert.equal(dayFromISO(null), null);
});

test('dayFromText finds explicit and relative days', () => {
    assert.equal(dayFromText('Show Monday schedule', 'Wed'), 'Mon');
    assert.equal(dayFromText('what about thurs?', 'Wed'), 'Thu');
    assert.equal(dayFromText('What classes do I have today?', 'Wed'), 'Wed');
    assert.equal(dayFromText('any lectures tomorrow', 'Sun'), 'Mon');
    assert.equal(dayFromText('the day after tomorrow', 'Sat'), 'Mon');
    assert.equal(dayFromText('what was on yesterday', 'Mon'), 'Sun');
    assert.equal(dayFromText('who teaches AI', 'Wed'), null);
});

test('dayFromText does not read ordinary words as days', () => {
    assert.equal(dayFromText('where is the sun lab', 'Wed'), null);
    assert.equal(dayFromText('the class that sat in hall A', 'Wed'), null);
    assert.equal(dayFromText('who wed the monitor to the projector', 'Wed'), null);
});

test('sortUpcoming puts the soonest class first and skips ones already started today', () => {
    const rows = [
        { course_code: 'A', day: 'Mon', start_time: '08:30' },
        { course_code: 'B', day: 'Mon', start_time: '14:30' },
        { course_code: 'C', day: 'Tue', start_time: '08:30' },
        { course_code: 'D', day: 'Sun', start_time: '09:00' },
    ];
    const order = (now) => sortUpcoming(rows, now).map((r) => r.course_code).join('');
    assert.equal(order({ day3: 'Mon', time: '07:00' }), 'ABCD');
    assert.equal(order({ day3: 'Mon', time: '10:00' }), 'BCDA');
    assert.equal(order({ day3: 'Sat', time: '10:00' }), 'DABC');
});
