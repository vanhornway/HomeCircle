// Battery-aware location sharing.
//
// - How often: lib/locationPolicy.ts decides, from the "Location updates"
//   setting, charging, Battery Saver and the day's battery budget. While
//   moving, at most one upload per moving gap; when the phone stops, the
//   final position goes right away; while still, one per still interval.
// - Background: the OS wakes us on movement (~100 m apart, at most once a
//   minute) and a background task runs about every 15 minutes.
// - "Locate" requests from family: one fresh high-accuracy fix, uploaded now.
// - Places: OS geofences hint that a place may have been crossed; every
//   position is checked against places too (lib/places.ts).
// - Low battery: one last update at 10% and at 5%, so the circle knows
//   where the phone was before it died.
import * as Location from 'expo-location';
import * as Battery from 'expo-battery';
import * as BackgroundTask from 'expo-background-task';
import { approximate, distanceM, type CircleClient } from '@homecircle/core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSettings, getLastUpload, locationProfileOf, setLastUpload, type LastUpload } from './storage';
import { HERE_PREFIX, checkPlaces, geofenceId, sharingClients } from './places';
import { diag } from './diagnostics';
import { APP_VERSION } from './updates';
import { phoneHealth } from './health';
import { recordFix, shareMyPlaces } from './visits';
import { loadedClients } from './circle';
import { countFixes, countUpload, currentNet, noteCharging, usedTodayMah } from './energy';
import { SLOW_AFTER_MS, SLOW_STILL_INTERVAL_MS, STOPS, effectiveLocationPolicy, type Policy } from './locationPolicy';

export { distanceM, sharingClients };

export const LOCATION_TASK = 'homecircle-location';
export const GEOFENCE_TASK = 'homecircle-geofence';
export const HEARTBEAT_TASK = 'homecircle-heartbeat';
export const PUSH_TASK = 'homecircle-push';

// Farther than this from the last update (or the last fix) counts as moving.
const MOVED_M = 100;
const MOTION_KEY = 'homecircle.motion';
// Still mode: after this long without moving, stop asking for location and
// watch a circle this big around the phone instead (leaving it wakes us).
const STILL_AFTER_MS = 10 * 60_000;
const HERE_RADIUS_M = 250;
const STILL_KEY = 'homecircle.still';
// In still mode the request stays, only slower: a check every 10 minutes.
const STILL_FIX_INTERVAL_MS = 10 * 60_000;
// The request last asked for, so a wake-up only changes it when the policy did.
const REQUEST_KEY = 'homecircle.request';
const MAX_GEOFENCES = 20; // iOS limit per app
// Smallest radius the OS watches reliably; smaller places are still checked
// against real positions (lib/places.ts), just not used as OS geofences.
const MIN_GEOFENCE_RADIUS_M = 150;
// Android: fastest the OS hands us fixes while moving (100 m apart anyway).
const MOVING_FIX_INTERVAL_MS = 60_000;
const MOVING_FIX_DISTANCE_M = 100;

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
  noteCharging(battery.charging);
  // Battery about to run out: send one last position (once per step).
  const step = lowBatteryStep(battery);
  const lowDue = step != null && (last?.lowBattery == null || step < last.lowBattery);
  const policy = await currentPolicy(battery);
  const motion = await noteMotion(here, loc.timestamp || Date.now());
  const since = last ? Date.now() - last.ts : Infinity;
  const moved = !last || distanceM(last, here) > MOVED_M;
  const due =
    force ||
    lowDue ||
    !last ||
    // Stopped after moving: the final position right away.
    (motion.justStopped && moved) ||
    (moved && since >= policy.movingGapMs - 5_000) ||
    since >= stillIntervalFor(policy, motion, last, here) - 30_000;
  // Held back by the moving gap: the heartbeat sends it if no later fix does.
  if (!due) {
    if (moved) await setPending(true);
    return false;
  }
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
        app: APP_VERSION,
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
  // One radio wake for this update (every circle, and Home Assistant, go together).
  countUpload(await currentNet());
  diag('upload', { trigger: lowDue ? 'low_battery' : trigger, circles: `${ok}/${results.length}`, accM: Math.round(loc.coords.accuracy ?? 0), power: health.power, perm: health.perm });
  await setLastUpload({ ts: Date.now(), ...here, lowBattery: step ?? null });
  await setPending(false);
  return true;
}

/** The policy right now: the setting, charging, Battery Saver and the day's budget. */
export async function currentPolicy(battery?: { battery: number | null; charging: boolean }): Promise<Policy> {
  const settings = await getSettings();
  const b = battery ?? (await batteryInfo());
  const profile = locationProfileOf(settings);
  const [saver, used] = await Promise.all([Battery.isLowPowerModeEnabledAsync().catch(() => false), usedTodayMah()]);
  return effectiveLocationPolicy(
    // A stop always means its own values; Advanced's own values are 'custom'.
    { locationProfile: profile, location: profile === 'custom' ? settings.location : { ...settings.location, ...STOPS[profile] } },
    { charging: b.charging, batterySaver: saver, batteryLevel: b.battery, usedTodayMah: used },
  );
}

/** Where the phone was at its last fix, since when it's been still, and whether a fix is waiting to be sent. */
type Motion = { lat: number; lng: number; ts: number; moving: boolean; stillSince: number; pending: boolean };

export async function getMotion(): Promise<Motion | null> {
  try {
    return JSON.parse((await AsyncStorage.getItem(MOTION_KEY)) || 'null');
  } catch {
    return null;
  }
}

/** A new fix: moving (more than 100 m from the last fix) or still, and whether it just stopped. */
async function noteMotion(here: { lat: number; lng: number }, ts: number): Promise<Motion & { justStopped: boolean }> {
  const prev = await getMotion();
  const moving = !!prev && distanceM(prev, here) > MOVED_M;
  const justStopped = !!prev?.moving && !moving;
  const next: Motion = { ...here, ts, moving, stillSince: moving ? ts : (prev?.stillSince ?? ts), pending: prev?.pending ?? false };
  await AsyncStorage.setItem(MOTION_KEY, JSON.stringify(next));
  return { ...next, justStopped };
}

async function setPending(pending: boolean) {
  const m = await getMotion();
  if (m && m.pending !== pending) await AsyncStorage.setItem(MOTION_KEY, JSON.stringify({ ...m, pending }));
}

/** The still interval in force: slower after an hour within 100 m of the last update (if the policy allows). */
export function stillIntervalFor(policy: Policy, motion: Pick<Motion, 'stillSince'> | null, last: LastUpload | null, here?: { lat: number; lng: number }) {
  const settled = !!motion && Date.now() - motion.stillSince >= SLOW_AFTER_MS && (!here || !last || distanceM(last, here) <= MOVED_M);
  return policy.slowWhenStill && settled ? Math.max(policy.stillIntervalMs, SLOW_STILL_INTERVAL_MS) : policy.stillIntervalMs;
}

/**
 * The heartbeat: whether it's worth waking the location hardware now. Not
 * when the last update is recent, nothing's waiting to be sent and the
 * battery doesn't need its last update yet.
 */
export async function heartbeatDue(): Promise<boolean> {
  const [last, motion, battery] = await Promise.all([getLastUpload(), getMotion(), batteryInfo()]);
  noteCharging(battery.charging);
  if (!last || motion?.pending) return true;
  const step = lowBatteryStep(battery);
  if (step != null && (last.lowBattery == null || step < last.lowBattery)) return true;
  const policy = await currentPolicy(battery);
  return Date.now() - last.ts >= stillIntervalFor(policy, motion, last) - 60_000;
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
    if (fix) {
      countFixes(1, { high: true });
      return fix;
    }
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

/**
 * Right after an admin connects Home Assistant: send this phone's position
 * there now and say what it's called there ("device_tracker.homecircle_umair"),
 * or why not.
 */
export async function sendToHomeAssistantNow(client: CircleClient): Promise<{ entity?: string; why?: string }> {
  const settings = await getSettings();
  if (!settings.sendToHomeAssistant) return { why: 'You turned off sending your location to Home Assistant (Settings → Location sharing).' };
  if (!settings.sharing || settings.pausedCircles.includes(client.circleId!)) return { why: 'Your location sharing is paused for this circle.' };
  const { status } = await Location.getForegroundPermissionsAsync();
  if (status !== 'granted') return { why: 'HomeCircle isn’t allowed to use your location.' };
  const fix = await freshFix();
  if (!fix) return { why: 'Your phone couldn’t get its location just now.' };
  const here = { lat: fix.coords.latitude, lng: fix.coords.longitude };
  const approx = settings.approximateCircles.includes(client.circleId!);
  const battery = await batteryInfo();
  const r = await client.api.homeAssistantLocation({
    ...(approx ? approximate(here) : { ...here, accuracy: fix.coords.accuracy }),
    speed: approx ? null : fix.coords.speed,
    battery: battery.battery == null ? null : Math.round(battery.battery * 100),
    charging: battery.charging,
    name: client.account?.profile.name ?? 'Someone',
  });
  return { entity: r.entity };
}

export type SharingMode = 'off' | 'no-permission' | 'foreground-only' | 'background';

/** (Re)start background updates using the current settings. */
export async function startBackgroundUpdates(): Promise<SharingMode> {
  const settings = await getSettings();
  const policy = await currentPolicy();
  if (!settings.sharing) {
    await stopBackgroundUpdates();
    return 'off';
  }
  const fg = await Location.getForegroundPermissionsAsync();
  if (fg.status !== 'granted') return 'no-permission';
  const bg = await Location.getBackgroundPermissionsAsync();
  if (bg.status !== 'granted') return 'foreground-only';

  // Never stopped and started again here: from the background, expo-location
  // can't start its foreground service, and Android then allows only a few
  // updates an hour. Asking again with new options changes the running
  // request in place and keeps the service.
  let still = !!(await getStillHere());
  if (still && !policy.stillMode) {
    // Still mode no longer applies (another stop, or charging): moving mode, no circle.
    await AsyncStorage.removeItem(STILL_KEY);
    syncGeofences().catch(() => {});
    still = false;
  }
  const request = requestFor(policy, still);
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    // Wi-Fi and cell towers; GPS only while charging (the policy says which).
    accuracy: request.high ? Location.Accuracy.High : Location.Accuracy.Balanced,
    // Never prompt users to turn on Google's "Location Accuracy" (it shares
    // Wi-Fi/sensor data with Google). GPS and network location work without it.
    mayShowUserSettingsDialog: false,
    // Hand every 100 m of movement to the task and let upload() decide what's
    // worth sending (lib/locationPolicy.ts). No native batching: expo-location only releases a batch
    // once BOTH the deferred interval AND distance are met, so someone who
    // drove 3 km in 8 minutes and then sat still was never reported. On
    // Android, timeInterval is also the *minimum* gap between fixes, so a
    // 15-minute value meant a moving phone reported at most every 15 minutes.
    distanceInterval: MOVING_FIX_DISTANCE_M,
    // Android only. Still mode: a check every 10 minutes is enough to notice leaving.
    timeInterval: request.intervalMs,
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
  await AsyncStorage.setItem(REQUEST_KEY, JSON.stringify(request));
  await registerHeartbeat();
  return 'background';
}

/** The location request the policy wants: GPS or not, and how often. */
function requestFor(policy: Policy, still: boolean) {
  return { high: policy.movingAccuracy === 'high', intervalMs: still ? STILL_FIX_INTERVAL_MS : MOVING_FIX_INTERVAL_MS };
}

/**
 * At every wake-up: if the request the policy wants changed (plugged in or
 * unplugged, still mode, another stop), change it now, in place.
 */
export async function applyPolicy(): Promise<void> {
  const settings = await getSettings();
  if (!settings.sharing) return;
  const [policy, still, applied] = await Promise.all([currentPolicy(), getStillHere(), AsyncStorage.getItem(REQUEST_KEY)]);
  const want = requestFor(policy, !!still && policy.stillMode);
  if (applied === JSON.stringify(want) && !(still && !policy.stillMode)) return;
  if (!(await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false))) return;
  diag('location-request', { gps: want.high, everyMin: want.intervalMs / 60_000 });
  await startBackgroundUpdates();
}

async function registerHeartbeat() {
  try {
    // As often as Android allows; heartbeatDue() decides whether it does anything.
    await BackgroundTask.registerTaskAsync(HEARTBEAT_TASK, { minimumInterval: 15 });
  } catch {
    /* unavailable (e.g. simulator) */
  }
}

/** Where the phone went still (still mode), or null while it's moving. */
export async function getStillHere(): Promise<{ lat: number; lng: number; since: number } | null> {
  try {
    return JSON.parse((await AsyncStorage.getItem(STILL_KEY)) || 'null');
  } catch {
    return null;
  }
}

/**
 * Still mode, from the heartbeat: still for 10 minutes and the policy allows
 * it, so the location request slows to a check every 10 minutes, and a 250 m
 * circle around the phone wakes it sooner when it leaves.
 */
export async function maybeEnterStillMode(): Promise<boolean> {
  const [policy, motion, here] = await Promise.all([currentPolicy(), getMotion(), getStillHere()]);
  if (here || !policy.stillMode || !motion || motion.moving || motion.pending || Date.now() - motion.stillSince < STILL_AFTER_MS) return false;
  await AsyncStorage.setItem(STILL_KEY, JSON.stringify({ lat: motion.lat, lng: motion.lng, since: Date.now() }));
  // The same request, slower (changed in place: the service keeps running).
  await startBackgroundUpdates();
  await syncGeofences();
  diag('still-mode', { on: true });
  return true;
}

/** Moving again (the phone left the circle around it, or still mode no longer applies): ask for location again. */
export async function leaveStillMode(why: string) {
  if (!(await getStillHere())) return;
  await AsyncStorage.removeItem(STILL_KEY);
  diag('still-mode', { on: false, why });
  await startBackgroundUpdates().catch((e) => diag('error', { where: 'still-mode', msg: String(e?.message ?? e).slice(0, 100) }));
  await syncGeofences();
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
  // In still mode, one of them is the circle around the phone.
  const here = await getStillHere();
  const regions = places.slice(0, here ? MAX_GEOFENCES - 1 : MAX_GEOFENCES).map((p) => ({
    identifier: p.identifier,
    latitude: p.lat,
    longitude: p.lng,
    radius: Math.max(MIN_GEOFENCE_RADIUS_M, p.radius),
    notifyOnEnter: true,
    notifyOnExit: true,
  }));
  if (here) regions.push({ identifier: `${HERE_PREFIX}${Math.round(here.since / 1000)}`, latitude: here.lat, longitude: here.lng, radius: HERE_RADIUS_M, notifyOnEnter: false, notifyOnExit: true });
  const started = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => false);
  if (!settings.sharing || bg?.status !== 'granted' || !regions.length) {
    if (started) await Location.stopGeofencingAsync(GEOFENCE_TASK);
    return;
  }
  await Location.startGeofencingAsync(GEOFENCE_TASK, regions);
}
