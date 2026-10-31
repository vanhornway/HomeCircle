// Run with plain Node:  node --test src/lib/notifyPlan.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVE_FRESH_MS, STALE_MS, groupIdentifier, isFresh, planNotifications } from './notifyPlan.ts';

const NOW = 1_000_000_000_000;
let n = 0;
const msg = (ageMs: number, peer: string | null = null) => ({ id: `m${++n}`, seq: n, ts: NOW - ageMs, peer });

test('a burst in one conversation becomes one notification for the latest message', () => {
  const batch = [msg(10_000), msg(8_000), msg(6_000), msg(4_000), msg(2_000), msg(1_000)];
  const groups = planNotifications(batch, 'c1', NOW, false);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].messages.length, 6);
  assert.equal(groups[0].latest.id, batch[5].id);
  assert.equal(groups[0].identifier, 'chat:c1:group');
  assert.equal(groups[0].loud, true);
});

test('each conversation has its own notification, and only the newest one sounds', () => {
  const a = msg(20_000, 'sam');
  const b = msg(15_000);
  const c = msg(5_000, 'lee');
  const groups = planNotifications([a, b, c], 'c1', NOW, false);
  assert.deepEqual(groups.map((g) => g.peer), ['lee', null, 'sam']);
  assert.deepEqual(groups.map((g) => g.loud), [true, false, false]);
  assert.equal(new Set(groups.map((g) => g.identifier)).size, 3);
});

test('messages minutes old are listed quietly, not sounded', () => {
  const groups = planNotifications([msg(STALE_MS + 1_000), msg(STALE_MS + 2_000, 'sam')], 'c1', NOW, false);
  assert.ok(groups.every((g) => !g.loud));
  // But a held-back push that is only a minute late still sounds.
  assert.equal(planNotifications([msg(60_000)], 'c1', NOW, false)[0].loud, true);
});

test('with the app open, only a live message sounds; history catching up is quiet', () => {
  assert.equal(planNotifications([msg(ACTIVE_FRESH_MS - 1_000)], 'c1', NOW, true)[0].loud, true);
  assert.equal(planNotifications([msg(ACTIVE_FRESH_MS + 1_000)], 'c1', NOW, true)[0].loud, false);
});

test('the loud one is the newest conversation that has something fresh', () => {
  const old = msg(STALE_MS * 2, 'sam');
  const fresh = msg(3_000);
  const groups = planNotifications([old, fresh], 'c1', NOW, false);
  assert.equal(groups.find((g) => g.loud)?.peer, null);
  // A stale conversation with the newest seq doesn't keep a fresh one quiet.
  const staleNewest = { ...msg(STALE_MS * 3, 'lee'), seq: 999 };
  const groups2 = planNotifications([fresh, staleNewest], 'c1', NOW, false);
  assert.equal(groups2[0].peer, 'lee');
  assert.deepEqual(groups2.map((g) => g.loud), [false, true]);
});

test('same ids across circles do not collide, a clock ahead counts as fresh, nothing in nothing out', () => {
  assert.notEqual(groupIdentifier('c1', null), groupIdentifier('c2', null));
  assert.notEqual(groupIdentifier('c1', 'sam'), groupIdentifier('c1', null));
  assert.equal(isFresh(NOW + 5_000, NOW, true), true);
  assert.deepEqual(planNotifications([], 'c1', NOW, false), []);
});
