// Background task definitions. Imported from index.ts so they exist before
// the OS delivers events (including when it relaunches the app in the background).
import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as BackgroundTask from 'expo-background-task';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadedClient } from '../lib/circle';
import { upload, freshFix, shareNow, LOCATION_TASK, GEOFENCE_TASK, HEARTBEAT_TASK, PUSH_TASK } from '../lib/location';

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
    const placeId = data.region.identifier;
    const action = data.eventType === Location.GeofencingEventType.Enter ? 'arrived' : 'left';
    try {
      // Ignore GPS jitter: the same event for the same place within 3 minutes.
      const recent = JSON.parse((await AsyncStorage.getItem(GEOFENCE_EVENTS_KEY)) || '{}');
      const prev = recent[placeId];
      if (prev && prev.action === action && Date.now() - prev.ts < 3 * 60_000) return;
      recent[placeId] = { action, ts: Date.now() };
      await AsyncStorage.setItem(GEOFENCE_EVENTS_KEY, JSON.stringify(recent));

      const client = await loadedClient();
      if (!client) return;
      await client.fetchPlaces().catch(() => {});
      const place = client.places.get(placeId);
      await client.sendEvent({ type: 'place', action, placeId, placeName: place?.name || 'a place' });
      const loc = (await Location.getLastKnownPositionAsync().catch(() => null)) || (await freshFix(15_000));
      if (loc) await upload(loc, action, { force: true, placeId: action === 'arrived' ? placeId : null });
    } catch (e) {
      log('geofence event failed', e);
    }
  },
);

// Silent push from the server: someone tapped "Locate". Payloads carry no
// content beyond { t: 'loc_req' }.
TaskManager.defineTask<Notifications.NotificationTaskPayload>(PUSH_TASK, async ({ data, error }) => {
  if (error) return;
  try {
    if (JSON.stringify(data ?? {}).includes('loc_req')) await shareNow('requested');
  } catch (e) {
    log('location request failed', e);
  }
});

Notifications.registerTaskAsync(PUSH_TASK).catch(() => {});
