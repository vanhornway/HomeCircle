import { useEffect, useState } from 'react';
import { AppState, Linking, Platform, Text, View } from 'react-native';
import * as Location from 'expo-location';
import { Button, Card, H1, P, Screen } from '../components/ui';
import { notificationPermission, registerPush } from '../lib/push';
import { batteryUnrestricted, requestBatteryExemption } from '../lib/health';
import { startBackgroundUpdates, shareNow } from '../lib/location';
import { enterApp } from '../lib/nav';
import { useSettings } from '../lib/storage';
import { HowThisWorks } from '../components/HowThisWorks';
import { router } from 'expo-router';
import { useTheme } from '../theme';

type Status = 'granted' | 'denied' | 'undetermined';

/**
 * Everything the phone can be asked for, in one place. Joining asks for
 * location, Chats asks for notifications and Setup check asks for background
 * running; this is for when one was refused or needs another look (Settings →
 * Location sharing → Fix permissions).
 */
export default function Permissions() {
  const t = useTheme();
  const settings = useSettings();
  const [fg, setFg] = useState<Status>('undetermined');
  const [bg, setBg] = useState<Status>('undetermined');
  const [notif, setNotif] = useState<Status>('undetermined');
  // Android only: null where it doesn't apply or can't be read.
  const [battery, setBattery] = useState<boolean | null>(null);

  const refresh = async () => {
    const [f, b, n, bat] = await Promise.all([
      Location.getForegroundPermissionsAsync(),
      Location.getBackgroundPermissionsAsync(),
      notificationPermission(),
      batteryUnrestricted(),
    ]);
    setBattery(bat);
    setFg(f.status as Status);
    setBg(b.status as Status);
    setNotif(n);
  };
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => s === 'active' && refresh());
    const first = setTimeout(refresh, 0);
    return () => {
      clearTimeout(first);
      sub.remove();
    };
  }, []);

  const askLocation = async () => {
    const f = await Location.requestForegroundPermissionsAsync();
    if (f.status !== 'granted') {
      if (!f.canAskAgain) Linking.openSettings();
      return refresh();
    }
    shareNow('manual').catch(() => {});
    const b = await Location.requestBackgroundPermissionsAsync();
    if (b.status !== 'granted' && !b.canAskAgain) Linking.openSettings();
    await refresh();
  };

  const finish = async () => {
    await startBackgroundUpdates().catch(() => {});
    if (router.canGoBack()) router.back();
    else enterApp();
  };

  const row = (title: string, body: string, status: Status, action: () => void, actionTitle: string, how?: string) => (
    <Card style={{ marginBottom: 14 }}>
      <Text style={{ color: t.text, fontWeight: '700', fontSize: 17 }}>{title}</Text>
      <Text style={{ color: t.muted, fontSize: 15, lineHeight: 21, marginTop: 4, marginBottom: how ? 0 : 12 }}>{body}</Text>
      {how ? <HowThisWorks style={{ marginBottom: 4 }}>{how}</HowThisWorks> : null}
      {status === 'granted' ? (
        <Text style={{ color: t.ok, fontWeight: '600' }}>✓ Allowed</Text>
      ) : (
        <Button title={actionTitle} small onPress={action} />
      )}
    </Card>
  );

  const alwaysLabel = Platform.OS === 'ios' ? 'Change to “Always”' : 'Allow all the time';
  return (
    <Screen>
      <H1 style={{ marginTop: 12 }}>Phone permissions</H1>
      <P muted style={{ marginTop: 8, marginBottom: 22 }}>
        You can pause sharing any time in Settings.
      </P>
      {row(
        'Location',
        'So your family can see you on the map. Choose “Always” so updates keep working when the app is closed.',
        bg === 'granted' ? 'granted' : fg === 'granted' ? 'undetermined' : fg,
        fg === 'granted' ? () => Linking.openSettings() : askLocation,
        fg === 'granted' ? alwaysLabel : 'Allow location',
        'With the app closed, your location is shared about every 15 minutes, or when someone asks. It only goes to your circle, encrypted.',
      )}
      {row(
        'Notifications',
        settings.showPreviews
          ? 'For new messages and arrival alerts. They show who wrote and what they said. You can hide that in Settings → Notifications.'
          : 'For new messages and arrival alerts. Message text stays hidden.',
        notif,
        async () => {
          await registerPush({ ask: true });
          refresh();
        },
        'Allow notifications',
        'The push service that wakes your phone never sees your messages or locations. This phone decrypts them before showing anything.',
      )}
      {Platform.OS === 'android' && battery !== null
        ? row(
            'Keep running in the background',
            'Choose “Allow” so Android lets HomeCircle wake up when your phone is locked.',
            battery ? 'granted' : 'undetermined',
            async () => {
              await requestBatteryExemption();
              refresh();
            },
            'Allow',
            'Otherwise message sounds can wait until you pick the phone up.',
          )
        : null}
      <View style={{ height: 8 }} />
      <Button title={fg === 'granted' ? 'Done' : 'Not now'} variant={fg === 'granted' ? 'primary' : 'default'} onPress={finish} />
    </Screen>
  );
}
