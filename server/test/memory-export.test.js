// "Download memory" as a vault: file names Obsidian accepts, calendars as
// .ics, and parts that each stay under the server's file limit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, unzipSync } from 'fflate';
import { calendarIcs, exportVault, safeName, zipVault } from '../src/agent/export.js';

const note = (o) => ({ id: 'n1', type: 'fact', title: 'Note', body: '', people: [], tags: [], start: null, end: null, data: null, source: null, scope: 'circle', createdAt: 0, updatedAt: 0, ...o });

test('a title that can’t be a file name keeps its links through an alias', () => {
  assert.equal(safeName('Leo/Zara: soccer #1 [fall]'), 'Leo-Zara- soccer -1 -fall-');
  const { text } = exportVault({ notes: [note({ title: 'Leo/Zara: soccer', tags: ['soccer practice'], people: ['Leo', 'Zara'] })], who: 'Maya', helper: 'Chirya', now: Date.UTC(2026, 9, 26) });
  const md = text['Facts/Leo-Zara- soccer.md'];
  assert.match(md, /^aliases: \["Leo\/Zara: soccer"\]$/m);
  // People as links, so the graph connects the note to them.
  assert.match(md, /^people: \["\[\[Leo\]\]","\[\[Zara\]\]"\]$/m);
  // Obsidian tags can't have spaces.
  assert.match(md, /^tags: \["soccer-practice"\]$/m);
});

test('calendars: all-day dates end the day after; timed ones keep their clock time', () => {
  const ics = calendarIcs(
    note({
      title: 'School',
      data: {
        events: [
          { summary: 'Thanksgiving break', start: '2026-11-25', end: '2026-11-27', allDay: true },
          { summary: 'Recital, room 4; bring snacks', start: '2026-12-03', end: '2026-12-03', time: '18:30', allDay: false },
        ],
      },
    }),
    Date.UTC(2026, 9, 26),
  );
  assert.match(ics, /DTSTART;VALUE=DATE:20261125\r\nDTEND;VALUE=DATE:20261128\r\n/);
  assert.match(ics, /DTSTART:20261203T183000\r\nSUMMARY:Recital\\, room 4\\; bring snacks\r\n/);
});

test('parts: notes in the first, files filling it and the next; one too big for any part is left out', () => {
  const big = (n) => new Uint8Array(n).fill(7);
  const vault = exportVault({
    notes: [note({ title: 'Receipt', data: { file: { id: 'f1', name: 'a.jpg' } } })],
    files: [
      { id: 'f1', name: 'a.jpg', bytes: big(6000) },
      { id: 'f2', name: 'b.pdf', bytes: big(6000) },
      { id: 'f3', name: 'c.jpg', bytes: big(30_000) },
    ],
    who: 'Maya',
    helper: 'Chirya',
    now: 0,
  });
  const { parts, tooBig } = zipVault(vault, { partBytes: 10_000, name: 'Chirya memory' });
  assert.deepEqual(tooBig, ['Files/c.jpg']);
  assert.deepEqual(parts.map((p) => p.name), ['Chirya memory (part 1 of 2).zip', 'Chirya memory (part 2 of 2).zip']);
  const [one, two] = parts.map((p) => unzipSync(p.bytes));
  assert.ok(one['Home.md'] && one['README.md'] && one['Facts/Receipt.md']);
  assert.match(strFromU8(one['Facts/Receipt.md']), /!\[\[Files\/a\.jpg\]\]/);
  assert.equal(Object.keys(one).filter((p) => p.startsWith('Files/')).length + Object.keys(two).length, 2);
  for (const p of parts) assert.ok(p.bytes.length <= 10_000);
});
