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

test('recipes go under Recipes, whole, with how many it serves and how long it takes', () => {
  const body = '[[Nani]]’s recipe.\n## Ingredients\n- 2 cups basmati rice\n## Steps\n1. Soak the rice.\n2. Cook it.';
  const { text } = exportVault({
    notes: [
      note({ id: 'r1', type: 'recipe', title: 'Biryani', body, people: ['Nani'], data: { serves: '6', time: '1 hour', ingredients: ['2 cups basmati rice'] } }),
      // Written without an Ingredients list: it gets one from what was kept.
      note({ id: 'r2', type: 'recipe', title: 'Chai', body: 'Boil everything for 2 minutes.', data: { serves: null, time: null, ingredients: ['milk', 'tea'] } }),
    ],
    who: 'Maya',
    helper: 'Chirya',
    now: 0,
  });
  assert.equal(text['Recipes/Biryani.md'], `---\ntype: "recipe"\nscope: "circle"\nserves: "6"\ntime: "1 hour"\npeople: ["[[Nani]]"]\ncreated: "1970-01-01"\nupdated: "1970-01-01"\nhomecircle-id: "r1"\n---\n\n# Biryani\n\n${body}\n`);
  assert.match(text['Recipes/Chai.md'], /\nBoil everything for 2 minutes\.\n\n## Ingredients\n\n- milk\n- tea\n$/);
  assert.doesNotMatch(text['Recipes/Chai.md'], /serves:/);
  assert.match(text['Home.md'], /## Recipes\n\n- \[\[Recipes\/Biryani\|Biryani\]\]\n- \[\[Recipes\/Chai\|Chai\]\]/);
});

test('contacts, health, documents, trips and the home manual each have a folder; trips and documents have calendar files', () => {
  const { text } = exportVault({
    notes: [
      note({ id: 'c1', type: 'contact', title: 'Dr. Lee', body: 'Our dentist.', data: { role: 'dentist', phone: '555-0100' } }),
      note({ id: 'h1', type: 'health', title: 'Inhaler', data: { kind: 'medicine', dose: '2 puffs', refillBy: '2026-11-20' } }),
      note({ id: 'd1', type: 'document', title: 'Car registration', data: { kind: 'registration', expires: '2027-01-31', number_last4: '4821' } }),
      note({
        id: 't1',
        type: 'trip',
        title: 'Tahoe',
        start: '2026-12-20',
        end: '2026-12-24',
        data: { legs: [{ kind: 'car', from: 'Home', to: 'Tahoe', at: '2026-12-20', arrives: '', confirmation: '' }, { kind: 'hotel', from: 'Lakeside Inn', to: '', at: '2026-12-20 15:00', arrives: '2026-12-24 11:00', confirmation: 'H77' }] },
      }),
      note({ id: 'w1', type: 'howto', title: 'Reset the router', body: '1. Unplug it.\n2. Wait 30 seconds.', data: { every: null } }),
    ],
    who: 'Maya',
    helper: 'Chirya',
    now: 0,
  });
  assert.match(text['Contacts/Dr. Lee.md'], /^role: "dentist"\nphone: "555-0100"\n/m);
  assert.match(text['Health/Inhaler.md'], /^kind: "medicine"\ndose: "2 puffs"\nrefill-by: "2026-11-20"\n/m);
  assert.match(text['Health/Inhaler.ics'], /SUMMARY:Inhaler: refill by/);
  assert.match(text['Documents/Car registration.md'], /^expires: "2027-01-31"\nnumber-last4: "4821"\n/m);
  assert.match(text['Documents/Car registration.ics'], /DTSTART;VALUE=DATE:20270131\r\n/);
  assert.match(text['Trips/Tahoe.md'], /## Legs\n\n- car, Home → Tahoe, leaves 2026-12-20\n- hotel, Lakeside Inn, leaves 2026-12-20 15:00, arrives 2026-12-24 11:00, confirmation H77\n/);
  const ics = text['Trips/Tahoe.ics'];
  assert.match(ics, /DTSTART;VALUE=DATE:20261220\r\nDTEND;VALUE=DATE:20261225\r\nSUMMARY:Tahoe\r\n/);
  // A leg with only a day is all day; one with a time keeps it.
  assert.match(ics, /DTSTART;VALUE=DATE:20261220\r\nDTEND;VALUE=DATE:20261221\r\nSUMMARY:car Home to Tahoe\r\n/);
  assert.match(ics, /DTSTART:20261220T150000\r\nSUMMARY:hotel Lakeside Inn \(H77\)\r\n/);
  assert.equal(text['Home manual/Reset the router.md'].includes('2. Wait 30 seconds.'), true);
  assert.equal(text['Home manual/Reset the router.ics'], undefined);
  assert.match(text['Home.md'], /## Contacts[\s\S]*## Health[\s\S]*## Documents[\s\S]*## Trips[\s\S]*## Home manual\n\n- \[\[Home manual\/Reset the router\|Reset the router\]\]/);
});
