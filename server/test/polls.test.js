// Polls: a sealed chat message with the poll in it; votes, suggestions and
// closing ride on reactions without an emoji. No server changes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { CircleClient } from '../../packages/core/src/index.js';

const SETUP = 'test-setup-token-polls';
let app;
let url;
let dir;

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

const errors = [];
const client = () => new CircleClient({ storage: new MemoryStorage(), onError: (e) => errors.push(e) });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'homecircle-polls-'));
  app = createApp({
    version: 'test',
    dataDir: dir,
    setupToken: SETUP,
    trustProxy: false,
    messageRetentionDays: 90,
    locationRequestCooldown: 60,
    inviteMaxHours: 168,
    push: 'none',
    tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    tileAttribution: 'OSM',
    webClient: false,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const mom = client();
const dad = client();
const kid = client();
const sync = () => Promise.all([mom, dad, kid].map((c) => c.fetchMessages()));
const lastPoll = (c) => [...c.messages].reverse().find((m) => m.body?.poll);

test('a poll reaches everyone, readable as text by older apps', async () => {
  await mom.createCircle({ serverUrl: url, setupToken: SETUP, name: 'Mom', circleName: 'Family' });
  await dad.joinWithInvite((await mom.createInvite()).link, { name: 'Dad' });
  await kid.joinWithInvite((await mom.createInvite()).link, { name: 'Kid' });
  await Promise.all([mom, dad, kid].map((c) => c.refresh()));

  await assert.rejects(() => mom.createPoll({ question: 'Only one?', options: [{ label: 'Yes' }] }), /2 to 8 options/);
  await mom.createPoll({
    question: 'Where should we eat tonight?',
    options: [
      { label: 'Pizza', emoji: '🍕' },
      { label: 'Tacos', emoji: '🌮' },
      { label: 'Thai', emoji: 'not an emoji' },
    ],
  });
  await sync();
  const m = lastPoll(dad);
  assert.match(m.body.text, /^📊 Where should we eat tonight\?\n🍕 Pizza\n🌮 Tacos\n• Thai\n\(Update HomeCircle to vote\)$/);
  const s = dad.pollState(m.id);
  assert.equal(s.question, 'Where should we eat tonight?');
  assert.deepEqual(
    s.options.map((o) => [o.id, o.label, o.emoji, o.votes]),
    [
      ['o1', 'Pizza', '🍕', 0],
      ['o2', 'Tacos', '🌮', 0],
      ['o3', 'Thai', '', 0],
    ],
  );
  assert.equal(s.eligible, 3);
  assert.equal(s.creatorName, 'Mom');
  assert.equal(s.mine, false);
  assert.equal(mom.pollState(m.id).mine, true);
  // The server only stores ciphertext.
  assert.ok(!JSON.stringify(app.store.db.prepare('SELECT env FROM messages').all()).includes('eat tonight'));
});

test('votes count once per person, the latest wins, and older apps ignore them', async () => {
  const id = lastPoll(mom).id;
  await dad.vote(id, ['o1']);
  await kid.vote(id, ['o2']);
  await kid.vote(id, ['o1']); // changed their mind
  await mom.vote(id, ['o3', 'o1']); // single choice: only the first counts
  await sync();
  const s = kid.pollState(id);
  assert.deepEqual(
    s.options.map((o) => [o.label, o.votes, o.voters.sort()]),
    [
      ['Pizza', 2, ['Dad', 'Kid']],
      ['Tacos', 0, []],
      ['Thai', 1, ['Mom']],
    ],
  );
  assert.equal(s.voters, 3);
  assert.equal(s.everyoneVoted, true);
  assert.deepEqual(s.myVote, ['o1']);
  assert.deepEqual(
    s.winners.map((w) => w.label),
    ['Pizza'],
  );
  // To older apps, a vote is a reaction with no emoji: nothing shows.
  assert.deepEqual(kid.reactionsFor(id), []);
  // Votes don't add chat lines.
  assert.equal(kid.conversation().filter((x) => x.kind === 'chat').length, 1);
  await dad.vote(id, []); // withdraw
  await sync();
  assert.equal(mom.pollState(id).voters, 2);
  await dad.vote(id, ['o1']);
  await sync();
});

test('anyone can suggest an option; multiple choice counts every pick', async () => {
  await dad.createPoll({ question: 'Movie night snacks?', options: [{ label: 'Popcorn', emoji: '🍿' }, { label: 'Ice cream' }], multi: true });
  await sync();
  const id = lastPoll(kid).id;
  await kid.suggestOption(id, 'Sushi', '🍣');
  await kid.suggestOption(id, 'popcorn'); // same as an existing option: not added twice
  await sync();
  const s = mom.pollState(id);
  assert.deepEqual(
    s.options.map((o) => o.label),
    ['Popcorn', 'Ice cream', 'Sushi'],
  );
  const sushi = s.options[2].id;
  await mom.vote(id, ['o1', sushi, 'o1']);
  await sync();
  assert.deepEqual(
    dad.pollState(id).options.map((o) => o.votes),
    [1, 0, 1],
  );

  await mom.createPoll({ question: 'Fixed?', options: [{ label: 'A' }, { label: 'B' }], allowAdd: false });
  await sync();
  await assert.rejects(() => kid.suggestOption(lastPoll(kid).id, 'C'), /doesn’t take new options/);
});

test('only its creator closes it; the result is posted and later votes don’t count', async () => {
  await sync();
  const id = [...mom.messages].find((m) => m.body?.poll?.question === 'Where should we eat tonight?').id;
  await assert.rejects(() => dad.closePoll(id), /Only the person who started/);
  // A close sent by someone else (e.g. an old or modified app) is ignored.
  await dad._post('reaction', { target: id, close: true }, { silent: true });
  await sync();
  assert.equal(kid.pollState(id).closed, false);

  await mom.closePoll(id);
  await sync();
  assert.equal(kid.pollState(id).closed, true);
  assert.match(kid.messages.at(-1).body.text, /^🏁 Poll closed: 🍕 Pizza wins$/);
  await assert.rejects(() => kid.vote(id, ['o2']), /closed/);
  // A vote that arrives after closing (from a modified app) is ignored too.
  await kid._post('reaction', { target: id, vote: ['o2'] }, { silent: true });
  await sync();
  assert.deepEqual(
    mom.pollState(id).options.map((o) => o.votes),
    [2, 0, 1],
  );
});

test('a deadline closes it on its own', async () => {
  await mom.createPoll({ question: 'Leave at 5?', options: [{ label: 'Yes' }, { label: 'No' }], closesAt: Date.now() + 60_000 });
  await sync();
  const id = lastPoll(dad).id;
  assert.equal(dad.pollState(id).closed, false);
  assert.equal(dad.pollState(id, Date.now() + 61_000).closed, true);
});

test('spinning the wheel picks a leader for everyone', async () => {
  await kid.createPoll({ question: 'Game?', options: [{ label: 'Chess', emoji: '♟️' }, { label: 'Uno' }, { label: 'Catan' }] });
  await sync();
  const id = lastPoll(mom).id;
  await mom.vote(id, ['o1']);
  await dad.vote(id, ['o2']);
  await sync();
  const pick = await kid.spinWheel(id);
  assert.ok(['Chess', 'Uno'].includes(pick.label), 'only a leading option');
  await sync();
  const s = dad.pollState(id);
  assert.equal(s.spin.option.label, pick.label);
  assert.equal(s.spin.by, 'Kid');
  assert.match(dad.messages.at(-1).body.text, /^🎡 Kid spun the wheel: /);
});

test('a poll in a direct chat is just between the two', async () => {
  await mom.createPoll({ question: 'Date night?', options: [{ label: 'Friday' }, { label: 'Saturday' }] }, { to: dad.account.memberId });
  await sync();
  const m = [...dad.messages].reverse().find((x) => x.body?.poll?.question === 'Date night?');
  assert.equal(m.peer, mom.account.memberId);
  assert.equal(dad.pollState(m.id).eligible, 2);
  assert.ok(!kid.messages.some((x) => x.body?.poll?.question === 'Date night?'));
  await dad.vote(m.id, ['o2']);
  await sync();
  assert.deepEqual(mom.pollState(m.id).myVote, []);
  assert.equal(mom.pollState(m.id).options[1].votes, 1);
});

test('a vote that arrives live during catch-up doesn’t hide the ones before it', async () => {
  await mom.createPoll({ question: 'Pancakes or waffles?', options: [{ label: 'Pancakes' }, { label: 'Waffles' }] });
  await sync();
  const id = lastPoll(kid).id;
  // Kid's live connection is down (phone locked): Dad votes, then Mom votes.
  await dad.vote(id, ['o1']);
  await mom.vote(id, ['o2']);
  // Kid comes back; Mom's vote arrives live before Kid's catch-up fetch runs.
  const { messages } = await kid.api.messages(0, 500);
  await kid._onEvent({ type: 'message', message: messages.at(-1) });
  await kid.fetchMessages();
  assert.deepEqual(
    kid.pollState(id).options.map((o) => o.votes),
    [1, 1],
    'Dad’s vote is still fetched',
  );
});

test('closing counts votes the closer’s phone hadn’t fetched yet', async () => {
  await mom.createPoll({ question: 'Beach or park?', options: [{ label: 'Beach' }, { label: 'Park' }] });
  await sync();
  const id = lastPoll(dad).id;
  await dad.vote(id, ['o2']);
  await kid.vote(id, ['o2']);
  // Mom's phone never heard about those votes, and closes.
  await mom.closePoll(id);
  await sync();
  assert.match(dad.messages.at(-1).body.text, /^🏁 Poll closed: Park wins$/);
  for (const c of [mom, dad, kid]) assert.equal(c.pollState(id).voters, 2);
});

test('no unexpected client errors', () => {
  assert.deepEqual(
    errors.map((e) => e.message),
    [],
  );
});
