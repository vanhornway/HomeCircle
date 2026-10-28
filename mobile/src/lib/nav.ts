// Leaving the screens before the app (welcome, join, setup, recover) for it.
import { router, type Href } from 'expo-router';
import { IS_COMPANION } from './variant';

/** Where the app opens: the map, or the Elderly Companion app's pages. */
export const HOME: Href = IS_COMPANION ? '/companion' : '/(tabs)';

/**
 * Go to the map, or the permissions step before it, with nothing left behind:
 * Back from there leaves the app instead of returning to the welcome screen,
 * the join screen or wherever joining started.
 */
export function enterApp(to: Href = HOME) {
  if (router.canDismiss()) router.dismissAll();
  router.replace(to);
}
