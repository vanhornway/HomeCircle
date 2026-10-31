import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LATE_MS, pickSkin, profileOf, profilePatch, skinStatus } from './profile.ts';

test('a member record is a profile: full, care circle or grandkids', () => {
  assert.equal(profileOf(null), 'full');
  assert.equal(profileOf({ skin: 'full', page: 'grandkids' }), 'full');
  assert.equal(profileOf({ skin: 'elderly' }), 'care');
  assert.equal(profileOf({ skin: 'elderly', page: 'care' }), 'care');
  assert.equal(profileOf({ skin: 'elderly', page: 'grandkids' }), 'grandkids');
});

test('switching in any order: each profile is saved and read back as itself', () => {
  let rec: { skin?: string; page?: string } = {};
  for (const p of ['care', 'full', 'grandkids', 'care', 'full', 'grandkids', 'full'] as const) {
    rec = { ...rec, ...profilePatch(p) };
    assert.equal(profileOf(rec), p);
  }
  // Going back to full keeps the page it had, so the next elder switch doesn't lose it.
  assert.equal(profilePatch('full').page, undefined);
});

test('the most restricted skin across circles wins', () => {
  const locked = (s: string) => s === 'elderly';
  assert.equal(pickSkin(['full', 'elderly'], locked), 'elderly');
  assert.equal(pickSkin(['full', 'full'], locked), 'full');
  assert.equal(pickSkin([], locked), null);
});

test('the admin sees waiting, then updated, and late when it takes too long', () => {
  const t0 = 1_000_000;
  const rec = { skin: 'elderly', page: 'grandkids', ts: t0 };
  assert.equal(skinStatus(null, null, 'Nani').state, 'none');
  assert.equal(skinStatus(rec, null, 'Nani', t0 + 5).state, 'unknown');
  // Last seen before the change, showing the old profile.
  assert.equal(skinStatus(rec, { skin: 'full', ts: t0 - 60_000 }, 'Nani', t0 + 5_000).state, 'waiting');
  assert.equal(skinStatus(rec, { skin: 'full', ts: t0 - 60_000 }, 'Nani', t0 + 5_000).text, 'Waiting for Nani’s phone…');
  // It followed the skin but not yet the page.
  assert.equal(skinStatus(rec, { skin: 'elderly', page: 'care', ts: t0 + 1_000 }, 'Nani', t0 + 5_000).state, 'waiting');
  // Reported after the change, showing it.
  assert.equal(skinStatus(rec, { skin: 'elderly', page: 'grandkids', ts: t0 + 1_000 }, 'Nani', t0 + 5_000).state, 'updated');
  // A report from before the change can't confirm it, even if it happens to match.
  assert.equal(skinStatus({ skin: 'full', ts: t0 }, { skin: 'full', ts: t0 - 1 }, 'Nani', t0 + 5_000).state, 'waiting');
  // An older app reports no skin: never "updated", and "late" once it's been a while.
  assert.equal(skinStatus(rec, { ts: t0 + 1_000 }, 'Nani', t0 + 5_000).state, 'waiting');
  assert.equal(skinStatus(rec, { skin: 'full', ts: t0 - 1 }, 'Nani', t0 + LATE_MS + 1).state, 'late');
});
