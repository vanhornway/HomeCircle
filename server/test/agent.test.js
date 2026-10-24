// The circle's agent as a member: it joins without the circle key, can't read
// the chat, only sends direct messages, and its answers to the group show in
// the group on everyone's phone.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { AgentClient, CircleClient } from '../../packages/core/src/index.js';

const SETUP = 'test-setup-token-agent';
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
  dir = mkdtempSync(join(tmpdir(), 'homecircle-agent-'));
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
const agent = new AgentClient({ storage: new MemoryStorage(), onError: (e) => errors.push(e) });
// In order: an admin's phone (Mom's) records the agent's card, then others see it.
const sync = async () => {
  for (const c of [mom, dad]) {
    await c.refresh();
    await c.fetchMessages();
  }
};

test('an admin invites the agent by name; the invite carries no circle key', async () => {
  await mom.createCircle({ serverUrl: url, setupToken: SETUP, name: 'Mom', circleName: 'Family' });
  await dad.joinWithInvite((await mom.createInvite()).link, { name: 'Dad' });
  await mom.refresh();
  await mom.sendChat('Secret group plans');

  await assert.rejects(() => dad.createAgentInvite({ name: 'Jarvis' }), /Only circle admins/);
  await assert.rejects(() => mom.createAgentInvite({ name: '/../' }), /Give the agent a name/);
  const { link } = await mom.createAgentInvite({ name: 'Jarvis' });
  assert.equal(app.store.db.prepare("SELECT wrapped FROM invites WHERE kind = 'agent'").get().wrapped, 'null');
  await dad.refresh();
  assert.deepEqual(dad.agentInvited, { name: 'Jarvis' });
  assert.equal(dad.agent, null);
  // A person can't join with it as themselves.
  await assert.rejects(() => client().joinWithInvite(link, { name: 'Eve' }));

  await agent.join(link);
  await sync();
  assert.deepEqual(dad.agent, { id: agent.memberId, name: 'Jarvis' });
  // It's not one of the people (polls, chirp all, the people list).
  assert.deepEqual(
    dad.memberList().map((m) => m.name),
    ['Dad', 'Mom'],
  );
  // One agent per circle.
  await assert.rejects(() => mom.createAgentInvite({ name: 'Second' }), (e) => e.code === 'agent_exists');
});

test('the agent can’t read the chat: it never even gets group messages', async () => {
  await mom.sendChat('More secret group plans');
  const got = await agent.fetchMessages();
  assert.deepEqual(got, []);
  const { messages } = await agent.api.messages(0, 500);
  assert.ok(messages.every((m) => m.to === agent.memberId || m.from === agent.memberId));
  // Nor anything else that's only for people.
  await assert.rejects(() => agent.api.locations(), (e) => e.status === 403);
  await assert.rejects(() => agent.api.places(), (e) => e.status === 403);
  await assert.rejects(() => agent.api.createInvite({}), (e) => e.status === 403);
});

test('a question in the group: everyone sees it, only the agent gets it sealed', async () => {
  const qid = await dad.askAgent('When are the kids free next?');
  await sync();
  assert.equal(mom.messages.find((m) => m.id === qid).body.text, '/Jarvis When are the kids free next?');
  // Dad's sealed copy for the agent isn't a conversation on his phone.
  assert.ok(!dad.messages.some((m) => m.body?.agentCopy));
  const [q] = await agent.fetchMessages();
  assert.equal(q.from, dad.account.memberId);
  assert.equal(q.body.ask, 'When are the kids free next?');
  assert.equal(q.body.thread, 'group');
  assert.equal(q.body.replyTo, qid);
  assert.deepEqual(q.body.people.map((p) => p.name).sort(), ['Dad', 'Mom']);

  // The agent answers each person; phones show it in the group.
  for (const p of agent.people()) await agent.send(p.id, { text: 'Nov 25–30 (Thanksgiving break).', thread: 'group', replyTo: qid });
  await sync();
  for (const c of [mom, dad]) {
    const a = c.conversation(null).at(-1);
    assert.equal(a.from, agent.memberId);
    assert.equal(a.body.text, 'Nov 25–30 (Thanksgiving break).');
  }
});

test('a direct chat with the agent stays between the two', async () => {
  await mom.askAgent('What did we decide about Tahoe?', { peer: mom.agent.id });
  const [q] = await agent.fetchMessages();
  assert.equal(q.body.thread, 'dm');
  await agent.send(mom.account.memberId, { text: 'Tahoe, Dec 20–24.', thread: 'dm' });
  await sync();
  assert.equal(mom.conversation(mom.agent.id).at(-1).body.text, 'Tahoe, Dec 20–24.');
  assert.ok(!dad.messages.some((m) => m.body?.text === 'Tahoe, Dec 20–24.'));
});

test('Remember sends just that one message, to circle or private memory', async () => {
  await dad.sendChat('Dentist for Kid on Nov 14 at 3:30');
  await sync();
  const m = mom.messages.find((x) => x.body?.text === 'Dentist for Kid on Nov 14 at 3:30');
  await mom.rememberWithAgent(m.id);
  const [r] = await agent.fetchMessages();
  assert.deepEqual(
    { ...r.body.remember, at: undefined },
    { text: 'Dentist for Kid on Nov 14 at 3:30', by: 'Dad', at: undefined, scope: 'circle' },
  );
});

test('the agent can only send direct messages', async () => {
  const { seal } = await import('../../packages/core/src/index.js');
  await assert.rejects(
    () =>
      agent.api.postMessage('agentgroupmsg1', seal({ kind: 'chat', from: agent.memberId, circle: agent.circleId, epoch: agent.epoch, key: 'A'.repeat(43), signSecret: agent.account.identity.signSecret, body: { text: 'hi' } })),
    (e) => e.status === 403,
  );
});

test('renaming and removing the agent; removing it needs no new circle key', async () => {
  await mom.setAgentName('Friday');
  await dad.refresh();
  assert.equal(dad.agent.name, 'Friday');
  const epoch = mom.account.epoch;
  await mom.removeAgent();
  await dad.refresh();
  assert.equal(dad.agent, null);
  assert.equal(dad.agentInvited, null);
  assert.equal(app.store.circle(mom.circleId).rotationNeeded, false);
  assert.equal(mom.account.epoch, epoch);
});

test('no unexpected client errors', () => {
  assert.deepEqual(
    errors.map((e) => e.message),
    [],
  );
});
