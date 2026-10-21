import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { randomId, type CircleClient } from '@homecircle/core';
import { Button } from './ui';
import { updateSettings, getSettings, type AlertRule } from '../lib/storage';
import { useTheme } from '../theme';

const WHEN: { on: AlertRule['on']; label: string }[] = [
  { on: 'arrived', label: 'Arrives' },
  { on: 'left', label: 'Leaves' },
  { on: 'both', label: 'Arrives or leaves' },
];

/**
 * "Notify me when <person> arrives at / leaves <place>". Saved on this phone
 * only; it matches the arrive/leave messages that person's phone posts.
 */
export function AlertRuleSheet({
  clients,
  initialClient,
  initialMember,
  visible,
  onClose,
}: {
  clients: CircleClient[];
  initialClient?: CircleClient;
  initialMember?: string;
  visible: boolean;
  onClose: () => void;
}) {
  const t = useTheme();
  const [client, setClient] = useState<CircleClient | undefined>(initialClient ?? clients[0]);
  const [member, setMember] = useState<string | undefined>(initialMember);
  const [place, setPlace] = useState<string | undefined>();
  const [on, setOn] = useState<AlertRule['on']>('both');
  const [busy, setBusy] = useState(false);

  const people = client?.memberList().filter((m) => !m.isMe) ?? [];
  const places = client ? [...client.places.values()].sort((a, b) => a.name.localeCompare(b.name)) : [];

  const chip = (selected: boolean) => ({
    minHeight: 44,
    paddingHorizontal: 16,
    justifyContent: 'center' as const,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: selected ? t.brand : t.line,
    backgroundColor: selected ? t.brandSoft : 'transparent',
  });
  const chipText = (selected: boolean) => ({ color: selected ? t.brand : t.text, fontWeight: '600' as const, fontSize: 15 });
  const label = { color: t.muted, fontSize: 13, fontWeight: '700' as const, marginTop: 14, marginBottom: 8 };

  const save = async () => {
    if (!client?.circleId || !member || !place) return;
    setBusy(true);
    const s = await getSettings();
    await updateSettings({ alertRules: [...s.alertRules, { id: randomId(6), circleId: client.circleId, memberId: member, placeId: place, on }] });
    setBusy(false);
    setPlace(undefined);
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' }}>
        <Pressable onPress={() => {}} style={{ backgroundColor: t.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22, maxHeight: '85%' }}>
          <SafeAreaView edges={['bottom']}>
            <ScrollView contentContainerStyle={{ padding: 18 }}>
              <Text style={{ color: t.text, fontSize: 20, fontWeight: '700' }}>Notify me when…</Text>
              {clients.length > 1 ? (
                <>
                  <Text style={label}>CIRCLE</Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                    {clients.map((c) => (
                      <Pressable
                        key={c.accountKey}
                        style={chip(c === client)}
                        onPress={() => {
                          setClient(c);
                          setMember(undefined);
                          setPlace(undefined);
                        }}
                      >
                        <Text style={chipText(c === client)}>{c.circle.name}</Text>
                      </Pressable>
                    ))}
                  </View>
                </>
              ) : null}
              <Text style={label}>PERSON</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {people.map((m) => (
                  <Pressable key={m.id} style={chip(m.id === member)} onPress={() => setMember(m.id)}>
                    <Text style={chipText(m.id === member)}>{m.name}</Text>
                  </Pressable>
                ))}
                {!people.length ? <Text style={{ color: t.muted }}>No one else in this circle yet.</Text> : null}
              </View>
              <Text style={label}>WHEN THEY</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {WHEN.map((w) => (
                  <Pressable key={w.on} style={chip(w.on === on)} onPress={() => setOn(w.on)}>
                    <Text style={chipText(w.on === on)}>{w.label}</Text>
                  </Pressable>
                ))}
              </View>
              <Text style={label}>PLACE</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {places.map((p) => (
                  <Pressable key={p.id} style={chip(p.id === place)} onPress={() => setPlace(p.id)}>
                    <Text style={chipText(p.id === place)}>{p.name}</Text>
                  </Pressable>
                ))}
                {!places.length ? <Text style={{ color: t.muted }}>This circle has no places yet. Add one in Places.</Text> : null}
              </View>
              <Text style={{ color: t.muted, fontSize: 13, marginTop: 14, lineHeight: 18 }}>
                You’ll get a notification even if place alerts are hidden. It works when their phone announces arrivals and departures.
              </Text>
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
                <Button title="Cancel" onPress={onClose} style={{ flex: 1 }} />
                <Button title="Save alert" variant="primary" loading={busy} disabled={!member || !place} onPress={save} style={{ flex: 1 }} />
              </View>
            </ScrollView>
          </SafeAreaView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
