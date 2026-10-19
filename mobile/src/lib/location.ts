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
import type { Place } from '@homecircle/core';
import { loadedClient } from './circle';
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

/**
 * Encrypt and upload a location if it's due (interval passed or moved far),
 * or always when `force` is set. Returns true if uploaded.
 */
export async function upload(
  loc: Location.LocationObject,
  trigger: string,
  { force = false, placeId = null }: { force?: boolean; placeId?: string | null } = {},
): Promise<boolean> {
  const settings = await getSettings();
  if (!settings.sharing) return false;
  const client = await loadedClient();
  if (!client) return false;
  const here = { lat: loc.coords.latitude, lng: loc.coords.longitude };
  const last = await getLastUpload();
  const intervalMs = settings.intervalMinutes * 60_000;
  const due =
    force ||
    !last ||
    Date.now() - last.ts >= intervalMs - 30_000 ||
    distanceM(last, here) > MOVE_THRESHOLD_M;
  if (!due) return false;
  await client.shareLocation({
    ...here,
    accuracy: loc.coords.accuracy,
    speed: loc.coords.speed,
    ...(await batteryInfo()),
    trigger,
    placeId,
    ts: loc.timestamp,
  });
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

/** Someone asked where we are, or the user tapped "share now". */
export async function shareNow(trigger: 'requested' | 'manual' | 'open' = 'manual'): Promise<boolean> {
  const { status } = await Location.getForegroundPermissionsAsync();
  if (status !== 'granted') return false;
  const fix = await freshFix();
  return fix ? upload(fix, trigger, { force: trigger !== 'open' }) : false;
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

/** Register the circle's places as OS geofences on this phone. */
export async function syncGeofences(places: Iterable<Place>) {
  const settings = await getSettings();
  const bg = await Location.getBackgroundPermissionsAsync().catch(() => null);
  const regions = [...places].slice(0, MAX_GEOFENCES).map((p) => ({
    identifier: p.id,
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
