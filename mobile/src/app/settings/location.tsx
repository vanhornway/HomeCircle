import { useCallback, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Button, Tag } from '../../components/ui';
import { FrequentSettings } from '../../components/FrequentSettings';
import { StopSlider } from '../../components/StopSlider';
import { GroupBody, SettingsGroup, SettingsPage, ToggleRow } from '../../components/SettingsKit';
import { useCircles } from '../../lib/circle';
import { currentPolicy, shareNow, startBackgroundUpdates, stopBackgroundUpdates, type SharingMode } from '../../lib/location';
import { DEFAULT_STOP, STOPS, STOP_NAMES, describePolicy, type LocationValues, type Policy, type Stop } from '../../lib/locationPolicy';
import { locationProfileOf, updateSettings, useSettings } from '../../lib/storage';
import { useTheme } from '../../theme';

// What Advanced offers.
const MOVING_GAPS = [1, 2, 3, 5, 10, 15];
const STILL_INTERVALS = [15, 30, 60];
const BUDGETS = [1, 1.5, 2, 3, 4, 5];

// Why updates differ from the slider right now (the slider stays where you put it).
const CHIPS: Record<NonNullable<Policy['reason']>, string> = {
  charging: 'Charging: full detail until you unplug',
  saver: 'Battery Saver is on: using Longest battery until it’s off',
  low: 'Battery is low: using Longest battery until it’s charged',
  budget: 'Near today’s battery budget: moving updates slowed',
};

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
  const params = useLocalSearchParams<{ view?: string }>();
  const view = params.view === 'advanced' || params.view === 'basic' ? params.view : settings.locationView;
  const [mode, setMode] = useState<SharingMode | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  useFocusEffect(
    useCallback(() => {
      startBackgroundUpdates()
        .then(setMode)
        .catch(() => setMode(null));
      currentPolicy().then(setPolicy).catch(() => {});
    }, []),
  );
  const profile = locationProfileOf(settings);
  const values: LocationValues = profile === 'custom' ? settings.location : STOPS[profile];

  // A stop writes its values into Advanced; editing Advanced makes it custom.
  const chooseStop = (stop: Stop) => apply({ locationProfile: stop, location: { ...settings.location, ...STOPS[stop] } });
  const setValue = (patch: Partial<LocationValues>) => apply({ locationProfile: 'custom', location: { ...settings.location, ...values, ...patch } });
  const setView = (v: 'basic' | 'advanced') => {
    router.setParams({ view: v });
    updateSettings({ locationView: v });
  };

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
    currentPolicy().then(setPolicy).catch(() => {});
  };

  const choice = (options: number[], value: number, unit: string, onPick: (n: number) => void) => (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {options.map((n) => {
        const on = value === n;
        return (
          <Pressable
            key={n}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            onPress={() => onPick(n)}
            style={{ minWidth: 64, alignItems: 'center', minHeight: 44, justifyContent: 'center', paddingHorizontal: 10, borderRadius: 10, borderWidth: 1, borderColor: on ? t.brand : t.line, backgroundColor: on ? t.brandSoft : 'transparent' }}
          >
            <Text style={{ color: on ? t.brand : t.text, fontWeight: '600' }}>
              {n}
              {unit}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
  const label = (text: string) => <Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>{text}</Text>;

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

      <View accessibilityRole="tablist" style={{ flexDirection: 'row', marginTop: 22, borderRadius: 12, borderWidth: 1, borderColor: t.line, overflow: 'hidden' }}>
        {(['basic', 'advanced'] as const).map((v) => (
          <Pressable
            key={v}
            accessibilityRole="tab"
            accessibilityState={{ selected: view === v }}
            onPress={() => setView(v)}
            style={{ flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: view === v ? t.brandSoft : t.surface }}
          >
            <Text style={{ color: view === v ? t.brand : t.text, fontWeight: '700' }}>{v === 'basic' ? 'Basic' : 'Advanced'}</Text>
          </Pressable>
        ))}
      </View>

      {view === 'basic' ? (
        <SettingsGroup title="Location updates" footer="Locate, SOS, arrivals and departures are always sent right away.">
          <GroupBody gap={12}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ color: t.text, fontSize: 18, fontWeight: '700' }}>{profile === 'custom' ? 'Custom' : STOP_NAMES[profile]}</Text>
              {profile === DEFAULT_STOP ? <Tag label="Recommended" /> : null}
            </View>
            <StopSlider value={profile === 'custom' ? null : profile} onChange={chooseStop} />
            <Text style={{ color: t.text, fontSize: 15, lineHeight: 21 }}>
              Your circle sees you about {describePolicy({ movingGapMs: values.movingGapMin * 60_000, stillIntervalMs: values.stillIntervalMin * 60_000 }).replace('while moving', 'while you’re moving').replace('when still', 'when you’re still')}.
            </Text>
            <Text style={{ color: t.muted, fontSize: 14 }}>Uses at most about {values.budgetPct}% of your battery a day.</Text>
            {policy?.reason ? (
              <View style={{ alignSelf: 'flex-start', backgroundColor: t.brandSoft, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 }}>
                <Text style={{ color: t.brand, fontSize: 13, fontWeight: '600' }}>{CHIPS[policy.reason]}</Text>
              </View>
            ) : null}
            <Button small title="Share my location now" onPress={() => shareNow('manual').then((ok) => !ok && Alert.alert('Couldn’t get your location', 'Check that location is allowed.'))} />
          </GroupBody>
        </SettingsGroup>
      ) : (
        <>
          <SettingsGroup title="Updates" footer="Changing these shows “Custom” in Basic. Locate, SOS, arrivals and departures are always sent right away.">
            <GroupBody gap={10}>
              {label('While moving, at most every')}
              {choice(MOVING_GAPS, values.movingGapMin, ' min', (n) => setValue({ movingGapMin: n }))}
              {label('While still, every')}
              {choice(STILL_INTERVALS, values.stillIntervalMin, ' min', (n) => setValue({ stillIntervalMin: n }))}
            </GroupBody>
            <ToggleRow
              title="Slow down after an hour in one place"
              detail="After an hour within about 100 m, updates while still come hourly."
              value={values.slowWhenStill}
              onChange={(v) => setValue({ slowWhenStill: v })}
            />
            <ToggleRow
              title="Pause location checks when still"
              detail="After 10 minutes without moving, location is checked every 10 minutes instead of every minute, until you move."
              value={values.stillMode}
              onChange={(v) => setValue({ stillMode: v })}
            />
          </SettingsGroup>
          <SettingsGroup title="Battery">
            <GroupBody gap={10}>
              {label('Daily battery budget')}
              {choice(BUDGETS, values.budgetPct, '%', (n) => setValue({ budgetPct: n }))}
              <Text style={{ color: t.muted, fontSize: 13, lineHeight: 18 }}>Near it, moving updates slow down for the rest of the day. Charging starts it again.</Text>
            </GroupBody>
            <ToggleRow
              title="Full detail while charging"
              detail="Updates every 30 seconds while moving, using GPS, until you unplug."
              value={settings.location.fullDetailCharging}
              onChange={(v) => apply({ location: { ...settings.location, fullDetailCharging: v } })}
            />
            <ToggleRow
              title="Save more with Battery Saver"
              detail="With Battery Saver on, or under 20% battery, use Longest battery until it’s off or charged."
              value={settings.location.saveWithBatterySaver}
              onChange={(v) => apply({ location: { ...settings.location, saveWithBatterySaver: v } })}
            />
          </SettingsGroup>
        </>
      )}

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

      {clients.some((c) => c.feature('homeAssistant')) ? (
        <SettingsGroup title="Home Assistant">
          <ToggleRow
            title="Send my location to Home Assistant"
            detail={
              settings.sendToHomeAssistant
                ? 'Your circle’s Home Assistant gets your location with each update, so it can start automations (like lights on when you get home).'
                : 'Your circle’s Home Assistant doesn’t get your location. Your circle still sees it on the map.'
            }
            value={settings.sendToHomeAssistant}
            onChange={(v) => updateSettings({ sendToHomeAssistant: v })}
          />
        </SettingsGroup>
      ) : null}

      {clients.some((c) => c.feature('frequentPlaces')) ? <FrequentSettings clients={clients} settings={settings} onChange={() => {}} /> : null}
    </SettingsPage>
  );
}
