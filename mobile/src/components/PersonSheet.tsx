import { useEffect, useState, type ReactNode } from 'react';
import { BackHandler, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import type { CircleClient } from '@homecircle/core';
import { Icon } from './ui';
import { AlertRuleSheet } from './AlertRuleSheet';
import { CallChoiceSheet } from './CallActions';
import { errorText } from '../lib/circle';
import { chirpWithChoice } from '../lib/chirp';
import { KIND_EMOJI } from '../lib/visits';
import { spotName, type Anchor } from '../lib/visitsCore';
import { MemberAvatar } from './MemberAvatar';
import { cadenceLine, canLocate, locatePerson, locateState, openDirections, statusLine, useLocateVersion } from '../lib/people';
import { useTheme } from '../theme';
import { showSheet } from '../lib/sheet';

/**
 * Everything you can do about one person, in a bottom sheet. It isn't a
 * modal: the map above stays live, so you can still pan it and tap another
 * person while this is open. Close it with ✕, Back, or by choosing something.
 * Render it last inside a full-size parent (it sits at the bottom of it).
 */
export function PersonSheet({
  client,
  memberId,
  onClose,
  onShowSpot,
  onHeight,
}: {
  client: CircleClient;
  memberId: string | null;
  onClose: () => void;
  /** A most visited place tapped: show it on the map. */
  onShowSpot?: (p: { lat: number; lng: number }) => void;
  /** How much of the screen the sheet covers (0 when it's closed), so the map can keep clear of it. */
  onHeight?: (h: number) => void;
}) {
  const t = useTheme();
  useLocateVersion();
  const [alerting, setAlerting] = useState(false);
  const [choosingCall, setChoosingCall] = useState(false);
  const [checking, setChecking] = useState(false);
  const { height } = useWindowDimensions();
  const m = memberId ? client.members.get(memberId) : null;
  const loc = m ? client.locations.get(m.id) : undefined;
  const paused = m ? client.paused.get(m.id) : undefined;
  const state = m ? locateState(client, m.id) : 'idle';

  const showing = !!m && !alerting;
  useEffect(() => {
    if (!showing) onHeight?.(0);
  }, [showing, onHeight]);
  useEffect(() => {
    if (!showing) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [showing, onClose]);

  const go = (fn: () => void) => () => {
    onClose();
    fn();
  };

  // The main three: big round buttons in a row.
  const primary = (icon: string, label: string, onPress: () => void, disabled = false, hint?: string) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({ flex: 1, alignItems: 'center', gap: 6, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 })}
    >
      <View style={{ width: 60, height: 60, borderRadius: 30, backgroundColor: t.brand, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} color="#fff" size={26} />
      </View>
      <Text style={{ color: t.text, fontSize: 14, fontWeight: '700' }}>{label}</Text>
    </Pressable>
  );

  // Everything else: a row each, with a line on what it does or where it stands.
  const row = (icon: string, label: string, sub: string | null, onPress: () => void, disabled = false) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      accessibilityLabel={sub ? `${label}. ${sub}` : label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 56, paddingVertical: 8, paddingHorizontal: 4, borderRadius: 12, backgroundColor: pressed ? t.surface2 : 'transparent', opacity: disabled ? 0.45 : 1 })}
    >
      <Icon name={icon} color={t.brand} size={22} />
      <View style={{ flex: 1 }}>
        <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>{label}</Text>
        {sub ? (
          <Text style={{ color: t.muted, fontSize: 13, marginTop: 1 }} numberOfLines={1}>
            {sub}
          </Text>
        ) : null}
      </View>
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
      showSheet('Couldn’t send it', errorText(e));
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      {/* Touches outside the sheet fall through to the map under it. */}
      <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}>
        <View pointerEvents="box-none" style={{ flex: 1, justifyContent: 'flex-end' }}>
          {showing && m ? (
            <View onLayout={(e) => onHeight?.(Math.round(e.nativeEvent.layout.height))} style={{ backgroundColor: t.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: 1, borderBottomWidth: 0, borderColor: t.line, elevation: 12, shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 10 }}>
              <ScrollView style={{ maxHeight: height * 0.5 }} contentContainerStyle={{ padding: 18, paddingBottom: 22, gap: 14 }} keyboardShouldPersistTaps="handled">
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <MemberAvatar client={client} member={m} size={52} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: t.text, fontSize: 20, fontWeight: '700' }}>{client.displayName(m.id)}</Text>
                    {client.displayName(m.id) !== m.name ? <Text style={{ color: t.muted, fontSize: 13 }}>{m.name}</Text> : null}
                    <Text style={{ color: t.muted, fontSize: 14, marginTop: 2 }}>{statusLine(client, m)}</Text>
                    {m.isMe && cadenceLine(loc) ? <Text style={{ color: t.muted, fontSize: 13, marginTop: 2 }}>{sentence(cadenceLine(loc)!)}</Text> : null}
                  </View>
                  <Pressable accessibilityRole="button" accessibilityLabel="Close" hitSlop={8} onPress={onClose} style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: t.surface2 }}>
                    <Text style={{ color: t.muted, fontSize: 20, lineHeight: 22 }}>✕</Text>
                  </Pressable>
                </View>
                {m.isMe ? (
                  <Text style={{ color: t.muted, fontSize: 14 }}>This is you. Change how you share, and your most visited places, in Settings.</Text>
                ) : (
                  <>
                    {/* Only what this circle has on. */}
                    {(() => {
                      const main: ReactNode[] = [];
                      if ((client.feature('calls') || client.feature('whatsapp')) && m.kind !== 'agent') main.push(primary('phone', 'Call', () => setChoosingCall(true), false, 'In HomeCircle or on WhatsApp'));
                      if (client.feature('directMessages'))
                        main.push(primary('chat', 'Message', go(() => router.push({ pathname: '/conversation', params: { circle: client.circleId!, peer: m.id } })), false, 'Only you two can read it'));
                      if (client.feature('locationSharing'))
                        main.push(
                          primary('navigate', 'Directions', () => loc && openDirections(m.name, loc, () => locatePerson(client, m.id)), !loc, loc ? undefined : paused ? 'Sharing is paused' : 'No location yet'),
                        );
                      return main.length ? <View style={{ flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 4 }}>{main}</View> : null;
                    })()}
                    <View>
                      {client.feature('locate') &&
                        row(
                          'locate',
                          'Locate now',
                          paused
                            ? 'Sharing is paused'
                            : state === 'sent'
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
                      {client.feature('checkIns') && row('checkin', checking ? 'Sending…' : 'Ask to check in', 'Ask “where are you?”', askCheckIn, checking)}
                      {client.feature('placeAlerts') && row('bell', 'Alert me when they arrive or leave', 'At a place you pick', () => setAlerting(true))}
                      {client.feature('chirps') && row('bird', 'Chirp', 'A sound they’ll know is you', go(() => chirpWithChoice(client, m.id)))}
                    </View>
                  </>
                )}
                {!m.isMe && client.feature('frequentPlaces') && client.frequent.get(m.id)?.places.length ? (
                  <View style={{ gap: 8 }}>
                    <Text style={{ color: t.muted, fontSize: 12, fontWeight: '700' }}>MOST VISITED · LAST 30 DAYS</Text>
                    {(() => {
                      const spots = client.frequent.get(m.id)!.places;
                      // A spot their phone couldn't name: the circle place it's in, or where it is from one.
                      const anchors: Anchor[] = [
                        ...[...client.places.values()].map((p) => ({ name: p.name, lat: p.lat, lng: p.lng, radius: p.radius })),
                        ...spots.filter((p) => p.name && p.name !== 'Place').map((p) => ({ name: p.name, lat: p.lat, lng: p.lng })),
                      ];
                      return spots.slice(0, 5).map((p) => (
                        <Pressable
                          key={p.id}
                          accessibilityRole="button"
                          accessibilityHint="Shows it on the map"
                          onPress={() => onShowSpot?.(p)}
                          style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, opacity: pressed ? 0.6 : 1, minHeight: 32 })}
                        >
                          <Text style={{ fontSize: 18 }}>{KIND_EMOJI[p.kind]}</Text>
                          <Text style={{ flex: 1, color: t.text, fontSize: 15 }} numberOfLines={1}>
                            {spotName(p, anchors)}
                          </Text>
                          <Text style={{ color: t.muted, fontSize: 13 }}>
                            {p.hours < 1 ? `${Math.round(p.hours * 60)} min` : `${Math.round(p.hours)} h`} · {p.visits} {p.visits === 1 ? 'visit' : 'visits'}
                          </Text>
                        </Pressable>
                      ));
                    })()}
                  </View>
                ) : null}
              </ScrollView>
            </View>
          ) : null}
        </View>
      </View>
      {m ? (
        <CallChoiceSheet
          client={client}
          memberId={m.id}
          visible={choosingCall}
          onClose={() => setChoosingCall(false)}
          onCalled={() => {
            setChoosingCall(false);
            onClose();
          }}
        />
      ) : null}
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

/** "updates about…" → "Updates about…". */
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
