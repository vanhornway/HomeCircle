// Run with plain Node:  node --test src/lib/pushTiming.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushTiming, pushTimingLines } from './pushTiming.ts';

const wake = (t: number, lagS?: number, type = 'message') => ({ t, e: 'wake:push', d: { type, ...(lagS === undefined ? {} : { lagS }) } });

test('lags are summarised, and a late push is counted', () => {
  const p = pushTiming([wake(1000, 2), wake(900_000, 3), wake(2_000_000, 1500), wake(3_000_000, 4), wake(4_000_000, undefined)]);
  assert.equal(p.wakes, 5);
  assert.equal(p.measured, 4);
  assert.equal(p.medianLagS, 3);
  assert.equal(p.maxLagS, 1500);
  assert.equal(p.late, 1);
});

test('three wake-ups within seconds are a burst; spaced out ones are not', () => {
  const burst = pushTiming([wake(1_000, 300), wake(2_000, 300), wake(5_000, 300), wake(500_000, 1), wake(900_000, 1)]);
  assert.equal(burst.bursts, 1);
  assert.equal(pushTiming([wake(1_000), wake(2_000), wake(600_000)]).bursts, 0);
});

test('other wake-ups are ignored, and the time to a notification is taken from push:shown', () => {
  const p = pushTiming([wake(1, 1, 'locate'), wake(2, 1, 'chirp'), { t: 3, e: 'push:shown', d: { tookMs: 2400 } }, { t: 4, e: 'push:shown', d: { tookMs: 3000 } }, { t: 5, e: 'push:backup-cleared' }]);
  assert.equal(p.wakes, 0);
  assert.equal(p.shown, 2);
  assert.equal(p.medianTookS, 2.4);
  assert.equal(p.backupCleared, 1);
  assert.deepEqual(pushTimingLines([]), []);
});

test('the lines read plainly', () => {
  const lines = pushTimingLines([wake(1_000, 5), wake(2_000, 7_200), { t: 3_000, e: 'push:shown', d: { tookMs: 1800 } }]);
  assert.match(lines.join('\n'), /2 woke the app, 1 shown/);
  assert.match(lines.join('\n'), /slowest 2 h/);
  assert.match(lines.join('\n'), /1 arrived more than a minute late/);
});

test('pushes Android lowered from high to normal are counted', () => {
  const lowered = (t: number) => ({ t, e: 'wake:push', d: { type: 'message', prio: 'normal', sent: 'high' } });
  const p = pushTiming([lowered(1), lowered(100_000), { t: 200_000, e: 'wake:push', d: { type: 'message', prio: 'high', sent: 'high' } }]);
  assert.equal(p.downgraded, 2);
  assert.match(pushTimingLines([lowered(1)]).join('\n'), /1 of 1 were delivered at normal priority/);
});
