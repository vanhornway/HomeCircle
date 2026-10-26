// Leaving the screens before the app (welcome, join, setup, recover) for it.
import { router, type Href } from 'expo-router';

/**
 * Go to the map, or the permissions step before it, with nothing left behind:
 * Back from there leaves the app instead of returning to the welcome screen,
 * the join screen or wherever joining started.
 */
export function enterApp(to: Href = '/(tabs)') {
  if (router.canDismiss()) router.dismissAll();
  router.replace(to);
}
