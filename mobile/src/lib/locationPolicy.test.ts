// The location policy, checked with plain Node:  node --test src/lib/locationPolicy.test.ts
// The main promise: at every stop, a hard day on battery stays within 5%.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BATTERY_MAH, COST_MAH } from './energyCosts.ts';
import { STOPS, SLOW_AFTER_MS, SLOW_STILL_INTERVAL_MS, effectiveLocationPolicy, stopForInterval, type LocationProfile, type LocationSettings, type PolicyInput, type Stop } from './locationPolicy.ts';

const settingsFor = (profile: LocationProfile, over: Partial<LocationSettings> = {}) => ({
  locationProfile: profile,
  location: { ...STOPS[profile === 'custom' ? 4 : profile], fullDetailCharging: true, saveWithBatterySaver: true, ...over },
});
const onBattery: PolicyInput = { charging: false, batterySaver: false, batteryLevel: 0.8, usedTodayMah: 0 };

/**
 * A hard day on battery, minute by minute, following the policy as the day's
 * use grows: 6 h of highway driving on a weak mobile signal (uploads cost
 * 1.5×), then 18 h still at work and home on mobile data; 30 chat push
 * wake-ups, 3 Locates and 4 place crossings. Returns mAh.
 */
function hardDay(profile: Stop) {
  const s = settingsFor(profile);
  const c = COST_MAH;
  let used = 0;
  let lastUpload = -Infinity;
  let stillSince = 0;
  for (let min = 0; min < 1440; min++) {
    const p = effectiveLocationPolicy(s, { ...onBattery, usedTodayMah: used });
    const driving = min < 360;
    if (driving) {
      // A fix a minute while moving (the 60 s request), with a wake to look at it.
      used += c.balancedFix + c.task;
      if (min - lastUpload >= p.movingGapMs / 60_000) {
        used += c.uploadCell * 1.5;
        lastUpload = min;
      }
      stillSince = min + 1;
      continue;
    }
    // Stopped: the final position goes right away.
    if (min === 360) {
      used += c.uploadCell + c.task;
      lastUpload = min;
    }
    const still = min - stillSince;
    // The 60 s request keeps running unless still mode slows it to every 10 min (after 10 min still).
    used += (p.stillMode && still >= 10 ? c.stillRequestPerHour : c.movingRequestPerHour) / 60;
    const interval = p.slowWhenStill && still * 60_000 >= SLOW_AFTER_MS ? Math.max(p.stillIntervalMs, SLOW_STILL_INTERVAL_MS) : p.stillIntervalMs;
    if ((min - lastUpload) * 60_000 >= interval) {
      used += c.task + c.balancedFix + c.uploadCell;
      lastUpload = min;
    }
  }
  // Other people's messages, Locates and places, the same at every stop.
  used += 30 * (c.task + c.fetchCell);
  used += 3 * (c.highFix + c.uploadCell + c.task);
  used += 4 * (c.highFix + c.uploadCell + c.task);
  return used;
}

test('every stop: a hard day (6 h highway + a day on mobile data) stays within 5% of the battery', () => {
  const rows = [];
  for (const stop of [1, 2, 3, 4, 5, 6] as Stop[]) {
    const mah = hardDay(stop);
    rows.push(`stop ${stop}: ${Math.round(mah)} mAh (${((mah / BATTERY_MAH) * 100).toFixed(1)}%)`);
    assert.ok(mah <= 0.05 * BATTERY_MAH, `stop ${stop} uses ${Math.round(mah)} mAh`);
  }
  console.log(rows.join('\n'));
});

test('the stops: less up to date means less often, and a smaller budget', () => {
  for (const s of [1, 2, 3, 4, 5] as Stop[]) {
    const a = STOPS[s];
    const b = STOPS[(s + 1) as Stop];
    assert.ok(a.movingGapMin >= b.movingGapMin && a.stillIntervalMin >= b.stillIntervalMin && a.budgetPct <= b.budgetPct);
  }
  assert.deepEqual(STOPS[4], { movingGapMin: 3, stillIntervalMin: 15, slowWhenStill: true, stillMode: true, budgetPct: 3 });
});

test('charging: full detail, GPS while moving, no budget; unless turned off', () => {
  const p = effectiveLocationPolicy(settingsFor(1), { ...onBattery, charging: true, usedTodayMah: 9999 });
  assert.equal(p.movingGapMs, 30_000);
  assert.equal(p.stillIntervalMs, 15 * 60_000);
  assert.equal(p.movingAccuracy, 'high');
  assert.equal(p.budgetMah, null);
  assert.equal(p.reason, 'charging');
  const off = effectiveLocationPolicy(settingsFor(1, { fullDetailCharging: false }), { ...onBattery, charging: true });
  assert.equal(off.movingGapMs, 15 * 60_000);
});

test('Battery Saver or under 20%: the longest-battery stop, unless turned off', () => {
  const saver = effectiveLocationPolicy(settingsFor(6), { ...onBattery, batterySaver: true });
  assert.equal(saver.movingGapMs, STOPS[1].movingGapMin * 60_000);
  assert.equal(saver.stillIntervalMs, STOPS[1].stillIntervalMin * 60_000);
  assert.equal(saver.stillMode, true);
  assert.equal(saver.reason, 'saver');
  const low = effectiveLocationPolicy(settingsFor(6), { ...onBattery, batteryLevel: 0.15 });
  assert.equal(low.reason, 'low');
  assert.equal(effectiveLocationPolicy(settingsFor(6, { saveWithBatterySaver: false }), { ...onBattery, batterySaver: true }).movingGapMs, 60_000);
  // Charging beats Battery Saver.
  assert.equal(effectiveLocationPolicy(settingsFor(6), { ...onBattery, batterySaver: true, charging: true }).reason, 'charging');
});

test('the budget: moving updates slow step by step near it (1 → 2 → 5 → 10 min), and say so', () => {
  const budget = 0.05 * BATTERY_MAH;
  const gap = (used: number) => effectiveLocationPolicy(settingsFor(6), { ...onBattery, usedTodayMah: used }).movingGapMs / 60_000;
  assert.equal(gap(0.5 * budget), 1);
  assert.equal(gap(0.6 * budget), 2);
  assert.equal(gap(0.75 * budget), 5);
  assert.equal(gap(0.9 * budget), 10);
  const p = effectiveLocationPolicy(settingsFor(6), { ...onBattery, usedTodayMah: 0.8 * budget });
  assert.equal(p.budgetLimited, true);
  assert.equal(p.reason, 'budget');
  // A stop already slower than the step isn't "limited".
  assert.equal(effectiveLocationPolicy(settingsFor(1), { ...onBattery, usedTodayMah: 0.01 * 0.6 * BATTERY_MAH }).budgetLimited, false);
});

test('custom values are used as they are', () => {
  const p = effectiveLocationPolicy({ locationProfile: 'custom', location: { movingGapMin: 7, stillIntervalMin: 45, slowWhenStill: false, stillMode: false, budgetPct: 2.5, fullDetailCharging: true, saveWithBatterySaver: true } }, onBattery);
  assert.equal(p.movingGapMs, 7 * 60_000);
  assert.equal(p.stillIntervalMs, 45 * 60_000);
  assert.equal(p.budgetMah, 125);
});

test('the old interval setting maps to a stop', () => {
  assert.deepEqual([5, 15, 30, 60].map(stopForInterval), [6, 5, 3, 1]);
});
