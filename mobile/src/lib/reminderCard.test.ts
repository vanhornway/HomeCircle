// The helper's reminder text, split into a title, a "when" line and a note.
//   node --experimental-strip-types --test src/lib/reminderCard.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReminder } from './reminderCard.ts';

test('an upcoming reminder', () => {
  assert.deepEqual(parseReminder('⏰ Car registration is due in 5 days (Nov 5).'), { title: 'Car registration', when: 'Due in 5 days (Nov 5)', note: '', late: false });
  assert.equal(parseReminder('⏰ Passport is due today (Nov 5).').when, 'Due today (Nov 5)');
});

test('the note on a reminder stays', () => {
  const r = parseReminder('⏰ Insurance is due tomorrow (Nov 6). Call Allstate first.');
  assert.equal(r.title, 'Insurance');
  assert.equal(r.note, 'Call Allstate first.');
});

test('a late one is marked, and the Tap Done nudge is dropped (the card has a button)', () => {
  const r = parseReminder('⏰ Car registration was due 3 days ago (Oct 3). Late fees may apply. Tap Done once it’s taken care of.');
  assert.equal(r.late, true);
  assert.equal(r.when, 'Was due 3 days ago (Oct 3)');
  assert.equal(r.note, '');
});

test('text it cannot read is shown whole', () => {
  assert.deepEqual(parseReminder('⏰ Take the bins out'), { title: 'Take the bins out', when: '', note: '', late: false });
  assert.equal(parseReminder('').title, 'Reminder');
});
