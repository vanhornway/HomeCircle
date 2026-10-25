// SOS from this phone: every circle on it gets the SOS, then this phone
// shares its exact location every minute until "I'm safe", and tells the
// circles when it reaches a safe place. Safe places (police, fire station,
// hospital, pharmacy, library, 24-hour grocery, the circles' own places) are
// looked up on the phone from OpenStreetMap; the server never sees them.
import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Location from 'expo-location';
import { distanceM } from '@homecircle/core';
import { loadedClients } from './circle';
import { diag } from './diagnostics';
import { freshFix, upload } from './location';

export const SOS_TASK = 'homecircle-sos';
const KEY = 'homecircle.sos';
// Public OpenStreetMap query servers, tried in turn (the main one is often busy).
const OVERPASS_URLS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const SEARCH_RADIUS_M = 3000;
// Close enough to count as "reached" a place without a radius of its own.
const ARRIVED_M = 75;

export type SafeKind = 'police' | 'fire' | 'hospital' | 'pharmacy' | 'library' | 'grocery' | 'circle';
export type SafePlace = { id: string; name: string; kind: SafeKind; lat: number; lng: number; radius: number };
export type MySos = {
  startedAt: number;
  ids: Record<string, string>;
  places: SafePlace[];
  // Whether the last lookup reached OpenStreetMap (if not, it's tried again on the next fix).
  placesOk?: boolean;
  reached: string[];
  at: { lat: number; lng: number } | null;
};

export const SAFE_EMOJI: Record<SafeKind, string> = { police: '🚓', fire: '🚒', hospital: '🏥', pharmacy: '💊', library: '📚', grocery: '🛒', circle: '📍' };
export const SAFE_KIND_NAME: Record<SafeKind, string> = {
  police: 'Police',
  fire: 'Fire station',
  hospital: 'Hospital',
  pharmacy: 'Pharmacy',
  library: 'Library',
  grocery: 'Open 24 hours',
  circle: 'Your circle’s place',
};

let current: MySos | null | undefined;
const listeners = new Set<() => void>();

async function save(next: MySos | null) {
  current = next;
  listeners.forEach((l) => l());
  if (next) await AsyncStorage.setItem(KEY, JSON.stringify(next));
  else await AsyncStorage.removeItem(KEY);
}

/** This phone's SOS, if one is on. */
export async function mySos(): Promise<MySos | null> {
  if (current === undefined) {
    try {
      current = JSON.parse((await AsyncStorage.getItem(KEY)) || 'null');
    } catch {
      current = null;
    }
    listeners.forEach((l) => l());
  }
  return current ?? null;
}

/** Live: this phone's SOS (null when none, undefined while loading). */
export function useMySos(): MySos | null | undefined {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      mySos().catch(() => {});
      return () => listeners.delete(l);
    },
    () => current,
  );
}

/** Send the SOS to every circle on this phone and start sharing every minute. */
export async function startMySos(): Promise<void> {
  // Already on: nothing to start (and its ids must not be replaced).
  if (await mySos()) return;
  const clients = await loadedClients();
  const ids: Record<string, string> = {};
  // Only circles that have SOS on.
  const sent = await Promise.allSettled(clients.filter((c) => c.feature('sos')).map(async (c) => (ids[c.circleId!] = await c.startSos())));
  if (!sent.some((r) => r.status === 'fulfilled')) throw (sent[0] as PromiseRejectedResult)?.reason ?? new Error('SOS is turned off in your circles');
  diag('sos:start', { circles: `${Object.keys(ids).length}/${clients.length}` });
  await save({ startedAt: Date.now(), ids, places: [], reached: [], at: null });
  await Location.startLocationUpdatesAsync(SOS_TASK, {
    accuracy: Location.Accuracy.High,
    timeInterval: 60_000,
    distanceInterval: 0,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'SOS is on',
      notificationBody: 'Sharing your exact location every minute until you tap I’m safe.',
      notificationColor: '#C2412D',
    },
  }).catch((e) => diag('sos:tracking-failed', { msg: String(e?.message ?? e).slice(0, 80) }));
  const fix = await freshFix(10_000);
  if (fix) await onSosFix(fix);
}

/** "I'm safe": tell every circle and stop sharing every minute. */
export async function endMySos(): Promise<void> {
  const sos = await mySos();
  if (!sos) return;
  const clients = await loadedClients();
  await Promise.allSettled(clients.filter((c) => sos.ids[c.circleId!]).map((c) => c.endSos(sos.ids[c.circleId!])));
  await Location.stopLocationUpdatesAsync(SOS_TASK).catch(() => {});
  diag('sos:end', {});
  await save(null);
}

/**
 * A position during an SOS: send it to every circle right away (exact, even
 * to circles you normally share an approximate location with), and say so
 * when it's at a safe place you hadn't reached yet.
 */
export async function onSosFix(loc: Location.LocationObject): Promise<void> {
  const sos = await mySos();
  if (!sos) return;
  const here = { lat: loc.coords.latitude, lng: loc.coords.longitude };
  await upload(loc, 'sos', { force: true, everyone: true }).catch((e) => diag('sos:upload-failed', { msg: String(e?.message ?? e).slice(0, 80) }));
  let places = sos.places;
  // Look safe places up again after moving more than a kilometre, or if the last try failed.
  if (!sos.placesOk || !sos.at || distanceM(sos.at, here) > 1000) {
    const found = await findSafePlaces(here).catch(() => null);
    if (found) places = found.places;
    await save({ ...sos, places, placesOk: !!found?.ok, at: here });
  }
  const reachedNow = places.find((p) => !sos.reached.includes(p.id) && distanceM(p, here) <= Math.max(ARRIVED_M, p.radius));
  if (!reachedNow) return;
  await save({ ...(current ?? sos), reached: [...sos.reached, reachedNow.id] });
  const clients = await loadedClients();
  await Promise.allSettled(clients.filter((c) => sos.ids[c.circleId!]).map((c) => c.sosArrived(sos.ids[c.circleId!], reachedNow.name)));
}

const KIND_OF: Record<string, SafeKind> = { police: 'police', fire_station: 'fire', hospital: 'hospital', pharmacy: 'pharmacy', library: 'library' };

/**
 * Safe places near a point, nearest first: OpenStreetMap plus the circles' own
 * places. `ok` says whether OpenStreetMap answered.
 */
export async function findSafePlaces(at: { lat: number; lng: number }): Promise<{ places: SafePlace[]; ok: boolean }> {
  const out: SafePlace[] = [];
  let ok = false;
  const query = `[out:json][timeout:20];(nwr(around:${SEARCH_RADIUS_M},${at.lat},${at.lng})[amenity~"^(police|fire_station|hospital|pharmacy|library)$"];nwr(around:${SEARCH_RADIUS_M},${at.lat},${at.lng})[shop~"^(supermarket|convenience)$"][opening_hours="24/7"];);out center 60;`;
  for (const url of OVERPASS_URLS) {
    if (ok) break;
    try {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 25_000);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': `HomeCircle/${Constants.expoConfig?.version ?? 'app'}` },
        body: `data=${encodeURIComponent(query)}`,
        signal: abort.signal,
      }).finally(() => clearTimeout(timer));
      if (res.ok) {
        const json = (await res.json()) as { elements?: { type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }[] };
        for (const e of json.elements ?? []) {
          const lat = e.lat ?? e.center?.lat;
          const lng = e.lon ?? e.center?.lon;
          if (lat == null || lng == null) continue;
          const kind = KIND_OF[e.tags?.amenity ?? ''] ?? (e.tags?.shop ? 'grocery' : null);
          if (!kind) continue;
          out.push({ id: `osm:${e.type}/${e.id}`, name: e.tags?.name || SAFE_KIND_NAME[kind], kind, lat, lng, radius: 0 });
        }
        ok = true;
      } else {
        diag('sos:places-failed', { url: url.split('/')[2], status: res.status });
      }
    } catch (e) {
      diag('sos:places-failed', { url: url.split('/')[2], msg: String((e as Error)?.message ?? e).slice(0, 80) });
    }
  }
  for (const c of await loadedClients()) {
    for (const p of c.places.values()) {
      if (distanceM(p, at) <= SEARCH_RADIUS_M * 2) out.push({ id: `circle:${p.id}`, name: p.name, kind: 'circle', lat: p.lat, lng: p.lng, radius: p.radius });
    }
  }
  const seen = new Set<string>();
  const places = out
    .sort((a, b) => distanceM(a, at) - distanceM(b, at))
    .filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)))
    .slice(0, 20);
  return { places, ok };
}
