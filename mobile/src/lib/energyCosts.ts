// What HomeCircle's work costs in battery, per event. The one place these
// figures live (used by the on-phone estimate in lib/energy.ts, the location
// policy's daily budget, and its tests). Central estimates for a 5000 mAh
// Android phone, from the battery analysis; check them with docs/BATTERY-TEST.md.

// What a typical phone holds, for "% of the battery" (apps can't read the real
// capacity). 1% ≈ 50 mAh.
export const BATTERY_MAH = 5000;

/**
 * Energy per event, in mAh.
 * - balancedFix: a Wi-Fi scan plus cell lookup, with the CPU awake
 * - highFix: a short GPS fix (6–20 s), for Locate, geofences, charging
 * - task: about half a second of CPU to encrypt, store and check places
 * - uploadCell / uploadWifi: one small upload; on mobile data it's the radio
 *   waking up and staying on ~10 s that costs, not the bytes
 * - fetchCell / fetchWifi: fetching new messages after a push, the same way
 * - movingRequestPerHour: the 60-second balanced location request left
 *   running while the phone is still (Google doesn't say how much work it
 *   skips; this is the worst case in the analysis, 72 mAh a day)
 * - stillRequestPerHour: still mode's request, a Wi-Fi/cell check every 10 min
 */
export const COST_MAH = {
  balancedFix: 0.05,
  highFix: 0.3,
  task: 0.05,
  uploadCell: 0.4,
  uploadWifi: 0.05,
  fetchCell: 0.4,
  fetchWifi: 0.05,
  movingRequestPerHour: 3,
  // The request slowed to a check every 10 minutes in still mode.
  stillRequestPerHour: 0.3,
} as const;
