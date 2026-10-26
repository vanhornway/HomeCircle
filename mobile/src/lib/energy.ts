// How much battery HomeCircle uses, estimated on the phone: it counts what
// costs power (wake-ups, location fixes, uploads and fetches, on mobile data
// or Wi-Fi) per day and since the phone was last unplugged, and turns the
// counts into mAh with the per-event costs below. Shown in Diagnostics, and
// read by the location policy for the daily battery budget. Stays on the phone.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Network from 'expo-network';

const KEY = 'homecircle.energy';
const KEEP_DAYS = 14;
// What a typical phone holds, for "% of the battery" (apps can't read the real
// capacity). 1% ≈ 50 mAh.
export const BATTERY_MAH = 5000;

/**
 * Energy per event, in mAh (central estimates from the battery analysis, for a
 * 5000 mAh Android phone). The one place these figures live.
 * - balancedFix: a Wi-Fi scan plus cell lookup, with the CPU awake
 * - highFix: a short GPS fix (6–20 s), for Locate, geofences, the heartbeat
 * - task: about half a second of CPU to encrypt, store and check places
 * - uploadCell / uploadWifi: one small upload; on mobile data it's the radio
 *   waking up and staying on ~10 s that costs, not the bytes
 * - fetchCell / fetchWifi: fetching new messages after a push, the same way
 */
export const COST_MAH = {
  balancedFix: 0.05,
  highFix: 0.3,
  task: 0.05,
  uploadCell: 0.4,
  uploadWifi: 0.05,
  fetchCell: 0.4,
  fetchWifi: 0.05,
} as const;

export type Net = 'cell' | 'wifi' | 'other';
export type Counts = {
  // Wake-ups by kind: movement, heartbeat, push, geofence, sos.
  wakes: Record<string, number>;
  fixes: number;
  highFixes: number;
  uploads: Record<Net, number>;
  fetches: Record<Net, number>;
  mah: number;
  // The part of `mah` used while not on the charger.
  onBattery: number;
};
type Store = { days: Record<string, Counts>; unplugged: Counts & { since: number }; charging: boolean };

const empty = (): Counts => ({ wakes: {}, fixes: 0, highFixes: 0, uploads: { cell: 0, wifi: 0, other: 0 }, fetches: { cell: 0, wifi: 0, other: 0 }, mah: 0, onBattery: 0 });
const day = (t = Date.now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

let cached: Store | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function load(): Promise<Store> {
  if (cached) return cached;
  try {
    const raw = JSON.parse((await AsyncStorage.getItem(KEY)) || 'null');
    if (raw?.days && raw.unplugged) cached = raw as Store;
  } catch {
    // start again
  }
  cached ??= { days: {}, unplugged: { ...empty(), since: Date.now() }, charging: false };
  return cached;
}

/** Change the counts one at a time (background tasks can run together). Never throws. */
function update(fn: (s: Store) => void): Promise<void> {
  const run = queue.then(async () => {
    const s = await load();
    fn(s);
    const keep = Object.keys(s.days).sort().slice(-KEEP_DAYS);
    s.days = Object.fromEntries(keep.map((k) => [k, s.days[k]]));
    await AsyncStorage.setItem(KEY, JSON.stringify(s));
  });
  queue = run.catch(() => {});
  return run.catch(() => {});
}

/** What one event costs, in mAh. */
export function costOf(kind: 'wake' | 'fix' | 'highFix' | 'upload' | 'fetch', net: Net = 'other', n = 1): number {
  const c = COST_MAH;
  const each =
    kind === 'wake' ? c.task : kind === 'fix' ? c.balancedFix : kind === 'highFix' ? c.highFix : kind === 'upload' ? (net === 'wifi' ? c.uploadWifi : c.uploadCell) : net === 'wifi' ? c.fetchWifi : c.fetchCell;
  return each * n;
}

function add(s: Store, mah: number, change: (c: Counts) => void) {
  const today = (s.days[day()] ??= empty());
  change(today);
  today.mah += mah;
  // Time on the charger doesn't count against the battery.
  if (!s.charging) {
    today.onBattery += mah;
    change(s.unplugged);
    s.unplugged.mah += mah;
    s.unplugged.onBattery += mah;
  }
}

/** Mobile data or Wi-Fi right now (what an upload's cost depends on). */
export async function currentNet(): Promise<Net> {
  try {
    const st = await Network.getNetworkStateAsync();
    return st.type === Network.NetworkStateType.WIFI || st.type === Network.NetworkStateType.ETHERNET ? 'wifi' : st.type === Network.NetworkStateType.CELLULAR ? 'cell' : 'other';
  } catch {
    return 'other';
  }
}

export const countWake = (kind: string) =>
  update((s) =>
    add(s, costOf('wake'), (c) => {
      c.wakes[kind] = (c.wakes[kind] ?? 0) + 1;
    }),
  );
export const countFixes = (n: number, { high = false } = {}) =>
  n > 0
    ? update((s) =>
        add(s, costOf(high ? 'highFix' : 'fix', 'other', n), (c) => {
          if (high) c.highFixes += n;
          else c.fixes += n;
        }),
      )
    : Promise.resolve();
export const countUpload = (net: Net) =>
  update((s) =>
    add(s, costOf('upload', net), (c) => {
      c.uploads[net] += 1;
    }),
  );
export const countFetch = (net: Net) =>
  update((s) =>
    add(s, costOf('fetch', net), (c) => {
      c.fetches[net] += 1;
    }),
  );

/** On the charger or not: unplugging starts "since unplugged" again. */
export const noteCharging = (charging: boolean) =>
  update((s) => {
    if (s.charging && !charging) s.unplugged = { ...empty(), since: Date.now() };
    s.charging = charging;
  });

/**
 * mAh used on battery for the daily budget: since midnight, and since the
 * phone was last unplugged, whichever is less (charging starts it again).
 */
export async function usedTodayMah(): Promise<number> {
  await queue;
  const s = await load();
  return Math.min(s.days[day()]?.onBattery ?? 0, s.unplugged.mah);
}

/** Everything, for Diagnostics. */
export async function energyReport(): Promise<{ today: Counts; unplugged: Counts & { since: number }; days: Record<string, Counts>; charging: boolean }> {
  await queue;
  const s = await load();
  return { today: s.days[day()] ?? empty(), unplugged: s.unplugged, days: s.days, charging: s.charging };
}

/** "37 mAh (0.7%)". */
export const formatMah = (mah: number) => `${Math.round(mah)} mAh (${Math.round((mah / BATTERY_MAH) * 1000) / 10}%)`;
