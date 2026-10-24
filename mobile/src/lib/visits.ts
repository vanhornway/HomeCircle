// Most visited places. The phone keeps its own history of stays (10+ minutes
// in one spot) for 30 days, encrypted on the phone, and turns it into a short
// list: where you spend the most time and go most often, with a first guess
// at what each place is (see visitsCore.ts). Only that list is shared, sealed
// for your circles; the history itself never leaves the phone. You can rename
// or hide any place, or stop sharing them (Settings → Most visited places).
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as SecureStore from 'expo-secure-store';
import nacl from 'tweetnacl';
import { fromB64, toB64, utf8Decode, utf8Encode, type CircleClient, type FrequentKind } from '@homecircle/core';
import { diag } from './diagnostics';
import { getSettings } from './storage';
import { addFix, classify, emptyData, KIND_NAMES, labelFor, nameClusters, topClusters, type Label, type MyPlace, type VisitData } from './visitsCore';

export type { MyPlace } from './visitsCore';

const DATA_KEY = 'homecircle.visits';
const KEY_NAME = 'homecircle.visitsKey';
const SHARED_KEY = 'homecircle.visitsSharedAt';
const SHARE_EVERY_MS = 6 * 3600_000;

// --- encrypted storage (same scheme as diagnostics) --------------------------

let keyPromise: Promise<Uint8Array> | null = null;
function dataKey(): Promise<Uint8Array> {
  if (!keyPromise) {
    keyPromise = (async () => {
      const opts = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
      const saved = await SecureStore.getItemAsync(KEY_NAME, opts);
      if (saved) return fromB64(saved);
      const k = nacl.randomBytes(32);
      await SecureStore.setItemAsync(KEY_NAME, toB64(k), opts);
      return k;
    })().catch((e) => {
      keyPromise = null;
      throw e;
    });
  }
  return keyPromise;
}

async function read(): Promise<VisitData> {
  try {
    const raw = await AsyncStorage.getItem(DATA_KEY);
    if (!raw) return emptyData();
    const { n, c } = JSON.parse(raw);
    const plain = nacl.secretbox.open(fromB64(c), fromB64(n), await dataKey());
    return plain ? JSON.parse(utf8Decode(plain)) : emptyData();
  } catch {
    return emptyData();
  }
}

async function write(d: VisitData) {
  const n = nacl.randomBytes(24);
  const c = nacl.secretbox(utf8Encode(JSON.stringify(d)), n, await dataKey());
  await AsyncStorage.setItem(DATA_KEY, JSON.stringify({ n: toB64(n), c: toB64(c) }));
}

// Writes are queued: background tasks can record fixes at the same time.
let queue: Promise<unknown> = Promise.resolve();
function update<T>(fn: (d: VisitData) => T | Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const d = await read();
    const r = await fn(d);
    await write(d);
    return r;
  });
  queue = run.catch(() => {});
  return run;
}

/** Note one location fix. Called for every fix the app takes anyway. */
export function recordFix(lat: number, lng: number, accuracy: number | null, ts = Date.now()) {
  return update((d) => addFix(d, lat, lng, accuracy, ts));
}

/** Best guess at a place's name and kind from the phone's map lookup (Google's geocoder on Android). */
async function lookUp(lat: number, lng: number): Promise<{ name: string; kind: FrequentKind } | null> {
  try {
    const [a] = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lng });
    return a ? classify(a) : null;
  } catch {
    return null;
  }
}

/**
 * Your most visited places over the last 30 days, best first, named. Looks up
 * names it doesn't have yet and remembers them.
 */
export async function myPlaces({ lookUpNames = true } = {}): Promise<MyPlace[]> {
  const d = await read();
  const clusters = topClusters(d, Date.now());
  const found: Label[] = [];
  if (lookUpNames) {
    for (const c of clusters) {
      if (labelFor(d.labels, c)?.auto) continue;
      const auto = await lookUp(c.lat, c.lng);
      if (auto) found.push({ lat: c.lat, lng: c.lng, auto });
    }
  }
  if (found.length) {
    await update((x) => {
      for (const f of found) {
        const existing = labelFor(x.labels, f);
        if (existing) existing.auto = f.auto;
        else x.labels.push(f);
      }
    });
    for (const f of found) {
      const existing = labelFor(d.labels, f);
      if (existing) existing.auto = f.auto;
      else d.labels.push(f);
    }
  }
  return nameClusters(clusters, d.labels);
}

/** Rename a place (or go back to the guess with null), or hide/show it. */
export function editPlace(p: { lat: number; lng: number }, change: { name?: string | null; hidden?: boolean }) {
  return update((d) => {
    let label = labelFor(d.labels, p);
    if (!label) d.labels.push((label = { lat: p.lat, lng: p.lng }));
    if (change.name !== undefined) label.name = change.name?.trim().slice(0, 40) || undefined;
    if (change.hidden !== undefined) label.hidden = change.hidden;
  });
}

/** Forget the whole history (Settings). */
export async function clearVisits() {
  await AsyncStorage.multiRemove([DATA_KEY, SHARED_KEY]);
}

export const kindName = (k: FrequentKind) => KIND_NAMES[k];
export const KIND_EMOJI: Record<FrequentKind, string> = {
  home: '🏠',
  work: '💼',
  school: '🎒',
  shopping: '🛒',
  grocery: '🥦',
  gas: '⛽',
  food: '☕',
  gym: '🏋️',
  health: '🩺',
  worship: '🕊️',
  park: '🌳',
  other: '📍',
};

/**
 * Share your most visited places with the circles that see your exact
 * location (and withdraw them from the others), at most every 6 hours unless
 * `force`. Hidden places are never shared.
 */
export async function shareMyPlaces(clients: CircleClient[], { force = false } = {}) {
  const last = Number((await AsyncStorage.getItem(SHARED_KEY)) || 0);
  if (!force && Date.now() - last < SHARE_EVERY_MS) return;
  const settings = await getSettings();
  const visible = (await myPlaces()).filter((p) => !p.hidden);
  const shareTo = (c: CircleClient) =>
    settings.shareFrequent && settings.sharing && !settings.pausedCircles.includes(c.circleId!) && !settings.approximateCircles.includes(c.circleId!);
  const results = await Promise.allSettled(
    clients.filter((c) => c.account).map((c) => (shareTo(c) && visible.length ? c.shareFrequent(visible) : c.clearFrequent())),
  );
  await AsyncStorage.setItem(SHARED_KEY, String(Date.now()));
  diag('frequent:share', { places: visible.length, circles: results.filter((r) => r.status === 'fulfilled').length });
}
