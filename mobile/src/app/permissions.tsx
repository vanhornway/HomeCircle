import { useEffect, useState } from 'react';
import { AppState, Linking, Platform, Text, View } from 'react-native';
import * as Location from 'expo-location';
import { Button, Card, H1, P, Screen } from '../components/ui';
import { notificationPermission, registerPush } from '../lib/push';
import { batteryUnrestricted, requestBatteryExemption } from '../lib/health';
import { startBackgroundUpdates, shareNow } from '../lib/location';
import { enterApp } from '../lib/nav';
import { useTheme } from '../theme';

type Status = 'granted' | 'denied' | 'undetermined';

export default function Permissions() {
  const t = useTheme();
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
    enterApp();
  };

  const row = (title: string, body: string, status: Status, action: () => void, actionTitle: string) => (
    <Card style={{ marginBottom: 14 }}>
      <Text style={{ color: t.text, fontWeight: '700', fontSize: 17 }}>{title}</Text>
      <Text style={{ color: t.muted, fontSize: 15, lineHeight: 21, marginTop: 4, marginBottom: 12 }}>{body}</Text>
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
      <H1 style={{ marginTop: 12 }}>{Platform.OS === 'android' && battery !== null ? 'Three quick permissions' : 'Two quick permissions'}</H1>
      <P muted style={{ marginTop: 8, marginBottom: 22 }}>
        HomeCircle only shares with your circle, encrypted. You can pause sharing any time in Settings.
      </P>
      {row(
        'Location',
        'So your family can see you on the map. Choose “Always” so updates keep working when the app is closed — about every 15 minutes, or when someone asks.',
        bg === 'granted' ? 'granted' : fg === 'granted' ? 'undetermined' : fg,
        fg === 'granted' ? () => Linking.openSettings() : askLocation,
        fg === 'granted' ? alwaysLabel : 'Allow location',
      )}
      {row(
        'Notifications',
        'For new messages and arrival alerts. Notifications never contain your messages or locations — the app decrypts them when you open it.',
        notif,
        async () => {
          await registerPush({ ask: true });
          refresh();
        },
        'Allow notifications',
      )}
      {Platform.OS === 'android' && battery !== null
        ? row(
            'Keep running in the background',
            'Choose “Allow” so Android lets HomeCircle wake up when your phone is locked. Otherwise message sounds can wait until you pick the phone up.',
            battery ? 'granted' : 'undetermined',
            async () => {
              await requestBatteryExemption();
              refresh();
            },
            'Allow',
          )
        : null}
      <View style={{ height: 8 }} />
      <Button title={fg === 'granted' ? 'Continue' : 'Skip for now'} variant={fg === 'granted' ? 'primary' : 'default'} onPress={finish} />
    </Screen>
  );
}
