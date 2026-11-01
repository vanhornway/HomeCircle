// Dates for reminders: parsing what's typed, and the calendar the picker shows.
//   node --experimental-strip-types --test src/lib/dueDate.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isoDate, monthWeeks, parseDueDate } from './dueDate.ts';

test('November 2026 starts on a Sunday and has five weeks', () => {
  const weeks = monthWeeks(2026, 11);
  assert.equal(weeks.length, 5);
  assert.equal(weeks[0][0], '2026-11-01');
  assert.equal(weeks[4][1], '2026-11-30');
  assert.equal(weeks[4][2], null);
});

test('a month that starts mid-week is padded at the front', () => {
  const weeks = monthWeeks(2027, 2); // Feb 1, 2027 is a Monday
  assert.deepEqual(weeks[0].slice(0, 2), [null, '2027-02-01']);
  assert.equal(weeks.flat().filter(Boolean).length, 28);
  assert.ok(weeks.every((w) => w.length === 7));
});

test('leap February has 29 days', () => {
  assert.equal(monthWeeks(2028, 2).flat().filter(Boolean).length, 29);
});

test('isoDate is the local date', () => {
  assert.equal(isoDate(new Date(2026, 10, 20, 23, 30)), '2026-11-20');
});

test('typed dates still parse', () => {
  assert.equal(parseDueDate('2026-11-20'), '2026-11-20');
  assert.equal(parseDueDate('11/30/2027'), '2027-11-30');
});
