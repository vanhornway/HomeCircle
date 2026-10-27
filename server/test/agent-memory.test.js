// The agent's memory: linked notes, encrypted on disk, found by words, links
// and dates; private notes stay private; every change can be undone.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Memory, cleanNote, linksIn, recipeIngredients } from '../src/agent/memory.js';

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

test('a recipe is kept whole; its ingredients follow its Ingredients list, edits too', () => {
  const body = '[[Nani]]’s recipe.\n\n## Ingredients\n\n**For the rice:**\n- 2 cups basmati rice\n- 1 tsp salt\n\n### For the chicken\n* 1 kg chicken\n- 1 cup yogurt\n\n## Steps\n\n1. Soak the rice for 30 minutes.\n2. Marinate the chicken.\n3. Layer and cook on low (dum) for 30 minutes.\n\nServe with raita.';
  const n = mem.add({ type: 'recipe', title: 'Biryani', body, people: ['Nani'], data: { serves: 6, time: '1 hour', ingredients: ['rice'] } }, { by: MOM });
  assert.equal(n.body, body);
  assert.deepEqual(n.data, { serves: '6', time: '1 hour', ingredients: ['2 cups basmati rice', '1 tsp salt', '1 kg chicken', '1 cup yogurt'] });
  // Found by its dish and by whose it is.
  assert.equal(mem.lookup({ text: 'biryani', by: DAD })[0].id, n.id);
  assert.ok(mem.lookup({ people: ['Nani'], by: DAD }).some((x) => x.id === n.id));
  // Edited in Memory: the ingredients change with the list.
  const edited = mem.update(n.id, { body: body.replace('- 1 tsp salt\n', '- 1 tsp salt\n- 4 green cardamom\n') }, { by: DAD });
  assert.deepEqual(edited.data.ingredients, ['2 cups basmati rice', '1 tsp salt', '4 green cardamom', '1 kg chicken', '1 cup yogurt']);
  // Written as plain text ("Ingredients:" and "Method:"), or with no list in the text at all.
  assert.deepEqual(recipeIngredients('Ingredients:\n- milk\n- tea\nMethod:\n1. Boil.'), ['milk', 'tea']);
  assert.deepEqual(cleanNote({ type: 'recipe', title: 'Chai', body: 'Boil it all.', data: { ingredients: ['milk', ' ', 'tea'] } }).data, { serves: null, time: null, ingredients: ['milk', 'tea'] });
  // Other notes keep their data as is.
  assert.deepEqual(cleanNote({ type: 'fact', title: 'X', data: { role: 'kid' } }).data, { role: 'kid' });
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
