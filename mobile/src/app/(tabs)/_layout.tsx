import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import { AppState } from 'react-native';
import { Tabs } from 'expo-router/js-tabs';
import { router, useRouter } from 'expo-router';
import { errorText, getClient } from '../../lib/circle';
import { getServerState, isUnreachable, setRetryHandler, setServerState } from '../../lib/connection';
import { registerPush } from '../../lib/push';
import { ensureNotificationChannels, markSeen, notifyNewMessages, useUnreadCount } from '../../lib/notify';
import { shareNow, startBackgroundUpdates, syncGeofences } from '../../lib/location';
import { updateSettings } from '../../lib/storage';
import { Icon } from '../../components/ui';
import { useTheme } from '../../theme';
import { CircleClient } from '@homecircle/core';

/**
 * While the app is open: live WebSocket + fresh data. In the background the
 * socket is closed — the OS location/geofence/push tasks take over.
 * If the server can't be reached, the app keeps working with a banner and
 * retries (10 s, 20 s, 40 s … up to 2 min) while it's in the foreground.
 */
function useCircleLifecycle() {
  useEffect(() => {
    const client = getClient();
    let alive = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let started = false;

    const scheduleRetry = () => {
      if (retryTimer) clearTimeout(retryTimer);
      const delay = Math.min(120_000, 10_000 * 2 ** attempt++);
      setServerState({ retrying: true });
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (AppState.currentState === 'active') resume();
      }, delay);
    };

    const resume = async () => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      try {
        await client.start();
        // Opening the app counts as seeing what arrived meanwhile.
        markSeen(client.lastSeq).catch(() => {});
        attempt = 0;
        setServerState({ reachable: true, error: null, retrying: false });
        shareNow('open').catch(() => {});
        if (!started && alive) {
          started = true;
          registerPush().catch(() => {});
          syncGeofences(client.places.values()).catch(() => {});
          if (client.serverUrl) {
            CircleClient.serverInfo(client.serverUrl)
              .then((i) => updateSettings({ tileUrl: i.tileUrl, tileAttribution: i.tileAttribution }))
              .catch(() => {});
          }
        }
      } catch (e: any) {
        if (e?.status === 401) {
          await client.signOut();
          router.replace('/welcome');
          return;
        }
        setServerState({ reachable: false, error: isUnreachable(e) ? null : errorText(e) });
        if (alive) scheduleRetry();
      }
    };

    const offs = [
      client.on('locationRequest', () => shareNow('requested').catch(() => {})),
      client.on('places', (places) => syncGeofences(places.values()).catch(() => {})),
      client.on('removed', () => router.replace('/welcome')),
      client.on('newMessage', (m) => notifyNewMessages(client, [m]).catch(() => {})),
      // The live socket reconnects by itself; reflect it in the banner and
      // catch up on anything missed while it was down.
      client.on('status', (s) => {
        if (s === 'online') {
          // CircleClient catches up on missed data itself after a reconnect.
          if (!getServerState().reachable) setServerState({ reachable: true, error: null, retrying: false });
        } else if (s === 'offline' && AppState.currentState === 'active') {
          setServerState({ reachable: false, retrying: true });
        }
      }),
    ];
    setRetryHandler(() => {
      attempt = 0;
      setServerState({ retrying: true });
      resume();
    });

    ensureNotificationChannels().catch(() => {});
    // Location sharing doesn't depend on the server being up right now.
    startBackgroundUpdates().catch(() => {});
    resume();

    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') resume();
      else if (state === 'background') {
        if (retryTimer) clearTimeout(retryTimer);
        client.disconnect();
      }
    });
    return () => {
      alive = false;
      if (retryTimer) clearTimeout(retryTimer);
      setRetryHandler(null);
      offs.forEach((off) => off());
      sub.remove();
      client.disconnect();
    };
  }, []);
}

/** Tapping a message notification opens the chat. */
function useOpenChatFromNotification() {
  const nav = useRouter();
  const response = Notifications.useLastNotificationResponse();
  useEffect(() => {
    if (response && JSON.stringify(response.notification.request.content.data ?? {}).includes('"chat"')) {
      nav.navigate('/(tabs)/chat');
    }
  }, [response, nav]);
}

export default function TabsLayout() {
  const t = useTheme();
  const unread = useUnreadCount();
  useCircleLifecycle();
  useOpenChatFromNotification();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: t.brand,
        tabBarInactiveTintColor: t.muted,
        tabBarStyle: { backgroundColor: t.surface, borderTopColor: t.line },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Map', tabBarIcon: ({ color }) => <Icon name="map" color={color} /> }} />
      <Tabs.Screen
        name="chat"
        options={{ title: 'Chat', tabBarBadge: unread ? (unread > 9 ? '9+' : unread) : undefined, tabBarIcon: ({ color }) => <Icon name="chat" color={color} /> }}
      />
      <Tabs.Screen name="places" options={{ title: 'Places', tabBarIcon: ({ color }) => <Icon name="place" color={color} /> }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: ({ color }) => <Icon name="settings" color={color} /> }} />
    </Tabs>
  );
}
