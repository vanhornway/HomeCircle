// Background task definitions. Imported from index.ts so they exist before
// the OS delivers events (including when it relaunches the app in the background).
import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as BackgroundTask from 'expo-background-task';
import { upload, report, freshFix, shareNow, LOCATION_TASK, GEOFENCE_TASK, HEARTBEAT_TASK, PUSH_TASK } from '../lib/location';
import { checkPlaces } from '../lib/places';
import { loadedClients } from '../lib/circle';
import { ensureNotificationChannels, notifyNewMessages } from '../lib/notify';

const log = (...a: unknown[]) => {
  if (__DEV__) console.log('[homecircle:bg]', ...a);
};

// Movement-driven updates. Each position is also checked against places, so
// arrivals and departures the OS geofence missed are still caught.
TaskManager.defineTask<{ locations: Location.LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
  if (error || !data?.locations?.length) return;
  const latest = data.locations[data.locations.length - 1];
  try {
    await report(latest, 'update');
  } catch (e) {
    log('location upload failed', e);
  }
});

// Periodic heartbeat (~every 15 min) so "last seen" stays fresh when not moving.
TaskManager.defineTask(HEARTBEAT_TASK, async () => {
  try {
    const fix = await Location.getLastKnownPositionAsync({ maxAge: 5 * 60_000 }).catch(() => null);
    const loc = fix || (await freshFix(15_000));
    if (loc) await report(loc, 'update');
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (e) {
    log('heartbeat failed', e);
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

// The OS thinks we crossed a place. Confirm with a fresh GPS fix before
// posting anything: geofence reports alone are often wrong near the edge.
TaskManager.defineTask<{ eventType: Location.GeofencingEventType; region: Location.LocationRegion }>(GEOFENCE_TASK, async ({ data, error }) => {
  if (error || !data?.region?.identifier) return;
  const action = data.eventType === Location.GeofencingEventType.Enter ? 'arrived' : 'left';
  try {
    const loc = await freshFix(20_000);
    const fix = loc ? { lat: loc.coords.latitude, lng: loc.coords.longitude, accuracy: loc.coords.accuracy ?? null } : null;
    const check = await checkPlaces(fix, { regionId: data.region.identifier, action });
    if (loc) await upload(loc, check.changed && check.action ? check.action : 'update', { force: check.changed, placeIds: check.placeIds });
  } catch (e) {
    log('geofence event failed', e);
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
    if (raw.includes('loc_req')) {
      await shareNow('requested');
    } else if (/\\?"t\\?"\s*:\s*\\?"msg/.test(raw)) {
      await ensureNotificationChannels();
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
