// The agent's memory: linked notes, encrypted on disk, found by words, links
// and dates; private notes stay private; every change can be undone.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Memory, linksIn } from '../src/agent/memory.js';

const dir = mkdtempSync(join(tmpdir(), 'homecircle-memory-'));
const file = join(dir, 'memory.db');
const key = new Uint8Array(randomBytes(32));
let mem = new Memory(file, key);
after(() => {
  mem.close();
  rmSync(dir, { recursive: true, force: true });
});

const MOM = 'mom-member-id';
const DAD = 'dad-member-id';

test('notes link with [[names]]', () => {
  assert.deepEqual(linksIn('[[Kid]] goes to [[Lincoln Elementary]] and [[kid]]'), ['kid', 'lincoln elementary', 'kid']);
});

test('notes are found by words, by the people they link to, and by date', () => {
  mem.add({ type: 'person', title: 'Kid', body: '2nd grade at [[Lincoln Elementary]]. Soccer on Saturdays.' }, { by: MOM });
  mem.add({ type: 'place', title: 'Lincoln Elementary', body: 'Kid’s school.' }, { by: MOM });
  mem.add({ type: 'decision', title: 'Tahoe trip', body: 'We go to Tahoe Dec 20–24.', people: ['Mom', 'Dad'], start: '2026-12-20', end: '2026-12-24' }, { by: DAD });
  mem.add({ type: 'event', title: 'Dentist', body: 'Dentist for [[Kid]] at 3:30.', start: '2026-11-14' }, { by: MOM });
  mem.add({ type: 'fact', title: 'Shellfish', body: 'Dad is allergic to shellfish.', people: ['Dad'] }, { by: DAD });

  // Words (with stemming: "trips" finds "trip").
  assert.equal(mem.lookup({ text: 'what did we decide about trips to tahoe?', by: MOM })[0].title, 'Tahoe trip');
  // A person: their note, notes that link to them, and one hop further.
  const kid = mem.lookup({ people: ['Kid'], by: MOM }).map((n) => n.title);
  assert.ok(kid.includes('Kid') && kid.includes('Dentist') && kid.includes('Lincoln Elementary'), kid.join());
  // A date range.
  assert.deepEqual(
    mem.lookup({ from: '2026-12-01', to: '2026-12-31', by: MOM }).map((n) => n.title),
    ['Tahoe trip'],
  );
});

test('private notes are only found by the person they belong to', () => {
  mem.add({ type: 'fact', title: 'Gift idea', body: 'Surprise: a kayak for Dad’s birthday.' }, { scope: MOM, by: MOM });
  assert.equal(mem.lookup({ text: 'kayak', by: MOM }).length, 1);
  assert.equal(mem.lookup({ text: 'kayak', by: DAD }).length, 0);
  assert.equal(
    mem.list({ by: DAD }).some((n) => n.title === 'Gift idea'),
    false,
  );
});

test('edits and deletes are kept with who made them, and can be undone', () => {
  const note = mem.lookup({ text: 'dentist', by: MOM })[0];
  mem.update(note.id, { body: 'Dentist for [[Kid]] at 4:00.' }, { by: DAD });
  assert.equal(mem.get(note.id, { by: MOM }).body, 'Dentist for [[Kid]] at 4:00.');
  assert.deepEqual(
    mem.history(note.id, { by: MOM }).map((h) => [h.change, h.by]),
    [
      ['edited', DAD],
      ['added', MOM],
    ],
  );
  mem.undo(note.id, { by: MOM });
  assert.equal(mem.get(note.id, { by: MOM }).body, 'Dentist for [[Kid]] at 3:30.');

  mem.remove(note.id, { by: MOM });
  assert.ok(!mem.lookup({ text: 'dentist', by: MOM }).some((n) => n.id === note.id));
  mem.undo(note.id, { by: MOM });
  assert.equal(mem.lookup({ text: 'dentist', by: MOM })[0].id, note.id);

  // Undoing a note that was just added removes it ("📌 Remembered · Undo").
  const oops = mem.add({ title: 'Oops', body: 'Remembered by mistake' }, { by: DAD });
  assert.equal(mem.undo(oops.id, { by: DAD }), null);
  assert.equal(mem.get(oops.id, { by: DAD }), null);
});

test('on disk, notes are encrypted; they come back after a restart', () => {
  mem.close();
  const raw = readFileSync(file).toString('latin1');
  assert.ok(!raw.includes('Tahoe') && !raw.includes('shellfish'));
  mem = new Memory(file, key);
  assert.equal(mem.lookup({ text: 'shellfish', by: MOM })[0].title, 'Shellfish');
  // The wrong key opens nothing.
  assert.throws(() => new Memory(file, new Uint8Array(32)), /could not be decrypted/);
});

test('past events are archived: out of everyday answers, there when asked', () => {
  mem.add({ type: 'event', title: 'Spring trip to Yosemite', body: 'Camping in Yosemite.', start: '2025-04-10', end: '2025-04-13' }, { by: MOM });
  assert.equal(mem.lookup({ text: 'yosemite', by: MOM }).length, 0);
  assert.equal(mem.lookup({ text: 'yosemite', by: MOM, archived: true }).length, 1);
});

test('spending is counted per person per month', () => {
  mem.spend(MOM, 0.012);
  mem.spend(MOM, 0.008);
  mem.spend(DAD, 0.005);
  const s = mem.spent();
  assert.equal(Math.round(s.total * 1000), 25);
  assert.equal(Math.round(s.byMember[MOM] * 1000), 20);
});

test('lookups are fast', () => {
  for (let i = 0; i < 2000; i++) mem.add({ type: 'fact', title: `Note ${i}`, body: `Filler note number ${i} about [[Kid]] and groceries ${i % 37}.` }, { by: MOM });
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) mem.lookup({ text: `tahoe groceries ${i}`, people: ['Kid'], by: MOM });
  const ms = (performance.now() - t0) / 50;
  assert.ok(ms < 50, `${ms.toFixed(1)} ms per lookup`);
});
