import { useCallback, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Button } from '../../components/ui';
import { FrequentSettings } from '../../components/FrequentSettings';
import { GroupBody, SettingsGroup, SettingsPage, ToggleRow } from '../../components/SettingsKit';
import { useCircles } from '../../lib/circle';
import { shareNow, startBackgroundUpdates, stopBackgroundUpdates, type SharingMode } from '../../lib/location';
import { updateSettings, useSettings } from '../../lib/storage';
import { useTheme } from '../../theme';

const INTERVALS = [5, 15, 30, 60];

export const SHARING_TEXT: Record<SharingMode, string> = {
  background: 'Sharing in the background',
  'foreground-only': 'Only while the app is open: allow “Always” for background updates',
  'no-permission': 'Location permission is off',
  off: 'Paused: your circles see that you paused',
};

/** Sharing on or off, how often, place alerts, and most visited places. */
export default function LocationSettings() {
  const t = useTheme();
  const settings = useSettings();
  const { clients } = useCircles();
  const [mode, setMode] = useState<SharingMode | null>(null);
  useFocusEffect(
    useCallback(() => {
      startBackgroundUpdates()
        .then(setMode)
        .catch(() => setMode(null));
    }, []),
  );

  const apply = async (patch: Parameters<typeof updateSettings>[0]) => {
    const next = await updateSettings(patch);
    if (next.sharing) setMode(await startBackgroundUpdates());
    else {
      await stopBackgroundUpdates();
      setMode('off');
    }
    // Turning sharing off tells each circle you paused; turning it on shares now.
    if (patch.sharing === false) {
      await Promise.allSettled(clients.filter((c) => !next.pausedCircles.includes(c.circleId!)).map((c) => c.pauseSharing()));
    } else if (patch.sharing === true) {
      shareNow('manual').catch(() => {});
    }
  };

  return (
    <SettingsPage title="Location sharing">
      <SettingsGroup footer="How much each circle sees (exact, approximate or paused) is under Your circles.">
        <ToggleRow title="Share my location" detail={mode ? SHARING_TEXT[mode] : undefined} value={!!settings.sharing} onChange={(v) => apply({ sharing: v })} />
        {mode === 'foreground-only' || mode === 'no-permission' ? (
          <GroupBody>
            <Button small title="Fix permissions" onPress={() => router.push('/permissions')} />
          </GroupBody>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="Update about every" footer="It also updates when you move a lot, arrive at a place, or someone taps Locate. Longer intervals save battery.">
        <GroupBody>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {INTERVALS.map((n) => {
              const on = settings.intervalMinutes === n;
              return (
                <Pressable
                  key={n}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  onPress={() => apply({ intervalMinutes: n })}
                  style={{ flex: 1, alignItems: 'center', minHeight: 44, justifyContent: 'center', borderRadius: 10, borderWidth: 1, borderColor: on ? t.brand : t.line, backgroundColor: on ? t.brandSoft : 'transparent' }}
                >
                  <Text style={{ color: on ? t.brand : t.text, fontWeight: '600' }}>{n} min</Text>
                </Pressable>
              );
            })}
          </View>
          <Button small title="Share my location now" onPress={() => shareNow('manual').then((ok) => !ok && Alert.alert('Couldn’t get your location', 'Check that location is allowed.'))} />
        </GroupBody>
      </SettingsGroup>

      {clients.some((c) => c.feature('placeAlerts')) ? (
        <SettingsGroup title="Place alerts">
          <ToggleRow
            title="Announce my arrivals"
            detail={
              settings.announcePlaces
                ? 'Your circles’ chats get “Sam arrived at Home” when you arrive at or leave a place.'
                : 'Your phone won’t post when you arrive or leave. Your location still shows on the map.'
            }
            value={settings.announcePlaces}
            onChange={(v) => updateSettings({ announcePlaces: v })}
          />
          <ToggleRow
            title="Show others’ arrivals"
            detail={settings.showPlaceAlerts ? 'You see and get notified when others arrive or leave.' : 'Hidden on this phone, and no notifications. Others still see them.'}
            value={settings.showPlaceAlerts}
            onChange={(v) => updateSettings({ showPlaceAlerts: v })}
          />
        </SettingsGroup>
      ) : null}

      {clients.some((c) => c.feature('frequentPlaces')) ? <FrequentSettings clients={clients} settings={settings} onChange={() => {}} /> : null}
    </SettingsPage>
  );
}
