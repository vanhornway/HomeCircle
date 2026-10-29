// Leaving the screens before the app (welcome, join, setup, recover) for it.
import { router, type Href } from 'expo-router';
import { skinRoot } from '../skins';

/**
 * Go to the map, or the permissions step before it, with nothing left behind:
 * Back from there leaves the app instead of returning to the welcome screen,
 * the join screen or wherever joining started.
 */
export function enterApp(to?: Href) {
  if (router.canDismiss()) router.dismissAll();
  // The map, or her pages: wherever this phone's skin opens.
  router.replace(to ?? skinRoot());
}
