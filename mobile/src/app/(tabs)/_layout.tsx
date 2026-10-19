import { useEffect } from 'react';
import { AppState } from 'react-native';
import { Tabs } from 'expo-router/js-tabs';
import { router } from 'expo-router';
import { getClient } from '../../lib/circle';
import { registerPush } from '../../lib/push';
import { shareNow, startBackgroundUpdates, syncGeofences } from '../../lib/location';
import { updateSettings } from '../../lib/storage';
import { Icon } from '../../components/ui';
import { useTheme } from '../../theme';
import { CircleClient } from '@homecircle/core';

/**
 * While the app is open: live WebSocket + fresh data. In the background the
 * socket is closed — the OS location/geofence/push tasks take over.
 */
function useCircleLifecycle() {
  useEffect(() => {
    const client = getClient();
    let alive = true;
    const offs = [
      client.on('locationRequest', () => shareNow('requested').catch(() => {})),
      client.on('places', (places) => syncGeofences(places.values()).catch(() => {})),
      client.on('removed', () => router.replace('/welcome')),
    ];
    const resume = async () => {
      try {
        await client.start();
        shareNow('open').catch(() => {});
      } catch (e: any) {
        if (e?.status === 401) {
          await client.signOut();
          router.replace('/welcome');
        }
      }
    };
    (async () => {
      await resume();
      if (!alive) return;
      registerPush().catch(() => {});
      startBackgroundUpdates().catch(() => {});
      syncGeofences(client.places.values()).catch(() => {});
      if (client.serverUrl) {
        CircleClient.serverInfo(client.serverUrl)
          .then((i) => updateSettings({ tileUrl: i.tileUrl, tileAttribution: i.tileAttribution }))
          .catch(() => {});
      }
    })();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') resume();
      else if (state === 'background') client.disconnect();
    });
    return () => {
      alive = false;
      offs.forEach((off) => off());
      sub.remove();
      client.disconnect();
    };
  }, []);
}

export default function TabsLayout() {
  const t = useTheme();
  useCircleLifecycle();
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
      <Tabs.Screen name="chat" options={{ title: 'Chat', tabBarIcon: ({ color }) => <Icon name="chat" color={color} /> }} />
      <Tabs.Screen name="places" options={{ title: 'Places', tabBarIcon: ({ color }) => <Icon name="place" color={color} /> }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: ({ color }) => <Icon name="settings" color={color} /> }} />
    </Tabs>
  );
}
