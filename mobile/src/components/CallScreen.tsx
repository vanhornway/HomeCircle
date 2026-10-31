import { useEffect, useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { CircleClient } from '@homecircle/core';
import { Avatar, Icon } from './ui';
import { MemberAvatar } from './MemberAvatar';
import { answerCall, chooseRoute, declineCall, hangUp, setMuted, useCall } from '../lib/calls';
import { useTheme } from '../theme';
import { clientForCircle } from '../lib/circle';
import type { AudioRoute } from '../../modules/hc-calls/src/HcCallsModule';

// Call-screen glyphs, drawn here so the shared icon set stays as it is.
const GLYPH = {
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM6 11a6 6 0 0 0 12 0M12 17v4M9 21h6',
  micOff: 'M4 4l16 16M9 9v3a3 3 0 0 0 5 2.2M15 9.5V6a3 3 0 0 0-5.7-1.3M6 11a6 6 0 0 0 9.5 4.8M18 11a6 6 0 0 1-.6 2.6M12 17v4M9 21h6',
  speaker: 'M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4ZM15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12',
  earpiece: 'M6.5 3h11A1.5 1.5 0 0 1 19 4.5v15a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5v-15A1.5 1.5 0 0 1 6.5 3ZM10 6.5h4',
  bluetooth: 'M7 7.5l10 9-5 4.5V3l5 4.5-10 9',
};

function Glyph({ name, color, size = 26 }: { name: keyof typeof GLYPH; color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d={GLYPH[name]} stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function Round({ label, onPress, bg, border, children, size = 64, on }: { label: string; onPress: () => void; bg: string; border?: string; children: React.ReactNode; size?: number; on?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={on === undefined ? undefined : { selected: on }}
      onPress={onPress}
      style={({ pressed }) => ({ width: size, height: size, borderRadius: size / 2, backgroundColor: bg, borderWidth: border ? 1 : 0, borderColor: border, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}
    >
      {children}
    </Pressable>
  );
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return `${h ? `${h}:` : ''}${mm}:${String(s % 60).padStart(2, '0')}`;
};

const NEXT_ROUTE: Record<AudioRoute, AudioRoute> = { earpiece: 'speaker', speaker: 'earpiece', bluetooth: 'earpiece' };
const ROUTE_LABEL: Record<AudioRoute, string> = { earpiece: 'Phone', speaker: 'Speaker', bluetooth: 'Headset' };

/** The call: ringing, calling, on the line (with a timer, mute, speaker) and how it ended. Covers whatever screen is open. */
export function CallScreen() {
  const t = useTheme();
  const { snap, circleId, ended, routes } = useCall();
  const client: CircleClient | undefined = clientForCircle(circleId);
  const peerId = snap.peerId ?? ended?.peerId ?? null;
  const member = client && peerId ? client.members.get(peerId) : undefined;
  const name = (client && peerId ? client.displayName(peerId) : null) || member?.name || 'Someone';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (snap.phase !== 'active') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [snap.phase]);

  const visible = snap.phase !== 'idle' || !!ended;
  const incoming = snap.phase === 'incoming';
  const status = ended
    ? ended.text
    : snap.phase === 'incoming'
      ? 'HomeCircle call'
      : snap.phase === 'outgoing'
        ? snap.remoteRinging
          ? 'Ringing…'
          : 'Calling…'
        : snap.phase === 'connecting'
          ? 'Connecting…'
          : snap.phase === 'reconnecting'
            ? 'Reconnecting…'
            : snap.startedAt
              ? clock(now - snap.startedAt)
              : 'Connecting…';

  const route = routes.current;
  const ownRoute = routes.available.includes('bluetooth') && route !== 'bluetooth' ? 'bluetooth' : NEXT_ROUTE[route];

  return (
    <Modal visible={visible} animationType="fade" transparent={false} statusBarTranslucent onRequestClose={() => (incoming ? declineCall() : snap.phase !== 'idle' ? hangUp() : undefined)}>
      <SafeAreaView style={{ flex: 1, backgroundColor: t.dark ? '#0F1513' : t.brand }}>
        <View accessibilityLiveRegion="polite" style={{ flex: 1, alignItems: 'center', paddingTop: 56, paddingHorizontal: 24 }}>
          <Text style={{ color: '#FFFFFFB3', fontSize: 14, letterSpacing: 0.4 }}>{client?.circle.name ? `${client.circle.name} · ` : ''}{incoming ? 'Incoming call' : 'Voice call'}</Text>
          <View style={{ marginTop: 48 }}>{client && member ? <MemberAvatar client={client} member={member} size={132} /> : <Avatar name={name} color={t.brandSoft} size={132} />}</View>
          <Text style={{ color: '#FFFFFF', fontSize: 30, fontWeight: '700', marginTop: 24, textAlign: 'center' }} numberOfLines={2}>
            {name}
          </Text>
          <Text style={{ color: '#FFFFFFD9', fontSize: 18, marginTop: 8, fontVariant: ['tabular-nums'] }}>{status}</Text>
          {snap.phase === 'active' && !ended ? <Text style={{ color: '#FFFFFF99', fontSize: 12, marginTop: 10 }}>End-to-end encrypted</Text> : null}
        </View>
        <View style={{ paddingBottom: 40, paddingHorizontal: 24, gap: 28 }}>
          {incoming ? (
            <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>
              <View style={{ alignItems: 'center', gap: 8 }}>
                <Round label="Decline" onPress={() => declineCall()} bg={t.danger} size={72}>
                  <View style={{ transform: [{ rotate: '135deg' }] }}>
                    <Icon name="phone" color="#fff" size={30} />
                  </View>
                </Round>
                <Text style={{ color: '#fff', fontSize: 14 }}>Decline</Text>
              </View>
              <View style={{ alignItems: 'center', gap: 8 }}>
                <Round label="Answer" onPress={() => answerCall()} bg={t.ok} size={72}>
                  <Icon name="phone" color="#fff" size={30} />
                </Round>
                <Text style={{ color: '#fff', fontSize: 14 }}>Answer</Text>
              </View>
            </View>
          ) : ended ? null : (
            <>
              <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 40 }}>
                <ControlLabel text={snap.muted ? 'Unmute' : 'Mute'}>
                  <Round label={snap.muted ? 'Unmute microphone' : 'Mute microphone'} on={snap.muted} onPress={() => setMuted(!snap.muted)} bg={snap.muted ? '#FFFFFF' : '#FFFFFF33'}>
                    <Glyph name={snap.muted ? 'micOff' : 'mic'} color={snap.muted ? '#1D2422' : '#FFFFFF'} />
                  </Round>
                </ControlLabel>
                <ControlLabel text={ROUTE_LABEL[route]}>
                  <Round label={`Sound is on the ${ROUTE_LABEL[route].toLowerCase()}. Switch to ${ROUTE_LABEL[ownRoute].toLowerCase()}`} on={route !== 'earpiece'} onPress={() => chooseRoute(ownRoute)} bg={route !== 'earpiece' ? '#FFFFFF' : '#FFFFFF33'}>
                    <Glyph name={route === 'speaker' ? 'speaker' : route === 'bluetooth' ? 'bluetooth' : 'earpiece'} color={route !== 'earpiece' ? '#1D2422' : '#FFFFFF'} />
                  </Round>
                </ControlLabel>
              </View>
              <View style={{ alignItems: 'center' }}>
                <Round label={snap.phase === 'outgoing' ? 'Cancel call' : 'Hang up'} onPress={() => hangUp()} bg={t.danger} size={72}>
                  <View style={{ transform: [{ rotate: '135deg' }] }}>
                    <Icon name="phone" color="#fff" size={30} />
                  </View>
                </Round>
              </View>
            </>
          )}
        </View>
      </SafeAreaView>
    </Modal>
  );
}

function ControlLabel({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <View style={{ alignItems: 'center', gap: 8 }}>
      {children}
      <Text style={{ color: '#FFFFFFD9', fontSize: 13 }}>{text}</Text>
    </View>
  );
}

