import { useEffect, useState } from 'react';
import { ActivityIndicator, AppState, View } from 'react-native';
import { Redirect, Stack, router } from 'expo-router';
import { SKINS, useSkin } from '../../skins';
import { syncSkinFromRecords } from '../../skins/sync';
import { setLanguage } from '../../companion/lines';
import { useFonts, NotoNastaliqUrdu_600SemiBold } from '@expo-google-fonts/noto-nastaliq-urdu';
import { allClients, useCircles } from '../../lib/circle';
import { registerPush } from '../../lib/push';
import { ensureNotificationChannels, notifyNewMessages } from '../../lib/notify';
import { shareNow, startBackgroundUpdates } from '../../lib/location';
import { loadPages, settingsOf } from '../../companion/people';
import { flushOutbox } from '../../companion/outbox';
import { C } from '../../companion/theme';

/**
 * The Elderly Companion app. While it's open: a live connection to each of
 * her circles, her location shared, and replies to her requests played as
 * they arrive. Closed, the same background location and push tasks as
 * HomeCircle take over.
 */
export default function CompanionLayout() {
  const [fonts] = useFonts({ NotoNastaliqUrdu_600SemiBold });
  const skin = useSkin();
  const [pagesReady, setPagesReady] = useState(false);
  const { version } = useCircles();

  useEffect(() => {
    loadPages().finally(() => setPagesReady(true));
  }, []);

  useEffect(() => {
    const clients = allClients();
    if (!clients.length) return;
    let alive = true;
    const resume = async () => {
      await ensureNotificationChannels().catch(() => {});
      for (const c of clients) {
        if (!alive) return;
        try {
          await c.start();
          // Replies that came while the app was closed and no push got through: play them now.
          await notifyNewMessages(c, c.messages);
        } catch {
          // Offline: the page still works from what's on the phone, and it tries again on the next open.
        }
      }
      syncSkinFromRecords(clients).catch(() => {});
      if (clients[0]) setLanguage(settingsOf(clients[0]).lang);
      shareNow('open').catch(() => {});
      registerPush().catch(() => {});
      // Requests that waited for the internet go out now.
      flushOutbox().catch(() => {});
    };
    startBackgroundUpdates().catch(() => {});
    resume();
    const offs = clients.flatMap((c) => [
      c.on('newMessage', (m) => {
        notifyNewMessages(c, [m]).catch(() => {});
      }),
      c.on('locationRequest', () => {
        shareNow('requested').catch(() => {});
      }),
      // An admin changed her settings: her skin may change too.
      c.on('records', () => {
        syncSkinFromRecords(clients).catch(() => {});
        setLanguage(settingsOf(c).lang);
      }),
      // Back online while open: send what waited.
      c.on('status', (s: string) => {
        if (s === 'online') flushOutbox().catch(() => {});
      }),
    ]);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') resume();
      else if (state === 'background') clients.forEach((c) => c.disconnect());
    });
    return () => {
      alive = false;
      offs.forEach((off) => off());
      sub.remove();
    };
  }, [version]);

  useEffect(() => {
    if (pagesReady && !allClients().length) router.replace('/join');
  }, [pagesReady, version]);

  // An admin switched this phone back to the full app.
  if (!SKINS[skin].locked) return <Redirect href={SKINS[skin].root} />;
  if (!fonts || !pagesReady) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg }}>
        <ActivityIndicator color={C.green} size="large" />
      </View>
    );
  }
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: C.bg }, animation: 'fade' }} />;
}
