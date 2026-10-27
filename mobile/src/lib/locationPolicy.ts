// How often this phone shares its location, decided in one place. Everything
// that decides when to upload (upload(), the heartbeat, the background
// location request) asks effectiveLocationPolicy. No other constant does.
//
// The "Location updates" setting is a slider of six stops, from longest
// battery to most up to date, or custom values (Advanced). On top of it:
// - charging: full detail until unplugged (time on the charger costs nothing)
// - Battery Saver, or under 20% and not charging: the longest-battery stop
// - a daily battery budget: as the day's estimate nears it, moving updates
//   slow down step by step (charging starts it again)
// These never change with any of that: SOS, Locate, arrivals and departures,
// the 10% / 5% last updates, approximate and paused circles.
//
// No imports but types and the cost table, so it can be unit-tested with plain Node.
import { BATTERY_MAH } from './energyCosts.ts';

export type Stop = 1 | 2 | 3 | 4 | 5 | 6;
export type LocationProfile = Stop | 'custom';

/** The values a stop sets, and what Advanced lets you change. */
export type LocationValues = {
  // While moving: at most one upload every this many minutes.
  movingGapMin: number;
  // While still: an update every this many minutes (the heartbeat).
  stillIntervalMin: number;
  // After an hour within 100 m of the last update, the still updates slow to hourly.
  slowWhenStill: boolean;
  // After ~10 min without moving, stop asking for location; a ~250 m circle
  // around you wakes it again when you leave.
  stillMode: boolean;
  // At most this % of the battery a day (estimated); updates slow down near it.
  budgetPct: number;
};

export type LocationSettings = LocationValues & {
  // Full detail while charging.
  fullDetailCharging: boolean;
  // Use the longest-battery stop when Battery Saver is on or the battery is under 20%.
  saveWithBatterySaver: boolean;
};

export const STOP_NAMES: Record<Stop, string> = {
  1: 'Longest battery',
  2: 'Long battery',
  3: 'Battery first',
  4: 'Balanced',
  5: 'Up to date',
  6: 'Most up to date',
};
export const DEFAULT_STOP: Stop = 4;

export const STOPS: Record<Stop, LocationValues> = {
  1: { movingGapMin: 15, stillIntervalMin: 60, slowWhenStill: true, stillMode: true, budgetPct: 1 },
  2: { movingGapMin: 10, stillIntervalMin: 60, slowWhenStill: true, stillMode: true, budgetPct: 1.5 },
  3: { movingGapMin: 5, stillIntervalMin: 30, slowWhenStill: true, stillMode: true, budgetPct: 2 },
  4: { movingGapMin: 3, stillIntervalMin: 15, slowWhenStill: true, stillMode: true, budgetPct: 3 },
  5: { movingGapMin: 2, stillIntervalMin: 15, slowWhenStill: true, stillMode: true, budgetPct: 4 },
  6: { movingGapMin: 1, stillIntervalMin: 15, slowWhenStill: false, stillMode: false, budgetPct: 5 },
};

// While charging: as up to date as it gets.
const CHARGING = { movingGapMs: 30_000, stillIntervalMs: 15 * 60_000 };
// The heartbeat can't run more often than this (Android WorkManager).
export const MIN_STILL_INTERVAL_MS = 15 * 60_000;
// Still for this long within 100 m: the still updates slow down (if allowed).
export const SLOW_AFTER_MS = 60 * 60_000;
export const SLOW_STILL_INTERVAL_MS = 60 * 60_000;
// Near the budget, the moving gap grows: at 60%, 75% and 90% of it used.
const BUDGET_STEPS: [number, number][] = [
  [0.9, 10],
  [0.75, 5],
  [0.6, 2],
];
// From here, still mode and the hourly slow-down come on whatever the stop says.
const THRIFTY_AT = 0.75;
const LOW_BATTERY = 0.2;

export type PolicyInput = {
  charging: boolean;
  batterySaver: boolean;
  // 0..1, or null if unknown.
  batteryLevel: number | null;
  // Estimated mAh used on battery today (lib/energy.ts usedTodayMah).
  usedTodayMah: number;
};

export type Policy = {
  // What the slider says (or 'custom'), and the stop actually in force.
  stop: LocationProfile;
  movingGapMs: number;
  stillIntervalMs: number;
  // Slow the still updates after an hour in one place (to SLOW_STILL_INTERVAL_MS).
  slowWhenStill: boolean;
  stillMode: boolean;
  movingAccuracy: 'balanced' | 'high';
  // null while charging (no budget).
  budgetMah: number | null;
  // The budget is slowing moving updates right now.
  budgetLimited: boolean;
  // Why it differs from the slider right now, for the chips on the settings screen.
  reason: 'charging' | 'saver' | 'low' | 'budget' | null;
};

/** The values a profile stands for (a stop, or custom values). */
export function valuesFor(profile: LocationProfile, custom: LocationValues): LocationValues {
  return profile === 'custom' ? custom : STOPS[profile];
}

/** The stop for the old "update every N minutes" setting (5 → 6, 15 → 5, 30 → 3, 60 → 1). */
export function stopForInterval(min: number): Stop {
  return min <= 5 ? 6 : min <= 15 ? 5 : min <= 30 ? 3 : 1;
}

/** What to do right now, for these settings and this phone's state. */
export function effectiveLocationPolicy(settings: { locationProfile: LocationProfile; location: LocationSettings }, input: PolicyInput): Policy {
  const chosen = valuesFor(settings.locationProfile, settings.location);
  if (input.charging && settings.location.fullDetailCharging) {
    return {
      stop: settings.locationProfile,
      movingGapMs: CHARGING.movingGapMs,
      stillIntervalMs: CHARGING.stillIntervalMs,
      slowWhenStill: false,
      stillMode: false,
      movingAccuracy: 'high',
      budgetMah: null,
      budgetLimited: false,
      reason: 'charging',
    };
  }
  const low = !input.charging && input.batteryLevel != null && input.batteryLevel < LOW_BATTERY;
  const saving = settings.location.saveWithBatterySaver && (input.batterySaver || low);
  // Battery Saver or a low battery: no more often than the longest-battery stop.
  const v: LocationValues = saving
    ? {
        movingGapMin: Math.max(chosen.movingGapMin, STOPS[1].movingGapMin),
        stillIntervalMin: Math.max(chosen.stillIntervalMin, STOPS[1].stillIntervalMin),
        slowWhenStill: true,
        stillMode: true,
        budgetPct: Math.min(chosen.budgetPct, STOPS[1].budgetPct),
      }
    : chosen;
  const budgetMah = (v.budgetPct / 100) * BATTERY_MAH;
  const used = budgetMah > 0 ? input.usedTodayMah / budgetMah : 0;
  const step = BUDGET_STEPS.find(([at]) => used >= at);
  const movingGapMin = step ? Math.max(v.movingGapMin, step[1]) : v.movingGapMin;
  // From 75% of the budget, standing still costs as little as it can too.
  const thrifty = used >= THRIFTY_AT;
  const budgetLimited = movingGapMin > v.movingGapMin || (thrifty && (!v.stillMode || !v.slowWhenStill));
  return {
    stop: settings.locationProfile,
    movingGapMs: movingGapMin * 60_000,
    // Past the budget, still updates go hourly too.
    stillIntervalMs: Math.max(MIN_STILL_INTERVAL_MS, (used >= 1 ? Math.max(v.stillIntervalMin, 60) : v.stillIntervalMin) * 60_000),
    slowWhenStill: v.slowWhenStill || thrifty,
    stillMode: v.stillMode || thrifty,
    movingAccuracy: 'balanced',
    budgetMah,
    budgetLimited,
    reason: saving ? (input.batterySaver ? 'saver' : 'low') : budgetLimited ? 'budget' : null,
  };
}

/** "every 3 min while moving, every 15 min when still" (what the circle sees). */
export function describePolicy(p: { movingGapMs: number; stillIntervalMs: number }): string {
  const m = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3_600_000)} h`);
  return `every ${m(p.movingGapMs)} while moving, every ${m(p.stillIntervalMs)} when still`;
}
