// Battery-aware location sharing.
//
// - Background: the OS wakes us on movement (~250 m) and a background task
//   runs about every 15 minutes; we upload at most once per interval unless
//   the phone moved more than 500 m.
// - "Locate" requests from family: one fresh high-accuracy fix, uploaded now.
// - Places: OS geofences (cheap, work when the app is closed on iOS).
import * as Location from 'expo-location';
import * as Battery from 'expo-battery';
import * as BackgroundTask from 'expo-background-task';
import type { CircleClient } from '@homecircle/core';
import { loadedClients } from './circle';
import { getSettings, getLastUpload, setLastUpload } from './storage';

export const LOCATION_TASK = 'homecircle-location';
export const GEOFENCE_TASK = 'homecircle-geofence';
export const HEARTBEAT_TASK = 'homecircle-heartbeat';
export const PUSH_TASK = 'homecircle-push';

const MOVE_THRESHOLD_M = 500;
const MAX_GEOFENCES = 20; // iOS limit per app

export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

async function batteryInfo() {
  try {
    const [level, state] = await Promise.all([Battery.getBatteryLevelAsync(), Battery.getBatteryStateAsync()]);
    return {
      battery: level >= 0 ? level : null,
      charging: state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL,
    };
  } catch {
    return { battery: null, charging: false };
  }
}

/** The circles this phone shares its location with. */
export async function sharingClients(): Promise<CircleClient[]> {
  const settings = await getSettings();
  if (!settings.sharing) return [];
  return (await loadedClients()).filter((c) => !settings.pausedCircles.includes(c.circleId!));
}

/**
 * Encrypt and upload a location to each circle if it's due (interval passed
 * or moved far), or always when `force` is set. Each circle gets its own copy,
 * sealed with that circle's key. Returns true if any circle got it.
 * `placeIds` says which place you're at, per circle id.
 */
export async function upload(
  loc: Location.LocationObject,
  trigger: string,
  { force = false, placeIds = {} }: { force?: boolean; placeIds?: Record<string, string> } = {},
): Promise<boolean> {
  const settings = await getSettings();
  const targets = await sharingClients();
  if (!targets.length) return false;
  const here = { lat: loc.coords.latitude, lng: loc.coords.longitude };
  const last = await getLastUpload();
  const intervalMs = settings.intervalMinutes * 60_000;
  const due =
    force ||
    !last ||
    Date.now() - last.ts >= intervalMs - 30_000 ||
    distanceM(last, here) > MOVE_THRESHOLD_M;
  if (!due) return false;
  const battery = await batteryInfo();
  const results = await Promise.allSettled(
    targets.map((client) =>
      client.shareLocation({
        ...here,
        accuracy: loc.coords.accuracy,
        speed: loc.coords.speed,
        ...battery,
        trigger,
        placeId: placeIds[client.circleId!] ?? null,
        ts: loc.timestamp,
      }),
    ),
  );
  if (!results.some((r) => r.status === 'fulfilled')) throw (results[0] as PromiseRejectedResult).reason;
  await setLastUpload({ ts: Date.now(), ...here });
  return true;
}

/** A fresh fix, falling back to the last known one if GPS is slow. */
export async function freshFix(timeoutMs = 20_000): Promise<Location.LocationObject | null> {
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), timeoutMs));
  try {
    const fix = await Promise.race([Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High, mayShowUserSettingsDialog: false }), timeout]);
    if (fix) return fix;
  } catch {
    /* fall through */
  }
  return Location.getLastKnownPositionAsync({ maxAge: 10 * 60_000 }).catch(() => null);
}

/**
 * Someone asked where we are, or the user tapped "share now". Opening the app
 * only uploads if it's due, unless a circle doesn't have our location yet
 * (e.g. one we just joined or turned sharing back on for).
 */
export async function shareNow(trigger: 'requested' | 'manual' | 'open' = 'manual'): Promise<boolean> {
  const { status } = await Location.getForegroundPermissionsAsync();
  if (status !== 'granted') return false;
  const missing = (await sharingClients()).some((c) => c.account && !c.locations.has(c.account.memberId));
  const fix = await freshFix();
  return fix ? upload(fix, trigger, { force: trigger !== 'open' || missing }) : false;
}

export type SharingMode = 'off' | 'no-permission' | 'foreground-only' | 'background';

/** (Re)start background updates using the current settings. */
export async function startBackgroundUpdates(): Promise<SharingMode> {
  const settings = await getSettings();
  if (!settings.sharing) {
    await stopBackgroundUpdates();
    return 'off';
  }
  const fg = await Location.getForegroundPermissionsAsync();
  if (fg.status !== 'granted') return 'no-permission';
  const bg = await Location.getBackgroundPermissionsAsync();
  if (bg.status !== 'granted') return 'foreground-only';

  const intervalMs = settings.intervalMinutes * 60_000;
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false)) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  }
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.Balanced,
    // Never prompt users to turn on Google's "Location Accuracy" (it shares
    // Wi-Fi/sensor data with Google). GPS and network location work without it.
    mayShowUserSettingsDialog: false,
    distanceInterval: 250,
    timeInterval: intervalMs, // Android
    deferredUpdatesInterval: intervalMs,
    deferredUpdatesDistance: MOVE_THRESHOLD_M,
    activityType: Location.ActivityType.Other,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: false,
    foregroundService: {
      notificationTitle: 'HomeCircle',
      notificationBody: 'Sharing your location privately with your circle',
      notificationColor: '#2F7D6D',
    },
  });
  try {
    await BackgroundTask.registerTaskAsync(HEARTBEAT_TASK, { minimumInterval: Math.max(15, settings.intervalMinutes) });
  } catch {
    /* unavailable (e.g. simulator) */
  }
  return 'background';
}

export async function stopBackgroundUpdates() {
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false)) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  }
  await BackgroundTask.unregisterTaskAsync(HEARTBEAT_TASK).catch(() => {});
  if (await Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => false)) {
    await Location.stopGeofencingAsync(GEOFENCE_TASK);
  }
}

/**
 * A geofence id: "g:<group>" for a place added to several circles (watched
 * once), or "<circleId>:<placeId>" for a place in one circle.
 */
export function geofenceId(circleId: string, place: { id: string; group: string | null }) {
  return place.group ? `g:${place.group}` : `${circleId}:${place.id}`;
}

/** The circles (and their place ids) a geofence belongs to. */
export function placesForGeofence(id: string, clients: CircleClient[]): { client: CircleClient; placeId: string }[] {
  if (id.startsWith('g:')) {
    const group = id.slice(2);
    return clients.flatMap((client) => [...client.places.values()].filter((p) => p.group === group).map((p) => ({ client, placeId: p.id })));
  }
  const i = id.indexOf(':');
  // Before circles had ids in geofences, the id was just the place id.
  if (i < 0) return clients.slice(0, 1).map((client) => ({ client, placeId: id }));
  const client = clients.find((c) => c.circleId === id.slice(0, i));
  return client ? [{ client, placeId: id.slice(i + 1) }] : [];
}

/** Register the places of every circle you share with as OS geofences. */
export async function syncGeofences() {
  const settings = await getSettings();
  const bg = await Location.getBackgroundPermissionsAsync().catch(() => null);
  const clients = await sharingClients();
  const unique = new Map<string, { identifier: string; lat: number; lng: number; radius: number }>();
  for (const c of clients) {
    for (const p of c.places.values()) {
      const identifier = geofenceId(c.circleId!, p);
      if (!unique.has(identifier)) unique.set(identifier, { identifier, lat: p.lat, lng: p.lng, radius: p.radius });
    }
  }
  const places = [...unique.values()];
  const regions = places.slice(0, MAX_GEOFENCES).map((p) => ({
    identifier: p.identifier,
    latitude: p.lat,
    longitude: p.lng,
    radius: Math.max(100, p.radius),
    notifyOnEnter: true,
    notifyOnExit: true,
  }));
  const started = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => false);
  if (!settings.sharing || bg?.status !== 'granted' || !regions.length) {
    if (started) await Location.stopGeofencingAsync(GEOFENCE_TASK);
    return;
  }
  await Location.startGeofencingAsync(GEOFENCE_TASK, regions);
}
