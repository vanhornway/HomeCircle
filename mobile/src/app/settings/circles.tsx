import { useState } from 'react';
import { Alert, Modal, Pressable, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { Button } from '../../components/ui';
import { ServerPicker } from '../../components/ServerPicker';
import { GroupBody, SettingsGroup, SettingsPage } from '../../components/SettingsKit';
import { errorText, serverGroups, setActiveCircle, useCircles } from '../../lib/circle';
import { shareNow, syncGeofences } from '../../lib/location';
import { getSettings, updateSettings, useSettings } from '../../lib/storage';
import { unreadInCircle } from '../../lib/unread';
import { useCircle } from '../../lib/useCircle';
import { useTheme } from '../../theme';

type Precision = 'exact' | 'approximate' | 'paused';

/** Every circle on this phone: open one, and choose how much each sees of where you are. */
export default function CirclesSettings() {
  const t = useTheme();
  const client = useCircle();
  const { clients } = useCircles();
  const settings = useSettings();
  // One server at a time: the one picked, else the open circle's.
  const [picked, setPicked] = useState<string | null>(null);
  const servers = serverGroups(clients);
  const shown = servers.find((g) => g.url === picked) ?? servers.find((g) => g.url === client.serverUrl) ?? servers[0];
  const [pausing, setPausing] = useState<(typeof clients)[number] | null>(null);
  const [reason, setReason] = useState('');

  const precisionOf = (id: string): Precision => (settings.pausedCircles.includes(id) ? 'paused' : settings.approximateCircles.includes(id) ? 'approximate' : 'exact');
  const setPrecision = async (target: (typeof clients)[number], mode: Precision, why = '') => {
    const id = target.circleId!;
    const s = await getSettings();
    const paused = new Set(s.pausedCircles);
    const approx = new Set(s.approximateCircles);
    const reasons = { ...s.pauseReasons };
    paused.delete(id);
    approx.delete(id);
    delete reasons[id];
    if (mode === 'paused') {
      paused.add(id);
      if (why.trim()) reasons[id] = why.trim().slice(0, 80);
    }
    if (mode === 'approximate') approx.add(id);
    await updateSettings({ pausedCircles: [...paused], approximateCircles: [...approx], pauseReasons: reasons });
    syncGeofences().catch(() => {});
    if (mode === 'paused') target.pauseSharing(why).catch((e) => Alert.alert('Couldn’t pause sharing', errorText(e)));
    else shareNow('manual').catch(() => {});
  };

  return (
    <SettingsPage title="Your circles">
      {shown && servers.length > 1 ? (
        <View style={{ marginTop: 16 }}>
          <ServerPicker groups={servers} value={shown.url} onChange={setPicked} />
        </View>
      ) : null}
      <SettingsGroup footer="Each circle is separate: its own people, map, chat and encryption key. Nobody sees anything from a circle they’re not in.">
        {(shown?.circles ?? clients).map((c) => {
          const active = c === client;
          const precision = precisionOf(c.circleId!);
          const why = settings.pauseReasons[c.circleId!];
          const n = unreadInCircle(c);
          return (
            <GroupBody key={c.accountKey} gap={8}>
              <Pressable accessibilityRole="button" accessibilityState={{ selected: active }} onPress={() => setActiveCircle(c.accountKey)}>
                <Text style={{ color: active ? t.brand : t.text, fontSize: 16, fontWeight: '600' }} numberOfLines={1}>
                  {active ? '✓ ' : ''}
                  {c.circle.name}
                  {n ? `  (${n} new)` : ''}
                </Text>
                <Text style={{ color: t.muted, fontSize: 13 }} numberOfLines={2}>
                  {precision === 'exact' ? 'Sees your exact location' : precision === 'approximate' ? 'Sees only your approximate area (about 1 km)' : `Paused${why ? `: “${why}”` : ''}. They see that you paused`}
                  {active || clients.length < 2 ? '' : ' · tap to open'}
                </Text>
              </Pressable>
              <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', borderRadius: 12, borderWidth: 1, borderColor: t.line, overflow: 'hidden' }}>
                {(['exact', 'approximate', 'paused'] as const).map((mode) => {
                  const on = precision === mode;
                  return (
                    <Pressable
                      key={mode}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: on }}
                      accessibilityLabel={`${mode} location for ${c.circle.name}`}
                      onPress={() => {
                        if (on) return;
                        if (mode === 'paused') {
                          setReason('');
                          setPausing(c);
                        } else setPrecision(c, mode);
                      }}
                      style={{ flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? t.brandSoft : 'transparent' }}
                    >
                      <Text style={{ color: on ? t.brand : t.text, fontWeight: on ? '700' : '500', fontSize: 15 }}>{mode === 'exact' ? 'Exact' : mode === 'approximate' ? 'Approximate' : 'Paused'}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </GroupBody>
          );
        })}
        <GroupBody>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {shown?.circles.some((c) => c.isServerAdmin) ? (
              <Button small title="New circle" onPress={() => router.push({ pathname: '/new-circle', params: { server: shown.url } })} style={{ flex: 1 }} />
            ) : null}
            <Button small title="Join a circle" onPress={() => router.push('/join')} style={{ flex: 1 }} />
          </View>
        </GroupBody>
      </SettingsGroup>

      <Modal visible={!!pausing} transparent animationType="fade" onRequestClose={() => setPausing(null)}>
        <Pressable onPress={() => setPausing(null)} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', padding: 24 }}>
          <Pressable onPress={() => {}} style={{ backgroundColor: t.surface, borderRadius: 20, padding: 18, gap: 12 }}>
            <Text style={{ color: t.text, fontSize: 18, fontWeight: '700' }}>Pause sharing with {pausing?.circle.name}?</Text>
            <Text style={{ color: t.muted, fontSize: 14, lineHeight: 20 }}>They’ll see “Paused” instead of where you are, and Locate won’t reach you. Add a reason if you like.</Text>
            <TextInput
              value={reason}
              onChangeText={setReason}
              placeholder="e.g. At the doctor (optional)"
              placeholderTextColor={t.muted}
              maxLength={80}
              style={{ minHeight: 52, borderRadius: 12, borderWidth: 1, borderColor: t.line, paddingHorizontal: 14, fontSize: 17, color: t.text, backgroundColor: t.bg }}
            />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Button title="Cancel" onPress={() => setPausing(null)} style={{ flex: 1 }} />
              <Button
                title="Pause"
                variant="primary"
                onPress={() => {
                  if (pausing) setPrecision(pausing, 'paused', reason);
                  setPausing(null);
                }}
                style={{ flex: 1 }}
              />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </SettingsPage>
  );
}
