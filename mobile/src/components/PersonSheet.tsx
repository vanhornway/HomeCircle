import { useState } from 'react';
import { Alert, Modal, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { CircleClient } from '@homecircle/core';
import { Avatar, Icon } from './ui';
import { AlertRuleSheet } from './AlertRuleSheet';
import { errorText } from '../lib/circle';
import { chirpWithChoice } from '../lib/chirp';
import { KIND_EMOJI } from '../lib/visits';
import { canLocate, locatePerson, locateState, openDirections, statusLine, useLocateVersion } from '../lib/people';
import { timeAgo } from '../lib/useCircle';
import { useTheme } from '../theme';

/** Everything you can do about one person, in a bottom sheet. */
export function PersonSheet({ client, memberId, onClose }: { client: CircleClient; memberId: string | null; onClose: () => void }) {
  const t = useTheme();
  useLocateVersion();
  const [alerting, setAlerting] = useState(false);
  const [checking, setChecking] = useState(false);
  const m = memberId ? client.members.get(memberId) : null;
  const loc = m ? client.locations.get(m.id) : undefined;
  const paused = m ? client.paused.get(m.id) : undefined;
  const state = m ? locateState(client, m.id) : 'idle';

  const go = (fn: () => void) => () => {
    onClose();
    fn();
  };

  const tile = (icon: string, label: string, sub: string | null, onPress: () => void, disabled = false) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      accessibilityLabel={sub ? `${label}. ${sub}` : label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        width: '48%',
        minHeight: 76,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: t.line,
        backgroundColor: pressed ? t.surface2 : t.bg,
        padding: 12,
        gap: 4,
        opacity: disabled ? 0.45 : 1,
      })}
    >
      <Icon name={icon} color={t.brand} size={24} />
      <Text style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>{label}</Text>
      {sub ? (
        <Text style={{ color: t.muted, fontSize: 12 }} numberOfLines={1}>
          {sub}
        </Text>
      ) : null}
    </Pressable>
  );

  const askCheckIn = async () => {
    if (!m) return;
    setChecking(true);
    try {
      await client.askToCheckIn(m.id);
      onClose();
      router.push({ pathname: '/conversation', params: { circle: client.circleId!, peer: m.id } });
    } catch (e) {
      Alert.alert('Couldn’t send it', errorText(e));
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <Modal visible={!!m && !alerting} animationType="slide" transparent onRequestClose={onClose}>
        <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.3)', justifyContent: 'flex-end' }}>
          {m ? (
            <Pressable onPress={() => {}} style={{ backgroundColor: t.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22 }}>
              <SafeAreaView edges={['bottom']} style={{ padding: 18, gap: 14 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <Avatar name={m.name} color={m.color} size={52} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: t.text, fontSize: 20, fontWeight: '700' }}>{m.name}</Text>
                    <Text style={{ color: t.muted, fontSize: 14, marginTop: 2 }}>{statusLine(client, m)}</Text>
                  </View>
                </View>
                {m.isMe ? (
                  <Text style={{ color: t.muted, fontSize: 14 }}>This is you. Change how you share, and your most visited places, in Settings.</Text>
                ) : (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 10 }}>
                    {/* Only what this circle has on. */}
                    {client.feature('locationSharing') &&
                      tile(
                        'navigate',
                        'Directions',
                        loc ? `Location from ${timeAgo(loc.ts)}` : paused ? 'Sharing is paused' : 'No location yet',
                        () => loc && openDirections(m.name, loc, () => locatePerson(client, m.id)),
                        !loc,
                      )}
                    {client.feature('locate') &&
                      tile(
                        'locate',
                        'Locate',
                        state === 'sent'
                          ? 'Sent · waiting for their phone…'
                          : state === 'delivered'
                            ? 'Delivered · locating…'
                            : state === 'updated'
                              ? 'Updated just now'
                              : state === 'no-reply'
                                ? 'No reply yet · try again'
                                : state === 'cooldown'
                                  ? 'Asked recently'
                                  : 'Get a fresh location',
                        () => locatePerson(client, m.id),
                        !!paused || !canLocate(state),
                      )}
                    {client.feature('checkIns') && tile('checkin', checking ? 'Sending…' : 'Check in', 'Ask “where are you?”', askCheckIn, checking)}
                    {client.feature('directMessages') &&
                      tile('chat', 'Message', 'Only you two can read it', go(() => router.push({ pathname: '/conversation', params: { circle: client.circleId!, peer: m.id } })))}
                    {client.feature('placeAlerts') && tile('bell', 'Alert me', 'When they arrive or leave', () => setAlerting(true))}
                    {client.feature('chirps') && tile('bird', 'Chirp', 'A sound they’ll know is you', go(() => chirpWithChoice(client, m.id)))}
                  </View>
                )}
                {!m.isMe && client.feature('frequentPlaces') && client.frequent.get(m.id)?.places.length ? (
                  <View style={{ gap: 8 }}>
                    <Text style={{ color: t.muted, fontSize: 12, fontWeight: '700' }}>MOST VISITED · LAST 30 DAYS</Text>
                    {client.frequent
                      .get(m.id)!
                      .places.slice(0, 5)
                      .map((p) => (
                        <View key={p.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                          <Text style={{ fontSize: 18 }}>{KIND_EMOJI[p.kind]}</Text>
                          <Text style={{ flex: 1, color: t.text, fontSize: 15 }} numberOfLines={1}>
                            {p.name}
                          </Text>
                          <Text style={{ color: t.muted, fontSize: 13 }}>
                            {p.hours < 1 ? `${Math.round(p.hours * 60)} min` : `${Math.round(p.hours)} h`} · {p.visits} {p.visits === 1 ? 'visit' : 'visits'}
                          </Text>
                        </View>
                      ))}
                  </View>
                ) : null}
              </SafeAreaView>
            </Pressable>
          ) : null}
        </Pressable>
      </Modal>
      {m ? (
        <AlertRuleSheet
          key={`${client.circleId}:${m.id}`}
          clients={[client]}
          initialClient={client}
          initialMember={m.id}
          visible={alerting}
          onClose={() => {
            setAlerting(false);
            onClose();
          }}
        />
      ) : null}
    </>
  );
}
