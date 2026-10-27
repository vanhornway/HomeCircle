// Arriving at and leaving places, decided on this phone.
//
// The OS geofence is only a hint that something may have changed: every
// check uses an actual position, with a margin before counting someone as
// gone, so GPS drift at the edge of a place doesn't post false "left"
// messages. Regular location updates run the same check, which catches
// crossings the OS missed.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { distanceM, placeState, randomId, type CircleClient } from '@homecircle/core';
import { loadedClients } from './circle';
import { getSettings } from './storage';
import { diag } from './diagnostics';

const STATE_KEY = 'homecircle.geofenceEvents';
const OUTBOX_KEY = 'homecircle.placeOutbox';
const OUTBOX_MAX_AGE_MS = 7 * 86400_000;

/**
 * Arrivals and departures waiting to reach the server. Each keeps the id and
 * the time it was detected, so a retry after being offline posts it once,
 * with the original time (the server refuses a repeated id).
 */
type Pending = { id: string; circleId: string; body: { type: 'place'; action: 'arrived' | 'left'; placeId: string; placeName: string; at: number } };

async function readOutbox(): Promise<Pending[]> {
  try {
    return JSON.parse((await AsyncStorage.getItem(OUTBOX_KEY)) || '[]');
  } catch {
    return [];
  }
}

/** Send whatever is waiting. Called after every check and when the app opens. */
export async function flushOutbox(): Promise<number> {
  const pending = (await readOutbox()).filter((p) => Date.now() - p.body.at < OUTBOX_MAX_AGE_MS);
  if (!pending.length) return 0;
  const clients = await loadedClients();
  const left: Pending[] = [];
  for (const p of pending) {
    const client = clients.find((c) => c.circleId === p.circleId);
    if (!client) continue; // left that circle: drop it
    try {
      await client.sendEvent(p.body, { id: p.id });
      diag('place-sent', { action: p.body.action, place: p.body.placeName, delayS: Math.round((Date.now() - p.body.at) / 1000) });
    } catch (e) {
      left.push(p);
      diag('place-retry', { action: p.body.action, place: p.body.placeName, error: (e as Error).message?.slice(0, 80) });
    }
  }
  await AsyncStorage.setItem(OUTBOX_KEY, JSON.stringify(left));
  return pending.length - left.length;
}

/** The circles this phone shares its location with. */
export async function sharingClients(): Promise<CircleClient[]> {
  const settings = await getSettings();
  if (!settings.sharing) return [];
  return (await loadedClients()).filter((c) => !settings.pausedCircles.includes(c.circleId!) && c.feature('locationSharing'));
}

/**
 * A geofence id: "g:<group>" for a place added to several circles (watched
 * once), or "<circleId>:<placeId>" for a place in one circle.
 */
/** The geofence around a phone in still mode (lib/location.ts): leaving it means moving again. */
export const HERE_PREFIX = 'here:';

export function geofenceId(circleId: string, place: { id: string; group: string | null }) {
  return place.group ? `g:${place.group}` : `${circleId}:${place.id}`;
}

export type Fix = { lat: number; lng: number; accuracy: number | null };
export type PlaceCheck = {
  /** The place you're at, per circle id (for the "At Home" label). */
  placeIds: Record<string, string>;
  /** Whether you arrived somewhere or left somewhere just now. */
  changed: boolean;
  action: 'arrived' | 'left' | null;
};

type Region = { lat: number; lng: number; radius: number; targets: { client: CircleClient; placeId: string; name: string }[] };

const loaded = new WeakSet<CircleClient>();
let queue: Promise<unknown> = Promise.resolve();

/**
 * Compare a position with every place, record what changed and post
 * "arrived at" / "left" to each circle that has the place. `hint` is an OS
 * geofence report, used only when there's no position to check it against.
 * Checks run one at a time so the same crossing is never posted twice.
 */
export function checkPlaces(fix: Fix | null, hint?: { regionId: string; action: 'arrived' | 'left' }): Promise<PlaceCheck> {
  // "here:" is the circle around a still phone (still mode), not a place.
  if (hint?.regionId.startsWith(HERE_PREFIX)) hint = undefined;
  const run = queue.then(() => checkNow(fix, hint));
  queue = run.catch(() => {});
  return run;
}

async function checkNow(fix: Fix | null, hint?: { regionId: string; action: 'arrived' | 'left' }): Promise<PlaceCheck> {
  const settings = await getSettings();
  const clients = await sharingClients();
  // Background tasks start without places loaded.
  await Promise.all(
    clients.map(async (c) => {
      if (!loaded.has(c) && !c.places.size) await c.fetchPlaces().catch(() => {});
      loaded.add(c);
    }),
  );

  const regions = new Map<string, Region>();
  for (const client of clients) {
    for (const p of client.places.values()) {
      const id = geofenceId(client.circleId!, p);
      const r = regions.get(id) ?? { lat: p.lat, lng: p.lng, radius: p.radius, targets: [] };
      r.targets.push({ client, placeId: p.id, name: p.name });
      regions.set(id, r);
    }
  }

  let state: Record<string, { action: 'arrived' | 'left'; ts: number }> = {};
  try {
    state = JSON.parse((await AsyncStorage.getItem(STATE_KEY)) || '{}');
  } catch {
    state = {};
  }

  const placeIds: Record<string, string> = {};
  const posts: { regionId: string; client: CircleClient; placeId: string; name: string; action: 'arrived' | 'left' }[] = [];
  let lastAction: 'arrived' | 'left' | null = null;
  for (const [id, r] of regions) {
    let now: 'inside' | 'outside' | null = null;
    if (fix) now = placeState({ distance: distanceM(fix, r), accuracy: fix.accuracy, radius: r.radius });
    // No fix, or one too rough to tell: trust the OS report for that place.
    // In the background another position may not come for a long time, and
    // waiting for one is how departures went missing.
    const decidedBy = now ? 'fix' : 'os';
    if (!now && hint?.regionId === id) now = hint.action === 'arrived' ? 'inside' : 'outside';
    const inside = now ? now === 'inside' : state[id]?.action === 'arrived';
    if (inside) for (const t of r.targets) placeIds[t.client.circleId!] = t.placeId;
    if (!now) continue; // too close to the edge to tell: wait for the next position
    const action = now === 'inside' ? 'arrived' : 'left';
    const prev = state[id];
    if (prev?.action === action) continue;
    state[id] = { action, ts: Date.now() };
    if (!prev) continue; // first look at this place: just remember where we are
    lastAction = action;
    diag('place', {
      action,
      place: r.targets[0]?.name,
      by: hint?.regionId === id && decidedBy === 'os' ? 'os' : 'fix',
      distM: fix ? Math.round(distanceM(fix, r)) : undefined,
      accM: fix?.accuracy != null ? Math.round(fix.accuracy) : undefined,
      radiusM: Math.round(r.radius),
    });
    for (const t of r.targets) posts.push({ regionId: id, ...t, action });
  }
  await AsyncStorage.setItem(STATE_KEY, JSON.stringify(state));

  if (settings.announcePlaces && posts.length) {
    const at = Date.now();
    const outbox = await readOutbox();
    for (const p of posts) {
      outbox.push({ id: randomId(12), circleId: p.client.circleId!, body: { type: 'place', action: p.action, placeId: p.placeId, placeName: p.name || 'a place', at } });
    }
    await AsyncStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox));
  }
  await flushOutbox().catch(() => 0);
  return { placeIds, changed: posts.length > 0, action: lastAction };
}
