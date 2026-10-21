// Arriving at and leaving places, decided on this phone.
//
// The OS geofence is only a hint that something may have changed: every
// check uses an actual position, with a margin before counting someone as
// gone, so GPS drift at the edge of a place doesn't post false "left"
// messages. Regular location updates run the same check, which catches
// crossings the OS missed.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { distanceM, placeState, type CircleClient } from '@homecircle/core';
import { loadedClients } from './circle';
import { getSettings } from './storage';

const STATE_KEY = 'homecircle.geofenceEvents';

/** The circles this phone shares its location with. */
export async function sharingClients(): Promise<CircleClient[]> {
  const settings = await getSettings();
  if (!settings.sharing) return [];
  return (await loadedClients()).filter((c) => !settings.pausedCircles.includes(c.circleId!));
}

/**
 * A geofence id: "g:<group>" for a place added to several circles (watched
 * once), or "<circleId>:<placeId>" for a place in one circle.
 */
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
  const posts: { client: CircleClient; placeId: string; name: string; action: 'arrived' | 'left' }[] = [];
  let lastAction: 'arrived' | 'left' | null = null;
  for (const [id, r] of regions) {
    let now: 'inside' | 'outside' | null = null;
    if (fix) now = placeState({ distance: distanceM(fix, r), accuracy: fix.accuracy, radius: r.radius });
    else if (hint?.regionId === id) now = hint.action === 'arrived' ? 'inside' : 'outside';
    const inside = now ? now === 'inside' : state[id]?.action === 'arrived';
    if (inside) for (const t of r.targets) placeIds[t.client.circleId!] = t.placeId;
    if (!now) continue; // too close to the edge to tell: wait for the next position
    const action = now === 'inside' ? 'arrived' : 'left';
    const prev = state[id];
    if (prev?.action === action) continue;
    state[id] = { action, ts: Date.now() };
    if (!prev) continue; // first look at this place: just remember where we are
    lastAction = action;
    for (const t of r.targets) posts.push({ ...t, action });
  }
  await AsyncStorage.setItem(STATE_KEY, JSON.stringify(state));

  if (settings.announcePlaces && posts.length) {
    await Promise.allSettled(posts.map((p) => p.client.sendEvent({ type: 'place', action: p.action, placeId: p.placeId, placeName: p.name || 'a place' })));
  }
  return { placeIds, changed: posts.length > 0, action: lastAction };
}
