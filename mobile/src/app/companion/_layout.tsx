import { useEffect, useState } from 'react';
import { ActivityIndicator, AppState, View } from 'react-native';
import { Stack, router } from 'expo-router';
import { useFonts, NotoNastaliqUrdu_600SemiBold } from '@expo-google-fonts/noto-nastaliq-urdu';
import { allClients, useCircles } from '../../lib/circle';
import { registerPush } from '../../lib/push';
import { ensureNotificationChannels, notifyNewMessages } from '../../lib/notify';
import { shareNow, startBackgroundUpdates } from '../../lib/location';
import { loadPages } from '../../companion/people';
import { C } from '../../companion/theme';

/**
 * The Elderly Companion app. While it's open: a live connection to each of
 * her circles, her location shared, and replies to her requests played as
 * they arrive. Closed, the same background location and push tasks as
 * HomeCircle take over.
 */
export default function CompanionLayout() {
  const [fonts] = useFonts({ NotoNastaliqUrdu_600SemiBold });
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
      shareNow('open').catch(() => {});
      registerPush().catch(() => {});
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

  if (!fonts || !pagesReady) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg }}>
        <ActivityIndicator color={C.green} size="large" />
      </View>
    );
  }
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: C.bg }, animation: 'fade' }} />;
}
