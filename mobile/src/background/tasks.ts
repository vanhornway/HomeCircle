// Background task definitions. Imported from index.ts so they exist before
// the OS delivers events (including when it relaunches the app in the background).
import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as BackgroundTask from 'expo-background-task';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadedClients } from '../lib/circle';
import { upload, freshFix, shareNow, parseGeofenceId, LOCATION_TASK, GEOFENCE_TASK, HEARTBEAT_TASK, PUSH_TASK } from '../lib/location';
import { ensureNotificationChannels, notifyNewMessages } from '../lib/notify';

const log = (...a: unknown[]) => {
  if (__DEV__) console.log('[homecircle:bg]', ...a);
};

// Movement-driven updates; upload() throttles to the configured interval.
TaskManager.defineTask<{ locations: Location.LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
  if (error || !data?.locations?.length) return;
  const latest = data.locations[data.locations.length - 1];
  try {
    await upload(latest, 'update');
  } catch (e) {
    log('location upload failed', e);
  }
});

// Periodic heartbeat (~every 15 min) so "last seen" stays fresh when not moving.
TaskManager.defineTask(HEARTBEAT_TASK, async () => {
  try {
    const fix = await Location.getLastKnownPositionAsync({ maxAge: 5 * 60_000 }).catch(() => null);
    const loc = fix || (await freshFix(15_000));
    if (loc) await upload(loc, 'update');
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (e) {
    log('heartbeat failed', e);
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

// Arriving at / leaving a place: detected by the OS on this phone.
const GEOFENCE_EVENTS_KEY = 'homecircle.geofenceEvents';
TaskManager.defineTask<{ eventType: Location.GeofencingEventType; region: Location.LocationRegion }>(
  GEOFENCE_TASK,
  async ({ data, error }) => {
    if (error || !data?.region?.identifier) return;
    const regionId = data.region.identifier;
    const action = data.eventType === Location.GeofencingEventType.Enter ? 'arrived' : 'left';
    try {
      // Remember whether we're inside or outside each place, and only announce
      // real changes. Re-registering geofences (every app launch) makes the OS
      // report the current state again, which isn't an arrival or departure.
      // Also ignore GPS jitter: flipping back within 3 minutes.
      const state = JSON.parse((await AsyncStorage.getItem(GEOFENCE_EVENTS_KEY)) || '{}');
      const prev = state[regionId];
      if (prev?.action === action) return; // same state reported again
      state[regionId] = { action, ts: Date.now() };
      await AsyncStorage.setItem(GEOFENCE_EVENTS_KEY, JSON.stringify(state));
      if (!prev) return; // first report for this place: just record it
      if (Date.now() - prev.ts < 3 * 60_000) return;

      // The place belongs to one circle; only that circle hears about it.
      const { circleId, placeId } = parseGeofenceId(regionId);
      const clients = await loadedClients();
      const client = circleId ? clients.find((c) => c.circleId === circleId) : clients[0];
      if (!client) return;
      await client.fetchPlaces().catch(() => {});
      const place = client.places.get(placeId);
      await client.sendEvent({ type: 'place', action, placeId, placeName: place?.name || 'a place' });
      const loc = (await Location.getLastKnownPositionAsync().catch(() => null)) || (await freshFix(15_000));
      if (loc) {
        await upload(loc, action, { force: true, placeId: action === 'arrived' ? placeId : null, placeCircle: client.circleId });
      }
    } catch (e) {
      log('geofence event failed', e);
    }
  },
);

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
