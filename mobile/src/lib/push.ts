// Push notifications via Expo's relay (works with any self-hosted server, no
// per-server Apple/Google credentials needed). The server only ever sends
// content-free pushes: "New activity" or a silent location request.
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { allClients } from './circle';

Notifications.setNotificationHandler({
  handleNotification: async (n) => {
    const data = JSON.stringify(n.request.content.data ?? {});
    // Location requests are silent. Remote "new message" pushes are replaced by
    // the decrypted notification the app shows itself (lib/notify.ts).
    const silent = data.includes('loc_req') || ((n.request.trigger as { type?: string } | null)?.type === 'push' && data.includes('"msg"'));
    return { shouldShowBanner: !silent, shouldShowList: !silent, shouldPlaySound: !silent, shouldSetBadge: false };
  },
});

export async function notificationPermission(): Promise<'granted' | 'denied' | 'undetermined'> {
  const p = await Notifications.getPermissionsAsync();
  return p.granted ? 'granted' : p.canAskAgain ? 'undetermined' : 'denied';
}

/** Ask for permission (if needed) and register this phone's push token in each circle. */
export async function registerPush({ ask = false } = {}): Promise<string | null> {
  // Android 13+ only shows the permission prompt once a channel exists.
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('activity', {
      name: 'Circle activity',
      importance: AndroidImportance.HIGH,
    });
  }
  let perm = await Notifications.getPermissionsAsync();
  if (!perm.granted && ask && perm.canAskAgain) perm = await Notifications.requestPermissionsAsync();
  if (!perm.granted) return null;
  // Emulators and simulators can't get push tokens; permission still applies.
  if (!Device.isDevice) return null;
  const projectId = Constants.expoConfig?.extra?.eas?.projectId || Constants.easConfig?.projectId;
  if (!projectId) {
    if (__DEV__) console.warn('[homecircle] No EAS projectId: run `npx eas-cli init` to enable push notifications');
    return null;
  }
  try {
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    await Promise.allSettled(allClients().map((c) => c.api.putPush(token, Platform.OS)));
    return token;
  } catch (e) {
    if (__DEV__) console.warn('[homecircle] push registration failed', e);
    return null;
  }
}
