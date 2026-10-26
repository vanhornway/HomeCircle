// Background task definitions. Imported from index.ts so they exist before
// the OS delivers events (including when it relaunches the app in the background).
import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as BackgroundTask from 'expo-background-task';
import { upload, report, freshFix, shareNow, LOCATION_TASK, GEOFENCE_TASK, HEARTBEAT_TASK, PUSH_TASK } from '../lib/location';
import { checkPlaces, flushOutbox } from '../lib/places';
import { diag } from '../lib/diagnostics';
import { loadedClients } from '../lib/circle';
import { ensureNotificationChannels, notifyNewMessages } from '../lib/notify';
import { collectAndPlay } from '../lib/chirp';
import { checkForUpdateInBackground } from '../lib/updates';
import { SOS_TASK, onSosFix } from '../lib/sos';
import { countFetch, countFixes, countWake, currentNet } from '../lib/energy';

const log = (...a: unknown[]) => {
  if (__DEV__) console.log('[homecircle:bg]', ...a);
};

// Movement-driven updates. Each position is also checked against places, so
// arrivals and departures the OS geofence missed are still caught.
TaskManager.defineTask<{ locations: Location.LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
  if (error || !data?.locations?.length) return;
  const latest = data.locations[data.locations.length - 1];
  diag('wake:movement', { fixes: data.locations.length, accM: Math.round(latest.coords.accuracy ?? 0) });
  countWake('movement');
  countFixes(data.locations.length);
  try {
    await report(latest, 'update');
  } catch (e) {
    log('location upload failed', e);
    diag('error', { where: 'movement', msg: String((e as Error)?.message ?? e).slice(0, 100) });
  }
});

// During an SOS: a high-accuracy fix every minute, sent to every circle.
TaskManager.defineTask<{ locations: Location.LocationObject[] }>(SOS_TASK, async ({ data, error }) => {
  if (error || !data?.locations?.length) return;
  countWake('sos');
  countFixes(data.locations.length, { high: true });
  try {
    await onSosFix(data.locations[data.locations.length - 1]);
  } catch (e) {
    log('sos fix failed', e);
  }
});

// Periodic heartbeat (~every 15 min) so "last seen" stays fresh when not moving.
TaskManager.defineTask(HEARTBEAT_TASK, async () => {
  try {
    const fix = await Location.getLastKnownPositionAsync({ maxAge: 5 * 60_000 }).catch(() => null);
    const loc = fix || (await freshFix(15_000));
    diag('wake:heartbeat', { fix: fix ? 'recent' : loc ? 'fresh' : 'none' });
    countWake('heartbeat');
    if (loc) await report(loc, 'update');
    else await flushOutbox().catch(() => 0);
    // A newer app? At most every 4 hours; says so once per version.
    await checkForUpdateInBackground().catch(() => {});
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (e) {
    log('heartbeat failed', e);
    diag('error', { where: 'heartbeat', msg: String((e as Error)?.message ?? e).slice(0, 100) });
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

// iOS gives an app woken by a region crossing only about 10 seconds to run,
// so the fix has to be quick to leave time for encrypting and uploading.
const GEOFENCE_FIX_TIMEOUT_MS = 6_000;
// A fallback "last known" position older than this may predate the crossing.
const GEOFENCE_FIX_MAX_AGE_MS = 2 * 60_000;

// The OS thinks we crossed a place. Confirm with a fresh fix when we can get
// one quickly: geofence reports alone are often wrong near the edge. When the
// fix is stale or too rough to tell, the OS report decides (lib/places.ts).
TaskManager.defineTask<{ eventType: Location.GeofencingEventType; region: Location.LocationRegion }>(GEOFENCE_TASK, async ({ data, error }) => {
  if (error || !data?.region?.identifier) return;
  const action = data.eventType === Location.GeofencingEventType.Enter ? 'arrived' : 'left';
  try {
    const loc = await freshFix(GEOFENCE_FIX_TIMEOUT_MS);
    const fresh = loc && Date.now() - loc.timestamp <= GEOFENCE_FIX_MAX_AGE_MS ? loc : null;
    const fix = fresh ? { lat: fresh.coords.latitude, lng: fresh.coords.longitude, accuracy: fresh.coords.accuracy ?? null } : null;
    diag('wake:geofence', { action, fix: fresh ? 'fresh' : loc ? 'stale' : 'none', accM: fresh ? Math.round(fresh.coords.accuracy ?? 0) : undefined });
    countWake('geofence');
    const check = await checkPlaces(fix, { regionId: data.region.identifier, action });
    if (loc) await upload(loc, check.changed && check.action ? check.action : 'update', { force: check.changed, placeIds: check.placeIds });
  } catch (e) {
    log('geofence event failed', e);
    diag('error', { where: 'geofence', msg: String((e as Error)?.message ?? e).slice(0, 100) });
  }
});

// Silent pushes from the server carry no content, only what to do:
// { t: 'loc_req' } someone tapped "Locate"; { t: 'msg' } there's a new
// message to fetch, decrypt and show. They don't say which circle, so we
// check them all.
TaskManager.defineTask<Notifications.NotificationTaskPayload>(PUSH_TASK, async ({ data, error }) => {
  if (error) return;
  const raw = JSON.stringify(data ?? {});
  try {
    diag('wake:push', { type: raw.includes('loc_req') ? 'locate' : raw.includes('rejoin') ? 'rejoin' : raw.includes('chirp') ? 'chirp' : 'message' });
    countWake('push');
    if (raw.includes('"chirp"') || raw.includes('\\"chirp\\"')) {
      await ensureNotificationChannels();
      await collectAndPlay(await loadedClients());
    } else if (raw.includes('loc_req')) {
      diag('locate-request', { via: 'push' });
      await shareNow('requested');
    } else if (/\\?"t\\?"\s*:\s*\\?"msg/.test(raw)) {
      await ensureNotificationChannels();
      // One radio wake for the fetches that follow.
      countFetch(await currentNet());
      for (const client of await loadedClients()) {
        try {
          await client.fetchMessages();
          await notifyNewMessages(client, client.messages);
        } catch (e) {
          log('fetch failed for a circle', e);
        }
      }
    }
  } catch (e) {
    log('push task failed', e);
  }
});

Notifications.registerTaskAsync(PUSH_TASK).catch(() => {});
