import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import { AppState } from 'react-native';
import { Tabs } from 'expo-router/js-tabs';
import { router, useRouter } from 'expo-router';
import { CircleClient } from '@homecircle/core';
import { allClients, clientForCircle, errorText, getClient, useCircles } from '../../lib/circle';
import { getServerState, isUnreachable, RECONNECT_GRACE_MS, setRetryHandler, setServerState } from '../../lib/connection';
import { registerPush } from '../../lib/push';
import { ensureNotificationChannels, markSeen, notifyNewMessages } from '../../lib/notify';
import { ensureReadBase, unreadInCircle } from '../../lib/unread';
import { useAllCircles } from '../../lib/useCircle';
import { shareNow, startBackgroundUpdates, syncGeofences } from '../../lib/location';
import { flushOutbox } from '../../lib/places';
import { diag } from '../../lib/diagnostics';
import { checkForUpdate, downloadUpdate } from '../../lib/updates';
import { applyMyChirp, collectAndPlay, playChirps } from '../../lib/chirp';
import { phoneHealth } from '../../lib/health';
import { updateSettings, useSettings } from '../../lib/storage';
import { Icon } from '../../components/ui';
import { useTheme } from '../../theme';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `fn` over `items`, at most `limit` at a time. */
async function inBatches<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) await fn(item);
    }),
  );
}

/**
 * While the app is open: a live WebSocket + fresh data for every circle this
 * phone is in. In the background the sockets close and the OS location,
 * geofence and push tasks take over. The banner reflects the circle on screen;
 * if a server can't be reached, the app keeps working and retries (10 s, 20 s,
 * 40 s … up to 2 min) while it's in the foreground.
 *
 * Reconnecting after unlock is gentle on the servers and the phone: one
 * reconnect at a time, the circle on screen first, then the others two at a
 * time. For the first RECONNECT_GRACE_MS it shows "Reconnecting…", not an error.
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
        applyMyChirp(client).catch(() => {});
        // Everyone's most visited places (servers before 0.9 don't have them).
        client.fetchFrequent().catch(() => {});
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
        if (e?.status === 401) diag('server:unrecognized', { via: 'http' });
        return e;
      }
    };

    let pushRegistered = false;
    const resumeOnce = async () => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      const t0 = Date.now();
      const active = getClient();
      // "Reconnecting…" only when the circle on screen is actually offline:
      // a retry for another circle that can't be reached shouldn't flash it.
      if (active.status !== 'online') setServerState({ reconnectingSince: t0 });
      const results = new Map<CircleClient, any>();

      // The circle on screen first. If it fails right after unlocking (the
      // network is often still waking up), try once more when the grace
      // period ends before showing an error.
      let activeError = await startOne(active);
      if (activeError && activeError.status !== 401 && alive) {
        await sleep(Math.max(0, t0 + RECONNECT_GRACE_MS - Date.now()));
        if (alive) activeError = await startOne(active);
      }
      if (!alive) return;
      results.set(active, activeError);
      const activeMs = Date.now() - t0;
      if (activeError?.status === 401) {
        setServerState({ reachable: true, error: null, retrying: false, unrecognized: true, reconnectingSince: null });
      } else if (activeError) {
        setServerState({ reachable: false, error: isUnreachable(activeError) ? null : errorText(activeError), unrecognized: false, reconnectingSince: null });
      } else {
        setServerState({ reachable: true, error: null, retrying: false, unrecognized: false, reconnectingSince: null });
      }

      // Then what depends on being connected, once.
      shareNow('open').catch(() => {});
      syncGeofences().catch(() => {});
      // Anything that couldn't be posted while offline goes out now.
      flushOutbox().catch(() => 0);
      // Chirps that arrived while the app was closed and no push got through.
      collectAndPlay(allClients()).catch(() => {});
      if (!pushRegistered) {
        pushRegistered = true;
        registerPush().catch(() => {
          pushRegistered = false;
        });
      }

      // The other circles, two at a time, so unlocking doesn't send every
      // request for every circle at once.
      await inBatches(
        allClients().filter((c) => c !== active),
        2,
        async (c) => {
          if (alive) results.set(c, await startOne(c));
        },
      );
      if (!alive) return;
      const failed = [...results].filter(([c, e]) => e && e.status !== 401 && allClients().includes(c));
      if (failed.length) scheduleRetry();
      else attempt = 0;
      phoneHealth()
        .then((h) => diag('app-open', { ...h, circles: allClients().length, failed: failed.length, activeMs, totalMs: Date.now() - t0 }))
        .catch(() => {});
    };

    // One reconnect at a time: unlocking twice, or Retry mid-way, waits for
    // the one in progress and then runs once more.
    let running: Promise<void> | null = null;
    let again = false;
    const resume = () => {
      if (running) {
        again = true;
        return running;
      }
      running = (async () => {
        try {
          do {
            again = false;
            await resumeOnce();
          } while (again && alive);
        } finally {
          running = null;
        }
      })();
      return running;
    };

    const offs = clients.flatMap((client) => [
      client.on('locationRequest', () => {
        diag('locate-request', { via: 'live' });
        shareNow('requested').catch(() => {});
      }),
      client.on('places', () => syncGeofences().catch(() => {})),
      client.on('newMessage', (m) => {
        notifyNewMessages(client, [m]).catch(() => {});
        // Someone's SOS while the app is open: show it right away.
        if (m.kind === 'chat' && !m.peer && m.body?.sos?.state === 'start') router.push({ pathname: '/sos', params: { circle: client.circleId!, member: m.from } });
      }),
      client.on('chirp', () => {
        client
          .collectChirps()
          .then((chirps) => playChirps(client, chirps, { multiCircle: allClients().length > 1 }))
          .catch(() => {});
      }),
      // The live socket reconnects by itself; reflect the circle on screen in
      // the banner. CircleClient catches up on missed data after a reconnect.
      client.on('status', (s) => {
        if (client !== getClient()) return;
        if (s === 'online') {
          if (!getServerState().reachable) setServerState({ reachable: true, error: null, retrying: false });
        } else if (s === 'offline' && AppState.currentState === 'active') {
          // Drops while reconnecting are expected; the reconnect reports the outcome.
          if (getServerState().reconnectingSince != null) return;
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

/** Tapping a message notification opens that conversation; an update one downloads it. */
function useOpenChatFromNotification() {
  const nav = useRouter();
  const response = Notifications.useLastNotificationResponse();
  useEffect(() => {
    const data = response?.notification.request.content.data as { t?: string; circle?: string; peer?: string } | undefined;
    if (data?.t === 'update') {
      downloadUpdate().catch(() => {});
      return;
    }
    if (data?.t === 'sos') {
      nav.push({ pathname: '/sos', params: { circle: data.circle ?? '', member: (data as { member?: string }).member ?? '' } });
      return;
    }
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
  // A newer app? Checked at most every 4 hours, on opening and coming back.
  useEffect(() => {
    checkForUpdate().catch(() => {});
    const sub = AppState.addEventListener('change', (s) => s === 'active' && checkForUpdate().catch(() => {}));
    return () => sub.remove();
  }, []);
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
