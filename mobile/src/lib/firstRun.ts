// Permissions are asked when they matter, not all at once: location while
// joining (the app is a map of your family), notifications the first time
// there's something to hear about, and background running from Setup check.
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Linking } from 'react-native';
import { notificationPermission, registerPush } from './push';
import { shareNow, startBackgroundUpdates } from './location';
import { enterApp } from './nav';

const ASKED_NOTIFICATIONS = 'homecircle.askedNotifications';

/** Ask for location: while using the app, then "Always" (the phone shows its own prompts). */
export async function askLocation() {
  const f = await Location.requestForegroundPermissionsAsync();
  if (f.status !== 'granted') {
    if (!f.canAskAgain) Linking.openSettings();
    return false;
  }
  shareNow('manual').catch(() => {});
  const b = await Location.requestBackgroundPermissionsAsync();
  if (b.status !== 'granted' && !b.canAskAgain) Linking.openSettings();
  return b.status === 'granted';
}

/**
 * The first circle on this phone is joined or created: ask for location, then
 * open the app. An elder's phone also asks for notifications now, because her
 * calls and reminders arrive that way and she has no Chats to open.
 */
export async function finishJoining({ elder = false }: { elder?: boolean } = {}) {
  await askLocation().catch(() => {});
  if (elder) await registerPush({ ask: true }).catch(() => {});
  await startBackgroundUpdates().catch(() => {});
  enterApp();
}

/** Ask for notifications, once ever: the first time a message arrives or Chats is opened. */
export async function askNotificationsOnce() {
  try {
    if (await AsyncStorage.getItem(ASKED_NOTIFICATIONS)) return;
    await AsyncStorage.setItem(ASKED_NOTIFICATIONS, '1');
    if ((await notificationPermission()) === 'undetermined') await registerPush({ ask: true });
  } catch {
    // Not asking is fine: Settings → Notifications and Setup check can.
  }
}
