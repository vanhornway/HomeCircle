// Battery-aware location sharing.
//
// - Background: the OS wakes us on movement (~250 m) and a background task
//   runs about every 15 minutes; we upload at most once per interval unless
//   the phone moved more than 500 m, arrived somewhere or left somewhere.
// - "Locate" requests from family: one fresh high-accuracy fix, uploaded now.
// - Places: OS geofences hint that a place may have been crossed; every
//   position is checked against places too (lib/places.ts).
// - Low battery: one last update at 10% and at 5%, so the circle knows
//   where the phone was before it died.
import * as Location from 'expo-location';
import * as Battery from 'expo-battery';
import * as BackgroundTask from 'expo-background-task';
import { approximate, distanceM } from '@homecircle/core';
import { getSettings, getLastUpload, setLastUpload } from './storage';
import { checkPlaces, geofenceId, sharingClients } from './places';
import { diag } from './diagnostics';
import { phoneHealth } from './health';
import { recordFix, shareMyPlaces } from './visits';
import { loadedClients } from './circle';

export { distanceM, sharingClients };

export const LOCATION_TASK = 'homecircle-location';
export const GEOFENCE_TASK = 'homecircle-geofence';
export const HEARTBEAT_TASK = 'homecircle-heartbeat';
export const PUSH_TASK = 'homecircle-push';

const MOVE_THRESHOLD_M = 500;
const MAX_GEOFENCES = 20; // iOS limit per app
// Smallest radius the OS watches reliably; smaller places are still checked
// against real positions (lib/places.ts), just not used as OS geofences.
const MIN_GEOFENCE_RADIUS_M = 150;
// Android: fastest the OS hands us fixes while moving (250 m apart anyway).
const MOVING_FIX_INTERVAL_MS = 60_000;

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

/** 10 or 5 when the battery is that low and not charging, otherwise null. */
const lowBatteryStep = ({ battery, charging }: { battery: number | null; charging: boolean }) =>
  battery == null || charging ? null : battery <= 0.05 ? 5 : battery <= 0.1 ? 10 : null;

/**
 * Encrypt and upload a location to each circle if it's due (interval passed
 * or moved far), or always when `force` is set. Each circle gets its own copy,
 * sealed with that circle's key: exact, or rounded to ~1 km for circles you
 * share an approximate location with. Returns true if any circle got it.
 * `placeIds` says which place you're at, per circle id.
 */
export async function upload(
  loc: Location.LocationObject,
  trigger: string,
  { force = false, placeIds = {}, everyone = false }: { force?: boolean; placeIds?: Record<string, string>; everyone?: boolean } = {},
): Promise<boolean> {
  const settings = await getSettings();
  // During an SOS: every circle on this phone, exact, paused or not.
  const targets = everyone ? (await loadedClients()).filter((c) => c.feature('sos')) : await sharingClients();
  if (!targets.length) return false;
  const here = { lat: loc.coords.latitude, lng: loc.coords.longitude };
  const last = await getLastUpload();
  const battery = await batteryInfo();
  // Battery about to run out: send one last position (once per step).
  const step = lowBatteryStep(battery);
  const lowDue = step != null && (last?.lowBattery == null || step < last.lowBattery);
  const intervalMs = settings.intervalMinutes * 60_000;
  const due =
    force ||
    lowDue ||
    !last ||
    Date.now() - last.ts >= intervalMs - 30_000 ||
    distanceM(last, here) > MOVE_THRESHOLD_M;
  if (!due) return false;
  const approxCircles = new Set(everyone ? [] : settings.approximateCircles);
  // Battery saver, permission level and precise on/off travel with every
  // update, so the circle sees why updates may be slow.
  const health = await phoneHealth();
  const results = await Promise.allSettled(
    targets.map((client) => {
      const approx = approxCircles.has(client.circleId!);
      const pos = approx ? approximate(here) : { ...here, accuracy: loc.coords.accuracy };
      return client.shareLocation({
        ...pos,
        speed: approx ? null : loc.coords.speed,
        ...battery,
        trigger: lowDue && client.feature('lowBattery') ? 'low_battery' : trigger,
        placeId: approx ? null : (placeIds[client.circleId!] ?? null),
        approx,
        power: health.power,
        perm: health.perm,
        precise: health.precise,
        ts: loc.timestamp,
      });
    }),
  );
  if (settings.sendToHomeAssistant) {
    for (const client of targets.filter((c) => c.feature('homeAssistant'))) {
      const approx = approxCircles.has(client.circleId!);
      const pos = approx ? approximate(here) : { ...here, accuracy: loc.coords.accuracy };
      client.api
        .homeAssistantLocation({
          ...pos,
          speed: approx ? null : loc.coords.speed,
          battery: battery.battery == null ? null : Math.round(battery.battery * 100),
          charging: battery.charging,
          name: client.account?.profile.name ?? 'Someone',
        })
        .catch((e: { status?: number; message?: string }) => {
          // 409: not set up yet. Anything else is worth a line in Diagnostics.
          if (e.status !== 409) diag('home-assistant-failed', { error: String(e.message ?? '').slice(0, 80) });
        });
    }
  }
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  if (!ok) {
    diag('upload-failed', { trigger, circles: results.length, error: String((results[0] as PromiseRejectedResult).reason?.message ?? '').slice(0, 80) });
    throw (results[0] as PromiseRejectedResult).reason;
  }
  diag('upload', { trigger: lowDue ? 'low_battery' : trigger, circles: `${ok}/${results.length}`, accM: Math.round(loc.coords.accuracy ?? 0), power: health.power, perm: health.perm });
  await setLastUpload({ ts: Date.now(), ...here, lowBattery: step ?? null });
  return true;
}

/** Check places with this position, then upload it (right away if you arrived or left somewhere). */
export async function report(loc: Location.LocationObject, trigger: string, { force = false }: { force?: boolean } = {}) {
  // Most visited places: this phone's own history, kept on the phone.
  await recordFix(loc.coords.latitude, loc.coords.longitude, loc.coords.accuracy ?? null, loc.timestamp).catch(() => {});
  const check = await checkPlaces({ lat: loc.coords.latitude, lng: loc.coords.longitude, accuracy: loc.coords.accuracy ?? null }).catch(
    () => ({ placeIds: {}, changed: false, action: null }),
  );
  const sent = await upload(loc, check.changed && check.action ? check.action : trigger, { force: force || check.changed, placeIds: check.placeIds });
  // At most every 6 hours; every circle, so paused and approximate ones get them withdrawn.
  loadedClients()
    .then((clients) => shareMyPlaces(clients))
    .catch(() => {});
  return sent;
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
  return fix ? report(fix, trigger, { force: trigger !== 'open' || missing }) : false;
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

  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false)) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  }
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.Balanced,
    // Never prompt users to turn on Google's "Location Accuracy" (it shares
    // Wi-Fi/sensor data with Google). GPS and network location work without it.
    mayShowUserSettingsDialog: false,
    // Hand every 250 m of movement to the task and let upload() decide what's
    // worth sending. No native batching: expo-location only releases a batch
    // once BOTH the deferred interval AND distance are met, so someone who
    // drove 3 km in 8 minutes and then sat still was never reported. On
    // Android, timeInterval is also the *minimum* gap between fixes, so a
    // 15-minute value meant a moving phone reported at most every 15 minutes.
    distanceInterval: 250,
    timeInterval: MOVING_FIX_INTERVAL_MS, // Android only
    deferredUpdatesInterval: 0,
    deferredUpdatesDistance: 0,
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

let syncing: Promise<void> | null = null;
let syncAgain = false;

/**
 * Register the places of every circle you share with as OS geofences.
 * Each circle asks for this as its places load, so calls are run one at a
 * time and the last run sees every circle (otherwise an early run with no
 * places could stop the geofences a later run just started).
 */
export function syncGeofences(): Promise<void> {
  if (syncing) {
    syncAgain = true;
    return syncing;
  }
  syncing = (async () => {
    do {
      syncAgain = false;
      await syncGeofencesNow().catch(() => {});
    } while (syncAgain);
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}

async function syncGeofencesNow() {
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
  // The OS watches at most 20 regions: keep the ones nearest to where we last
  // were (re-picked whenever the app opens or places change).
  const last = await getLastUpload();
  const places = [...unique.values()];
  if (last) places.sort((a, b) => distanceM(last, a) - distanceM(last, b));
  const regions = places.slice(0, MAX_GEOFENCES).map((p) => ({
    identifier: p.identifier,
    latitude: p.lat,
    longitude: p.lng,
    radius: Math.max(MIN_GEOFENCE_RADIUS_M, p.radius),
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
