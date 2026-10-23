import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import { AppState } from 'react-native';
import { Tabs } from 'expo-router/js-tabs';
import { router, useRouter } from 'expo-router';
import { CircleClient } from '@homecircle/core';
import { allClients, clientForCircle, errorText, getClient, useCircles } from '../../lib/circle';
import { getServerState, isUnreachable, setRetryHandler, setServerState } from '../../lib/connection';
import { registerPush } from '../../lib/push';
import { ensureNotificationChannels, markSeen, notifyNewMessages } from '../../lib/notify';
import { ensureReadBase, unreadInCircle } from '../../lib/unread';
import { useAllCircles } from '../../lib/useCircle';
import { shareNow, startBackgroundUpdates, syncGeofences } from '../../lib/location';
import { flushOutbox } from '../../lib/places';
import { diag } from '../../lib/diagnostics';
import { phoneHealth } from '../../lib/health';
import { updateSettings, useSettings } from '../../lib/storage';
import { Icon } from '../../components/ui';
import { useTheme } from '../../theme';

/**
 * While the app is open: a live WebSocket + fresh data for every circle this
 * phone is in. In the background the sockets close and the OS location,
 * geofence and push tasks take over. The banner reflects the circle on screen;
 * if a server can't be reached, the app keeps working and retries (10 s, 20 s,
 * 40 s … up to 2 min) while it's in the foreground.
 */
function useCircleLifecycle(circlesKey: string) {
  useEffect(() => {
    const clients = allClients();
    if (!clients.length) {
      router.replace('/welcome');
      return;
    }
    let alive = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const started = new Set<CircleClient>();

    const scheduleRetry = () => {
      if (retryTimer) clearTimeout(retryTimer);
      const delay = Math.min(120_000, 10_000 * 2 ** attempt++);
      setServerState({ retrying: true });
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (AppState.currentState === 'active') resume();
      }, delay);
    };

    const startOne = async (client: CircleClient) => {
      try {
        await client.start();
        // What arrived meanwhile shows as unread in Chats, but isn't notified again.
        markSeen(client, client.lastSeq).catch(() => {});
        ensureReadBase(client).catch(() => {});
        if (!started.has(client)) {
          started.add(client);
          if (client === clients[0] && client.serverUrl) {
            CircleClient.serverInfo(client.serverUrl)
              .then((i) => updateSettings({ tileUrl: i.tileUrl, tileAttribution: i.tileAttribution }))
              .catch(() => {});
          }
        }
        return null;
      } catch (e: any) {
        // A 401 means the server doesn't know this phone in that circle: it was
        // removed, the circle was deleted, or the server lost its data. Keep the
        // keys (deleting them can't be undone); the banner lets the person
        // remove the circle from this phone.
        return e;
      }
    };

    const resume = async () => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      const results = new Map<CircleClient, any>();
      await Promise.all(allClients().map(async (c) => results.set(c, await startOne(c))));
      if (!alive) return;
      const failed = [...results].filter(([c, e]) => e && e.status !== 401 && allClients().includes(c));
      const activeError = results.get(getClient());
      if (activeError?.status === 401) {
        setServerState({ reachable: true, error: null, retrying: false, unrecognized: true });
      } else if (activeError) {
        setServerState({ reachable: false, error: isUnreachable(activeError) ? null : errorText(activeError), unrecognized: false });
      } else {
        setServerState({ reachable: true, error: null, retrying: false, unrecognized: false });
      }
      if (failed.length) scheduleRetry();
      else attempt = 0;
      shareNow('open').catch(() => {});
      registerPush().catch(() => {});
      syncGeofences().catch(() => {});
      // Anything that couldn't be posted while offline goes out now.
      flushOutbox().catch(() => 0);
      phoneHealth()
        .then((h) => diag('app-open', { ...h, circles: allClients().length, failed: failed.length }))
        .catch(() => {});
    };

    const offs = clients.flatMap((client) => [
      client.on('locationRequest', () => {
        diag('locate-request', { via: 'live' });
        shareNow('requested').catch(() => {});
      }),
      client.on('places', () => syncGeofences().catch(() => {})),
      client.on('newMessage', (m) => notifyNewMessages(client, [m]).catch(() => {})),
      // The live socket reconnects by itself; reflect the circle on screen in
      // the banner. CircleClient catches up on missed data after a reconnect.
      client.on('status', (s) => {
        if (client !== getClient()) return;
        if (s === 'online') {
          if (!getServerState().reachable) setServerState({ reachable: true, error: null, retrying: false });
        } else if (s === 'offline' && AppState.currentState === 'active') {
          setServerState({ reachable: false, retrying: true });
        }
      }),
    ]);
    setRetryHandler(() => {
      attempt = 0;
      setServerState({ retrying: true });
      resume();
    });

    ensureNotificationChannels().catch(() => {});
    // Location sharing doesn't depend on the servers being up right now.
    startBackgroundUpdates().catch(() => {});
    resume();

    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') resume();
      else if (state === 'background') {
        if (retryTimer) clearTimeout(retryTimer);
        allClients().forEach((c) => c.disconnect());
      }
    });
    return () => {
      alive = false;
      if (retryTimer) clearTimeout(retryTimer);
      setRetryHandler(null);
      offs.forEach((off) => off());
      sub.remove();
      clients.forEach((c) => c.disconnect());
    };
  }, [circlesKey]);
}

/** Tapping a message notification opens that conversation. */
function useOpenChatFromNotification() {
  const nav = useRouter();
  const response = Notifications.useLastNotificationResponse();
  useEffect(() => {
    const data = response?.notification.request.content.data as { t?: string; circle?: string; peer?: string } | undefined;
    if (data?.t !== 'chat') return;
    const client = clientForCircle(data.circle);
    nav.navigate('/(tabs)/chat');
    if (client) nav.push({ pathname: '/conversation', params: { circle: client.circleId!, peer: data.peer || '' } });
  }, [response, nav]);
}

export default function TabsLayout() {
  const t = useTheme();
  // Restart connections when circles are added or removed (not on switching).
  const { clients } = useCircles();
  useSettings(); // place alerts on/off changes what counts as unread
  const unread = useAllCircles(['messages']).reduce((n, c) => n + unreadInCircle(c), 0);
  useCircleLifecycle(clients.map((c) => c.accountKey).join('|'));
  useOpenChatFromNotification();
  return (
    <Tabs
      // Back from a tab returns to the tab you came from.
      backBehavior="history"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: t.brand,
        tabBarInactiveTintColor: t.muted,
        tabBarStyle: { backgroundColor: t.surface, borderTopColor: t.line },
        // Bigger targets: larger icons and labels, more padding per tab.
        tabBarLabelStyle: { fontSize: 13, fontWeight: '600' },
        tabBarItemStyle: { paddingTop: 6 },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Map', tabBarIcon: ({ color }) => <Icon name="map" color={color} size={28} /> }} />
      <Tabs.Screen
        name="chat"
        options={{ title: 'Chats', tabBarBadge: unread ? (unread > 9 ? '9+' : unread) : undefined, tabBarIcon: ({ color }) => <Icon name="chat" color={color} size={28} /> }}
      />
      <Tabs.Screen name="places" options={{ title: 'Places', tabBarIcon: ({ color }) => <Icon name="place" color={color} size={28} /> }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: ({ color }) => <Icon name="settings" color={color} size={28} /> }} />
    </Tabs>
  );
}
