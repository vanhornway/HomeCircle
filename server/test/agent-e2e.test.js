// The agent end to end: a server running it (AGENT), phones setting it up and
// talking to it, a fake AI provider (no real calls), and a calendar feed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { strFromU8, unzipSync } from 'fflate';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { LlmError } from '../src/agent/llm.js';
import { makePdf } from '../src/agent/pdf.js';
import { CircleClient, allFeatures } from '../../packages/core/src/index.js';

const SETUP = 'test-setup-token-agent-e2e';
let app;
let url;
let dir;
let calendar;
let calUrl;

// Everything the fake AI was sent, to check no real names went out.
const sentToAi = [];
let now = new Date('2026-11-02T17:00:00Z');

/** A fake provider: reads the (masked) request and answers like a model would. */
async function fakeLlm(cfg, { system, messages, schema }) {
  // A photo or scan arrives as a part; the fake "sees" it as [image] or [pdf].
  const text = messages.map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : `[${p.type}]`)).join('\n'))).join('\n');
  sentToAi.push(`${system}\n${text}`);
  if (schema?.properties?.calendar) {
    const sent = text.match(/now sent (.*)$/s)?.[1] ?? text;
    if (/date,what/.test(text)) {
      const events = [...text.matchAll(/^(\d{4}-\d{2}-\d{2}),(.+)$/gm)].map(([, start, summary]) => ({ summary, start, end: null, off: false }));
      return json({ title: 'Swim meets', summary: 'The season’s meets.', calendar: true, school: false, events, notes: [] });
    }
    if (/\[image\]/.test(text) && /blank/.test(sent)) return json({ title: 'A blank page', summary: 'Nothing on it.', calendar: false, school: false, events: [], notes: [] });
    if (/\[image\]/.test(text) && /receipt/.test(sent)) {
      return json({ title: 'Costco receipt', summary: 'A Costco trip.', receipt: { store: 'Costco', items: ['Milk', 'Paper towels', 'Eggs'] }, calendar: false, school: false, events: [], notes: [] });
    }
    if (/\[image\]/.test(text)) {
      return json({
        title: 'Soccer team sheet',
        summary: 'The coach’s phone number.',
        calendar: false,
        school: false,
        events: [],
        notes: [{ type: 'fact', title: 'Soccer contacts', body: 'Coach Dana: 555-0100.', people: [], tags: ['soccer', 'contacts', 'coach'], start: null, end: null, role: null }],
      });
    }
  }
  if (/Reply with the word OK/.test(system)) {
    if (cfg.apiKey === 'sk-wrong') throw new LlmError('The AI provider didn’t accept the API key', { status: 401, auth: true });
    return { text: 'OK', json: null, usd: 0.0001, refused: false };
  }
  if (schema?.properties?.intent) {
    // Only the new message decides what it is; the conversation before it is context.
    const said = text.match(/now says: (.*)$/s)?.[1] ?? text;
    if (/are our kids/.test(said)) {
      // New names can't be swapped yet (nobody's told the agent about them).
      const [a, b] = said.match(/(.+) are our kids/)[1].split(' and ');
      return json({
        intent: 'remember',
        people: [a, b],
        days: null,
        from: null,
        to: null,
        keywords: [],
        remember: [a, b].map((p) => ({ type: 'person', title: p, body: `${p} is one of the kids.`, people: [], start: null, end: null, role: 'kid' })),
      });
    }
    if (/^this is .*calendar/.test(said)) {
      const whose = said.match(/^this is (Person [A-Z]|my son)/)[1];
      return json({ intent: 'about_file', people: [whose === 'my son' ? 'son' : whose], days: null, from: null, to: null, keywords: [], remember: [] });
    }
    if (/free/.test(said)) return json({ intent: 'free_time', people: ['kids'], days: 5, from: null, to: null, keywords: ['vacation'], remember: [] });
    if (/remind/.test(said)) {
      return json({ intent: 'reminder', people: [], days: null, from: null, to: null, keywords: [], remember: [], list: null, listAction: null, items: [], reminder: { title: 'Car registration', due: '2026-11-30', repeat: 'yearly' } });
    }
    if (/need .* from the desi/.test(said)) {
      return json({ intent: 'list', people: [], days: null, from: null, to: null, keywords: [], remember: [], list: 'desi store', listAction: 'add', items: ['paneer', 'chai'], reminder: null });
    }
    if (/decided|Tahoe/.test(said)) return json({ intent: 'recall', people: [], days: null, from: null, to: null, keywords: ['tahoe'], remember: [] });
    return json({ intent: 'other', people: [], days: null, from: null, to: null, keywords: [], remember: [] });
  }
  if (schema?.properties?.merges) {
    // A dream: the school is a place, the two Tahoe notes are one, and Elm St gets a note.
    const ref = (title) => text.match(new RegExp(`^\\[(n\\d+)\\] [a-z]+ \\| ${title}\\b`, 'm'))?.[1];
    const tahoe = [...text.matchAll(/^\[(n\d+)\] [a-z]+ \| Tahoe/gm)].map((m) => m[1]);
    return json({
      notes: [
        { ref: ref('Lincoln Elementary'), type: 'place', title: 'Lincoln Elementary', body: 'The school on [[Elm St]].', people: [], tags: ['school', 'kids'], start: null, end: null, role: null },
        // Only tags change: the kept Tahoe note gets words to find it by.
        ...(tahoe[0] ? [{ ref: tahoe[0], type: 'fact', title: 'Tahoe', body: 'Spring break: Tahoe.', people: [], tags: ['travel', 'vacation', 'spring break'], start: null, end: null, role: null }] : []),
      ],
      merges: tahoe.length > 1 ? [{ keep: tahoe[0], drop: tahoe.slice(1) }] : [],
      create: [{ type: 'place', title: 'Elm St', body: 'A street.', people: [], start: null, end: null, role: null }],
    });
  }
  if (schema?.properties?.events) {
    // A calendar PDF: the test's lines are "YYYY-MM-DD[..YYYY-MM-DD] What".
    const events = [...text.matchAll(/^(\d{4}-\d{2}-\d{2})(?:\.\.(\d{4}-\d{2}-\d{2}))? (.+)$/gm)].map(([, start, end, summary]) => ({ summary, start, end: end ?? null, off: /no practice|break/i.test(summary) }));
    return json({ title: text.match(/^(.+Club.*)$/m)?.[1] ?? 'Calendar', school: false, events });
  }
  if (schema?.properties?.notes) {
    return json({ notes: [{ type: 'event', title: 'Dentist', body: `Dentist for ${text.match(/Person [A-Z]/g)?.[1] ?? 'someone'} at 3:30.`, people: [], start: '2026-11-14', end: null, role: null }] });
  }
  // Answers: repeat what was worked out, or the first note.
  const worked = text.match(/Worked out from calendars:\n([^\n]+)/)?.[1];
  const note = text.match(/^- [a-z]+: ([^\n]+)/m)?.[1];
  const unsaved = text.match(/not saved yet: [^\n]+\n- ([^\n]+)/)?.[1];
  return { text: worked ?? unsaved ?? note ?? 'I don’t know.', json: null, usd: 0.002, refused: false };
}
const json = (o) => ({ text: JSON.stringify(o), json: o, usd: 0.001, refused: false });

class MemoryStorage {
  constructor() {
    this.m = new Map();
  }
  async getItem(k) {
    return this.m.has(k) ? this.m.get(k) : null;
  }
  async setItem(k, v) {
    this.m.set(k, v);
  }
  async removeItem(k) {
    this.m.delete(k);
  }
}

let ics = '';
let pdf = makePdf([['Riverside Swim Club 2026-27', '2026-12-05 Swim meet', '2027-01-16..2027-01-17 Winter invitational']]);
const school = (extra = '') => `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:first
DTSTART;VALUE=DATE:20260819
SUMMARY:First Day of School
END:VEVENT
BEGIN:VEVENT
UID:vets
DTSTART;VALUE=DATE:20261111
SUMMARY:Veterans Day - No School
END:VEVENT
BEGIN:VEVENT
UID:thanks
DTSTART;VALUE=DATE:20261125
DTEND;VALUE=DATE:20261128
SUMMARY:Thanksgiving Break
END:VEVENT
BEGIN:VEVENT
UID:winter
DTSTART;VALUE=DATE:20261221
DTEND;VALUE=DATE:20270102
SUMMARY:Winter Recess
END:VEVENT
${extra}BEGIN:VEVENT
UID:last
DTSTART;VALUE=DATE:20270611
SUMMARY:Last Day of School
END:VEVENT
END:VCALENDAR`;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'homecircle-agent-e2e-'));
  calendar = createServer((req, res) => {
    if (req.url.endsWith('.pdf')) {
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      return res.end(pdf);
    }
    res.writeHead(200, { 'Content-Type': 'text/calendar' });
    res.end(ics);
  });
  await new Promise((r) => calendar.listen(0, '127.0.0.1', r));
  calUrl = `http://127.0.0.1:${calendar.address().port}/lincoln.ics`;
  app = createApp({
    version: 'test',
    dataDir: dir,
    setupToken: SETUP,
    trustProxy: 0,
    messageRetentionDays: 90,
    locationRequestCooldown: 60,
    inviteMaxHours: 168,
    push: 'none',
    tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    tileAttribution: 'OSM',
    webClient: false,
    agent: true,
    // The test's calendar is on this machine: let the agent read it.
    agentBrainOptions: { llm: fakeLlm, allowPrivateFetch: true, now: () => now },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${app.server.address().port}`;
  await app.agentHost.start(url);
});

after(async () => {
  for (const c of [mom, dad]) c.disconnect();
  await app.close();
  await new Promise((r) => calendar.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const errors = [];
const client = () => new CircleClient({ storage: new MemoryStorage(), onError: (e) => errors.push(e) });
const mom = client();
const dad = client();
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
/** Wait until `pred` holds after fetching, up to ~5 s. */
async function until(c, pred) {
  for (let i = 0; i < 50; i++) {
    await c.fetchMessages();
    const hit = pred(c);
    if (hit) return hit;
    await settle(100);
  }
  throw new Error(`timed out; last from agent: ${JSON.stringify(lastFromAgent(c)?.body?.text)}; agent DM: ${JSON.stringify(c.agent ? [...c.conversation(c.agent.id)].at(-1)?.body?.text : null)}`);
}
const lastFromAgent = (c) => (c.agent ? [...c.conversation(null)].reverse().find((m) => m.from === c.agent.id) : null);

test('an admin adds the agent: the server only ever sees the invite sealed', async () => {
  await mom.createCircle({ features: allFeatures(), serverUrl: url, setupToken: SETUP, name: 'Mom', circleName: 'Family' });
  await dad.joinWithInvite((await mom.createInvite()).link, { name: 'Dad' });
  await mom.refresh();
  assert.deepEqual(await mom.agentHostStatus(), { available: true, running: false });
  await assert.rejects(() => dad.setUpAgent({ name: 'Jarvis' }), /Only circle admins/);
  const agent = await mom.setUpAgent({ name: 'Jarvis' });
  assert.equal(agent.name, 'Jarvis');
  await dad.refresh();
  assert.equal(dad.agent.name, 'Jarvis');
  assert.equal((await dad.agentHostStatus()).running, true);
  // Its memory is on disk, encrypted, under the circle.
  assert.ok(existsSync(join(dir, 'agent', mom.circleId, 'memory.db')));
});

test('before an AI is set up it says so; admins set provider and budget, sealed to it', async () => {
  const qid = await dad.askAgent('When are the kids free?');
  assert.ok(qid);
  const a = await until(dad, lastFromAgent);
  assert.match(a.body.text, /not set up yet/);
  await assert.rejects(() => dad.agentRpc('setSettings', { budgetUsd: 5 }), /Only circle admins/);
  await mom.agentRpc('setSettings', { provider: { provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'sk-test-123' }, budgetUsd: 1 });
  const s = await dad.agentRpc('settings');
  assert.deepEqual([s.provider.model, s.provider.keySet, s.budgetUsd, s.name], ['claude-sonnet-5-5', true, 1, 'Jarvis']);
  assert.equal(JSON.stringify(s).includes('sk-test-123'), false);
  // A key that fails its test leaves the working settings alone.
  await assert.rejects(() => mom.agentRpc('setSettings', { provider: { provider: 'anthropic', model: 'claude-haiku-5-5', apiKey: 'sk-wrong' } }), /didn’t accept the API key/);
  assert.equal((await dad.agentRpc('settings')).provider.model, 'claude-sonnet-5-5');
});

test('telling it who the kids are; Remember keeps one message; Undo takes it back', async () => {
  await mom.askAgent('Kid and Sam are our kids');
  let a = await until(mom, (c) => (lastFromAgent(c)?.body.text.startsWith('📌') ? lastFromAgent(c) : null));
  assert.equal(a.body.text, '📌 Remembered: Kid; Sam');
  assert.equal(a.body.undo.length, 2);

  await dad.sendChat('Dentist for Kid on Nov 14 at 3:30');
  await mom.fetchMessages();
  const m = mom.messages.find((x) => x.body?.text === 'Dentist for Kid on Nov 14 at 3:30');
  await mom.rememberWithAgent(m.id);
  a = await until(mom, (c) => (lastFromAgent(c)?.body.text === '📌 Remembered: Dentist' ? lastFromAgent(c) : null));
  const notes = await mom.agentRpc('list');
  assert.deepEqual(notes.map((n) => n.title).sort(), ['Dentist', 'Kid', 'Sam']);
  assert.equal(notes.find((n) => n.title === 'Dentist').body, 'Dentist for [[Kid]] at 3:30.'.replace('[[Kid]]', 'Kid'));
  await mom.undoAgent(a.body.undo);
  await until(mom, (c) => (lastFromAgent(c)?.body.text === '↩️ Undone.' ? 1 : null));
  assert.deepEqual((await mom.agentRpc('list')).map((n) => n.title).sort(), ['Kid', 'Sam']);
});

test('adding a school calendar: whose is it, then it counts for free time', async () => {
  ics = school();
  await mom.askAgent(`add this calendar ${calUrl}`);
  let a = await until(mom, (c) => (/Whose calendar/.test(lastFromAgent(c)?.body.text) ? lastFromAgent(c) : null));
  await mom.askAgent('for Kid and Sam');
  a = await until(mom, (c) => (/Added/.test(lastFromAgent(c)?.body.text) ? lastFromAgent(c) : null));
  assert.match(a.body.text, /^📅 Added Kid and Sam’s school calendar: 3 days off listed; next: Veterans Day - No School \(Nov 11\)/);
  // The address is a secret: never repeated in a chat.
  assert.ok(!dad.messages.some((x) => x.body?.text?.includes('lincoln.ics')) && !a.body.text.includes('127.0.0.1'));
});

test('changing provider or model keeps everything it remembers', async () => {
  const notes = await mom.agentRpc('list');
  assert.ok(notes.length >= 3);
  await mom.agentRpc('setSettings', { provider: { provider: 'openai', model: 'gpt-test', apiKey: 'sk-openai', inUsd: 1, outUsd: 2 } });
  assert.equal((await dad.agentRpc('settings')).provider.model, 'gpt-test');
  assert.deepEqual(await mom.agentRpc('list'), notes);
  await mom.agentRpc('setSettings', { provider: { provider: 'anthropic', model: 'claude-haiku-5-5', apiKey: 'sk-test-123' } });
  assert.deepEqual(await mom.agentRpc('list'), notes);
  // The next test answers from these notes and the calendar with the new model.
});

test('“when are the kids free for 5 days” is worked out from the calendar, names never reach the AI', async () => {
  await dad.askAgent('When are the kids free next? I want to plan a 5 day vacation');
  const a = await until(dad, (c) => (/Free 5 days/.test(lastFromAgent(c)?.body.text) ? lastFromAgent(c) : null));
  assert.equal(a.body.text, 'Free 5 days in a row for Kid and Sam: Nov 25–29; Dec 19–Jan 3; Jun 12–Aug 18.');
  // Mom sees the question and the answer in the group too.
  const seenByMom = await until(mom, (c) => (/Free 5 days/.test(lastFromAgent(c)?.body.text) ? lastFromAgent(c) : null));
  assert.equal(seenByMom.peer, null);
  // Except the message that first named the kids, nothing real went out.
  for (const sent of sentToAi.filter((x) => !/are our kids/.test(x))) for (const real of ['Kid', 'Sam', 'Mom', 'Dad']) assert.ok(!new RegExp(`\\b${real}\\b`).test(sent), `${real} reached the AI: ${sent.slice(0, 200)}`);
});

test('a changed calendar: the people it’s for and whoever added it hear about it', async () => {
  ics = school(`BEGIN:VEVENT
UID:teacher
DTSTART;VALUE=DATE:20261120
SUMMARY:Teacher Work Day - No School
END:VEVENT
`);
  now = new Date(now.getTime() + 7 * 3600_000);
  await app.agentHost.refresh();
  const dm = await until(mom, (c) => [...c.conversation(c.agent.id)].reverse().find((m) => /changed/.test(m.body?.text ?? '')));
  assert.equal(dm.body.text, '📅 Kid and Sam’s school calendar changed: added “Teacher Work Day - No School” (Nov 20).');
});

test('a calendar PDF: the dates are listed for a check, saved on OK, read again only when it changes', async () => {
  const pdfUrl = calUrl.replace('lincoln.ics', 'swim.pdf');
  await mom.askAgent(`${pdfUrl} for Sam`);
  const list = await until(mom, (c) => (lastFromAgent(c)?.body.save ? lastFromAgent(c) : null));
  assert.equal(list.body.text, '📄 Riverside Swim Club 2026-27: I found 2 dates.\n• Dec 5: Swim meet\n• Jan 16–17: Winter invitational\nCheck them, then Save (you can fix any later in Memory) or Discard.');
  assert.equal(list.body.save.by, mom.account.memberId);
  // Only the person who added it can save it; nothing is kept until then.
  await dad.saveAgentFound(list.body.save.id, true);
  await until(dad, (c) => (/isn’t yours/.test(lastFromAgent(c)?.body.text) ? 1 : null));
  assert.equal((await mom.agentRpc('list', { type: 'source' })).filter((n) => n.data?.format === 'pdf').length, 0);
  await mom.saveAgentFound(list.body.save.id, true);
  const added = await until(mom, (c) => (/Added Sam’s calendar/.test(lastFromAgent(c)?.body.text) ? lastFromAgent(c) : null));
  assert.equal(added.body.text, '📅 Added Sam’s calendar: 2 events; next: Swim meet (Dec 5). I’ll check it for changes every 6 hours.');
  const [src] = (await mom.agentRpc('list', { type: 'source' })).filter((n) => n.data?.format === 'pdf');
  assert.equal(src.data.count, 2);

  // Unchanged: no AI call. Changed: whoever added it gets the new list to check.
  const calls = sentToAi.length;
  now = new Date(now.getTime() + 7 * 3600_000);
  await app.agentHost.refresh();
  assert.equal(sentToAi.length, calls);
  pdf = makePdf([['Riverside Swim Club 2026-27', '2026-12-05 Swim meet', '2026-12-12 Holiday party']]);
  now = new Date(now.getTime() + 7 * 3600_000);
  await app.agentHost.refresh();
  const changed = await until(mom, (c) => [...c.conversation(c.agent.id)].reverse().find((m) => m.body?.save && /changed/.test(m.body.text)));
  assert.match(changed.body.text, /^📄 Sam’s calendar changed\. This is what it says now:\n• Dec 5: Swim meet\n• Dec 12: Holiday party\n/);
  await mom.saveAgentFound(changed.body.save.id, true, { peer: mom.agent.id });
  await until(mom, (c) => [...c.conversation(c.agent.id)].reverse().find((m) => /Updated Sam’s calendar: 2 dates/.test(m.body?.text ?? '')));
  // The same file again later: not read again.
  const after = sentToAi.length;
  now = new Date(now.getTime() + 7 * 3600_000);
  await app.agentHost.refresh();
  assert.equal(sentToAi.length, after);
});

test('a dream (admins only) sorts, merges and adds, and one Undo takes it all back', async () => {
  for (const note of [
    { type: 'fact', title: 'Lincoln Elementary', body: 'Lincoln Elementary is on Elm St.' },
    { type: 'decision', title: 'Tahoe trip', body: 'We decided on Tahoe for spring break.' },
    { type: 'fact', title: 'Tahoe', body: 'Spring break: Tahoe.' },
  ])
    await mom.agentRpc('add', { note });
  const before = (await mom.agentRpc('list')).map((n) => `${n.type}:${n.title}`).sort();
  await dad.askAgent('dream');
  await until(dad, (c) => (/Only circle admins can start a dream/.test(lastFromAgent(c)?.body.text) ? 1 : null));

  // Written as in the app, in the chat with the agent: the name and slash are dropped.
  await mom.askAgent('/Jarvis/dream', { peer: mom.agent.id });
  const fromAgentDm = (c) => [...c.conversation(c.agent.id)].reverse().find((m) => m.from === c.agent.id);
  const done = await until(mom, (c) => (/Dream done/.test(fromAgentDm(c)?.body.text) ? fromAgentDm(c) : null));
  assert.equal(done.body.text, '💤 Dream done: 2 tagged, 1 sorted or tidied, 1 duplicate merged, 1 new note for people and places. Every change is in each note’s history in Memory.');
  const after = await mom.agentRpc('list');
  // Tags make it findable by words that aren't in it.
  assert.deepEqual(after.find((n) => n.title.startsWith('Tahoe')).tags, ['travel', 'vacation', 'spring break']);
  assert.equal((await mom.agentRpc('search', { text: 'vacation' }))[0]?.title, 'Tahoe');
  assert.equal(after.find((n) => n.title === 'Lincoln Elementary').type, 'place');
  assert.equal(after.filter((n) => n.title.startsWith('Tahoe')).length, 1);
  assert.ok(after.some((n) => n.type === 'place' && n.title === 'Elm St'));
  // The dream never saw the calendars' data, only notes.
  assert.ok(!sentToAi.at(-1).includes('source |'));

  await mom.undoAgent(done.body.undo, { peer: mom.agent.id });
  await until(mom, (c) => (fromAgentDm(c)?.body.text === '↩️ Undone.' ? 1 : null));
  assert.deepEqual((await mom.agentRpc('list')).map((n) => `${n.type}:${n.title}`).sort(), before);
});

test('a photo: read, checked, saved; then the file is kept (and opens) or deleted', async () => {
  const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 500 }, (_, i) => i % 256)]);
  const peer = mom.agent.id;
  const fromAgentDm = (c, re) => [...c.conversation(c.agent.id)].reverse().find((m) => m.from === c.agent.id && re.test(m.body?.text ?? ''));
  await mom.sendFileToAgent(photo, { name: 'team-sheet.jpg', mime: 'image/jpeg' }, { peer });
  const list = await until(mom, (c) => fromAgentDm(c, /I’d keep/));
  assert.equal(list.body.text, '📄 Soccer team sheet: The coach’s phone number.\nI’d keep:\n• Soccer contacts: Coach Dana: 555-0100.\nDoes this look right? Save it (you can fix anything later in Memory) or Discard.');
  // The AI was sent the photo itself; the server only ever had ciphertext.
  assert.match(sentToAi.at(-1), /\[image\]/);
  const [stored] = readdirSync(join(dir, 'files'));
  assert.ok(!Buffer.from(readFileSync(join(dir, 'files', stored))).includes(Buffer.from(photo.subarray(4, 100))));

  await mom.saveAgentFound(list.body.save.id, true, { peer });
  const ask = await until(mom, (c) => fromAgentDm(c, /^Delete “team-sheet\.jpg”/));
  assert.equal(ask.body.fileChoice.by, mom.account.memberId);
  await mom.answerAgentFile(ask.body.fileChoice.id, true, { peer });
  await until(mom, (c) => fromAgentDm(c, /Kept “team-sheet\.jpg”/));
  const note = (await mom.agentRpc('list')).find((n) => n.title === 'Soccer contacts');
  assert.deepEqual(note.tags, ['soccer', 'contacts', 'coach']);
  assert.deepEqual(await mom.openAgentFile(note.data.file), photo);
  // Kept files stay past 7 days; deleting it from Memory removes it from the server.
  await mom.agentRpc('deleteFile', { id: note.id });
  assert.equal((await mom.agentRpc('get', { id: note.id })).note.data?.file, undefined);
  await assert.rejects(() => mom.openAgentFile(note.data.file), (e) => e.status === 404);
});

test('a discarded or empty reading deletes the file; a sheet of dates becomes a calendar', async () => {
  const peer = mom.agent.id;
  const fromAgentDm = (c, re) => [...c.conversation(c.agent.id)].reverse().find((m) => m.from === c.agent.id && re.test(m.body?.text ?? ''));
  const before = readdirSync(join(dir, 'files')).length;
  await mom.sendFileToAgent(new Uint8Array([0xff, 0xd8, 1, 2, 3, 4, 5, 6, 7, 8]), { name: 'blank page.jpg', mime: 'image/jpeg' }, { peer });
  await until(mom, (c) => fromAgentDm(c, /found nothing to keep.*I deleted the file/));
  assert.equal(readdirSync(join(dir, 'files')).length, before);

  // In the group: everyone sees "/Jarvis 📎 …" and the answer; only the sender gets Save.
  const csv = new TextEncoder().encode('date,what\n2026-12-05,Home meet\n2027-01-16,Away meet\n2027-02-06,Finals');
  await mom.sendFileToAgent(csv, { name: 'meets.csv', mime: 'text/csv' });
  const list = await until(dad, (c) => (lastFromAgent(c)?.body.save ? lastFromAgent(c) : null));
  assert.match(list.body.text, /^📄 Swim meets: I found 3 dates\.\n• Dec 5: Home meet/);
  assert.notEqual(list.body.save.by, dad.account.memberId);
  assert.ok(dad.conversation(null).some((m) => m.body?.text === '/Jarvis 📎 meets.csv'));
  await mom.saveAgentFound(list.body.save.id, true);
  await until(mom, (c) => (/Whose calendar is it/.test(lastFromAgent(c)?.body.text) ? 1 : null));
  await mom.askAgent('for Sam');
  const ask = await until(mom, (c) => (lastFromAgent(c)?.body.fileChoice ? lastFromAgent(c) : null));
  assert.ok(mom.conversation(null).some((m) => /📅 Added Sam’s calendar: 3 events; next: Home meet \(Dec 5\)\.$/.test(m.body?.text ?? '')));
  await mom.answerAgentFile(ask.body.fileChoice.id, false);
  await until(mom, (c) => (/Deleted “meets\.csv” from the server/.test(lastFromAgent(c)?.body.text) ? 1 : null));
  assert.equal(readdirSync(join(dir, 'files')).length, before);
  // Dad can't answer a question that was for Mom.
  assert.equal(ask.body.fileChoice.by, mom.account.memberId);
});

test('after sending a file, follow-ups are read with the conversation: questions about it, and whose it is', async () => {
  const peer = mom.agent.id;
  const fromAgentDm = (c, re) => [...c.conversation(c.agent.id)].reverse().find((m) => m.from === c.agent.id && re.test(m.body?.text ?? ''));
  const sentBefore = sentToAi.length;
  const csv = new TextEncoder().encode('date,what\n2026-12-12,Home meet\n2027-01-23,Away meet\n2027-02-13,Finals');
  await mom.sendFileToAgent(csv, { name: 'season.csv', mime: 'text/csv' }, { peer });
  const list = await until(mom, (c) => fromAgentDm(c, /^📄 Swim meets/));

  // A question about it before it's saved: the AI gets the conversation and the dates just read.
  await mom.askAgent('when is the first meet?', { peer });
  const a = await until(mom, (c) => fromAgentDm(c, /^Dec 12: Home meet$/));
  assert.ok(a);
  const asked = sentToAi.findLast((p) => p.includes('now says: when is the first meet?'));
  assert.match(asked, /Our conversation so far \(oldest first\):\n.*\[sent a file: “season\.csv”\]\n.*📄 Swim meets: I found 3 dates/s);

  // "my son" with two kids: which one?
  await mom.askAgent('this is my son’s swim calendar', { peer });
  await until(mom, (c) => fromAgentDm(c, /^Whose is it\? Answer “\/Jarvis for Kid” \(or “for Kid and Sam”\)\.$/));
  // Named: it's for them, and Save adds it straight away.
  await mom.askAgent('this is Sam’s swim calendar', { peer });
  const got = await until(mom, (c) => fromAgentDm(c, /^Got it: Sam’s calendar\. Tap Save to add it\.$/));
  assert.equal(got.body.save.id, list.body.save.id);
  // Names never reach the AI, in the conversation either.
  assert.ok(!sentToAi.slice(sentBefore).some((p) => /\bSam\b/.test(p)));
  await mom.saveAgentFound(got.body.save.id, true);
  const ask = await until(mom, (c) => fromAgentDm(c, /^Delete “season\.csv”/));
  assert.ok(mom.conversation(mom.agent.id).some((m) => /^📅 Added Sam’s calendar: 3 events; next: Home meet \(Dec 12\)\.$/.test(m.body?.text ?? '')));
  await mom.answerAgentFile(ask.body.fileChoice.id, false);
  await until(mom, (c) => fromAgentDm(c, /Deleted “season\.csv”/));
});

test('a PDF with no text says so', async () => {
  pdf = makePdf([['']]);
  await mom.askAgent(`${calUrl.replace('lincoln.ics', 'scan.pdf')}`);
  const a = await until(mom, (c) => (/no text in it/.test(lastFromAgent(c)?.body.text) ? lastFromAgent(c) : null));
  assert.ok(a);
});

test('shopping lists: in chat and from the app; a receipt counts as bought and puts usual items first', async () => {
  const peer = mom.agent.id;
  const fromAgentDm = (c, re) => [...c.conversation(c.agent.id)].reverse().find((m) => m.from === c.agent.id && re.test(m.body?.text ?? ''));
  // In the group, plain words, no AI.
  const calls = sentToAi.length;
  await dad.askAgent('add milk, eggs and bananas to the Costco list');
  await until(dad, (c) => (lastFromAgent(c)?.body.text === '🛒 Added to Costco: milk, eggs, bananas.' ? 1 : null));
  await mom.askAgent('remove bananas from costco');
  await until(mom, (c) => (lastFromAgent(c)?.body.text === '🛒 Took off Costco: bananas.' ? 1 : null));
  assert.equal(sentToAi.length, calls);
  // Other wording goes through the AI.
  await mom.askAgent('we need paneer and chai from the desi store');
  await until(mom, (c) => (lastFromAgent(c)?.body.text === '🛒 Added to desi store: paneer, chai.' ? 1 : null));

  // The app: tick, Done shopping.
  let lists = await dad.agentRpc('lists');
  const costco = lists.find((l) => l.name === 'Costco');
  lists = await dad.agentRpc('itemTick', { listId: costco.id, itemId: costco.items.find((i) => i.name === 'eggs').id, ticked: true });
  lists = await dad.agentRpc('doneShopping', { listId: costco.id });
  assert.deepEqual(lists.find((l) => l.id === costco.id).items.map((i) => i.name), ['milk']);

  // A receipt: Milk comes off the list; what's bought often goes first.
  await mom.sendFileToAgent(new Uint8Array([0xff, 0xd8, 9, 9, 9, 9]), { name: 'costco-receipt.jpg', mime: 'image/jpeg' }, { peer });
  const r = await until(mom, (c) => fromAgentDm(c, /^🧾 Costco receipt: 3 items: Milk, Paper towels, Eggs\./));
  await mom.saveAgentFound(r.body.save.id, true, { peer });
  await until(mom, (c) => fromAgentDm(c, /Counted 3 items as bought at Costco, and took milk off the list/));
  const ask = await until(mom, (c) => fromAgentDm(c, /^Delete “costco-receipt\.jpg”/));
  await mom.answerAgentFile(ask.body.fileChoice.id, false, { peer });
  lists = await mom.agentRpc('itemAdd', { listId: costco.id, names: ['batteries', 'Eggs'] });
  const view = lists.find((l) => l.id === costco.id);
  // Eggs were bought twice (Done shopping and the receipt): first. Paper towels, once: not suggested yet.
  assert.deepEqual(view.items.map((i) => i.name), ['Eggs', 'batteries']);
  assert.deepEqual(view.usual, []);
  await mom.askAgent("what's on the Costco list?");
  await until(mom, (c) => (lastFromAgent(c)?.body.text === '🛒 Costco:\n• Eggs\n• batteries' ? 1 : null));
});

test('reminders: set in chat, sent to admins and whoever set it in the morning, Done moves a yearly one on', async () => {
  await dad.askAgent('remind us to renew the car registration on Nov 30 every year');
  await until(dad, (c) => (/I’ll remind every admin about Car registration/.test(lastFromAgent(c)?.body.text) ? 1 : null));
  await app.agentHost.refresh();
  const dm = (c) => [...c.conversation(c.agent.id)].reverse().find((m) => m.body?.reminder);
  const toMom = await until(mom, dm);
  const toDad = await until(dad, dm);
  assert.match(toMom.body.text, /^⏰ Car registration is due in \d+ days \(Nov 30, 2026\)\.$/);
  assert.equal(toDad.body.reminder.id, toMom.body.reminder.id);
  // Once a day: a second check the same day sends nothing new.
  await app.agentHost.refresh();
  await mom.doneAgentReminder(toMom.body.reminder.id, { peer: mom.agent.id });
  await until(mom, (c) => [...c.conversation(c.agent.id)].reverse().find((m) => /Car registration is done\. Next one: Nov 30, 2027/.test(m.body?.text ?? '')));
  const [rem] = await dad.agentRpc('reminders');
  assert.deepEqual([rem.due, rem.repeat, rem.createdByName], ['2027-11-30', 'yearly', 'Dad']);
  assert.equal(mom.conversation(mom.agent.id).filter((m) => m.body?.reminder).length, 1);
});

test('spending: per person for admins, and a hard stop at the budget', async () => {
  const u = await mom.agentRpc('usage');
  assert.ok(u.total > 0 && u.byMember.length >= 2);
  assert.equal((await dad.agentRpc('usage')).byMember, null);
  // Budget of $1: spend it, then the agent stops calling the AI.
  await mom.agentRpc('setSettings', { budgetUsd: 0.001 });
  await dad.askAgent('What did we decide about Tahoe?');
  const a = await until(dad, (c) => (/out of budget/.test(lastFromAgent(c)?.body.text) ? lastFromAgent(c) : null));
  assert.match(a.body.text, /I’m out of budget until Dec 1\. Ask an admin to raise it\./);
});

test('a memory bigger than one message still loads: the answer comes in parts', async () => {
  const body = (i) => `Note ${i}: ${'a long “tidied” body with [[links]] and émojis 🧠 '.repeat(60)}`;
  for (let i = 0; i < 10; i++) await mom.agentRpc('add', { note: { type: 'fact', title: `Big note ${i}`, body: body(i), people: [], tags: ['test'] } });
  const notes = await mom.agentRpc('list');
  assert.ok(JSON.stringify(notes).length > 30_000);
  const big = notes.filter((n) => n.title.startsWith('Big note '));
  assert.equal(big.length, 10);
  assert.equal(big.find((n) => n.title === 'Big note 7').body, body(7));
  for (const n of big) await mom.agentRpc('remove', { id: n.id });
});

test('Download memory: an Obsidian vault zipped, with calendars, lists, reminders and kept files; private notes only for their owner', async () => {
  // A private note, and a photo kept with a note (the spending test left the budget spent).
  await mom.agentRpc('setSettings', { budgetUsd: 100 });
  await mom.agentRpc('add',{ note: { type: 'fact', title: 'Surprise party', body: 'For [[Dad]], on his birthday.' }, private: true });
  const peer = mom.agent.id;
  // Only answers to this test's photo (an earlier test sent one with the same name).
  const since = Math.max(0, ...mom.conversation(peer).map((m) => m.seq));
  const fromAgentDm = (c, re) => [...c.conversation(c.agent.id)].reverse().find((m) => m.seq > since && m.from === c.agent.id && re.test(m.body?.text ?? ''));
  const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 300 }, (_, i) => (i * 7) % 256)]);
  await mom.sendFileToAgent(photo, { name: 'team-sheet.jpg', mime: 'image/jpeg' }, { peer });
  const found = await until(mom, (c) => fromAgentDm(c, /I’d keep/));
  await mom.saveAgentFound(found.body.save.id, true, { peer });
  const ask = await until(mom, (c) => fromAgentDm(c, /^Delete “team-sheet\.jpg”/));
  await mom.answerAgentFile(ask.body.fileChoice.id, true, { peer });
  await until(mom, (c) => fromAgentDm(c, /Kept “team-sheet\.jpg”/));

  const download = async (c) => {
    const out = await c.agentRpc('exportZip', {}, { timeoutMs: 60_000 });
    assert.equal(out.parts.length, 1);
    const zip = unzipSync(await c.openAgentFile(out.parts[0]));
    await mom.api.deleteFile(out.parts[0].id);
    return { out, zip, text: (p) => strFromU8(zip[p]) };
  };
  const { out, zip, text } = await download(mom);
  assert.match(out.parts[0].name, /^Jarvis memory \d{4}-\d{2}-\d{2}\.zip$/);
  const paths = Object.keys(zip);
  assert.ok(paths.includes('README.md') && paths.includes('Home.md'));
  // Notes by kind, with properties; calendars also as .ics; lists and reminders as checklists.
  const party = text('Facts/Surprise party.md');
  assert.match(party, /^---\ntype: "fact"\nscope: "private"\n/);
  assert.match(party, /For \[\[Dad\]\], on his birthday\./);
  const ics = paths.find((p) => p.startsWith('Calendars/') && p.endsWith('.ics'));
  assert.match(text(ics), /^BEGIN:VCALENDAR\r\n[\s\S]*BEGIN:VEVENT\r\n[\s\S]*SUMMARY:/);
  assert.match(text(ics.replace(/\.ics$/, '.md')), /## Dates\n\n- \d{4}-\d{2}-\d{2}/);
  assert.ok(paths.some((p) => p.startsWith('Lists/') && /^- \[[ x]\] /m.test(text(p))));
  assert.match(text('Reminders.md'), /^- \[[ x]\] .+: due \d{4}-\d{2}-\d{2}/m);
  // The kept photo, whole, shown in its note.
  assert.deepEqual(out.missing, []);
  assert.deepEqual(paths.filter((p) => p.startsWith('Files/')), ['Files/team-sheet.jpg'], JSON.stringify({ paths, files: out.files }));
  assert.deepEqual(zip['Files/team-sheet.jpg'], photo);
  assert.ok(paths.some((p) => p.startsWith('Facts/') && text(p).includes('![[Files/team-sheet.jpg]]')));
  assert.match(text('Home.md'), /- \[\[Facts\/Surprise party\|Surprise party\]\]/);

  // Dad's download has the circle's notes, not Mom's private ones: the party,
  // and the photo she sent the helper in their own chat.
  const dadsDownload = await download(dad);
  assert.ok(Object.keys(dadsDownload.zip).includes('Lists/Costco.md'));
  assert.ok(!Object.keys(dadsDownload.zip).includes('Facts/Surprise party.md'));
  assert.ok(!Object.keys(dadsDownload.zip).some((p) => p.startsWith('Files/')));

  // Tidy up for the next test: the kept photo goes too.
  const kept = (await mom.agentRpc('list')).find((n) => n.data?.file?.name === 'team-sheet.jpg');
  await mom.agentRpc('deleteFile', { id: kept.id });
});

test('export, then removing the agent deletes its memory', async () => {
  const files = await mom.agentRpc('export');
  assert.ok(files['person/Kid.md'].includes('role') || files['person/Kid.md'].includes('# Kid'));
  // A file still waiting: only its sender, the agent or an admin may delete it.
  const { id: waiting } = await dad.api.uploadFile(new Uint8Array(64).fill(7));
  await assert.rejects(() => dad.api.deleteFile('x'.repeat(24)), (e) => e.status === 404);
  const carol = client();
  await carol.joinWithInvite((await mom.createInvite()).link, { name: 'Carol' });
  await assert.rejects(() => carol.api.deleteFile(waiting), (e) => e.status === 403);
  assert.equal(readdirSync(join(dir, 'files')).length, 1);
  // Removing the agent removes every file that was for it.
  await mom.removeAgent();
  await settle(500);
  assert.deepEqual(readdirSync(join(dir, 'files')), []);
  await assert.rejects(() => dad.api.uploadFile(new Uint8Array(64)), (e) => e.status === 404 && e.code === 'no_agent');
  carol.disconnect();
  assert.equal(existsSync(join(dir, 'agent', mom.circleId)), false);
  assert.ok(!readdirSync(join(dir, 'agent')).includes(mom.circleId));
  await dad.refresh();
  assert.equal(dad.agent, null);
});

test('no unexpected client errors', () => {
  assert.deepEqual(
    errors.map((e) => e.message),
    [],
  );
});
