import { useEffect, useState } from 'react';
import { Modal, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { clientForCircle } from '../lib/circle';
import { chooseGroupRoute, leaveMesh, setMeshMuted, useMesh } from '../lib/calls';
import { MemberAvatar } from './MemberAvatar';
import { tileName } from '../companion/people';
import { useTheme } from '../theme';
import { Icon } from './ui';
import { Glyph, Round } from './CallScreen';

const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

/**
 * The group call, over whatever is open: who's on it, who's talking, mute,
 * speaker and leave. On an elder's phone, only faces and one big button to
 * leave, with the sound on the speaker.
 */
export function GroupCallScreen({ elder = false }: { elder?: boolean }) {
  const t = useTheme();
  const { snap, circleId, route } = useMesh();
  const client = clientForCircle(circleId);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (snap.phase === 'idle') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [snap.phase]);
  if (snap.phase === 'idle' || !client) return null;
  const status = snap.startedAt ? clock(now - snap.startedAt) : snap.peers.length ? 'Connecting…' : 'Waiting for others…';
  const state = (s: string) => (s === 'connected' ? null : s === 'reconnecting' ? 'Reconnecting…' : 'Connecting…');
  const size = elder ? 96 : 72;
  return (
    <Modal visible animationType="fade" transparent={false} statusBarTranslucent onRequestClose={() => leaveMesh()}>
      <SafeAreaView style={{ flex: 1, backgroundColor: t.dark ? '#0F1513' : t.brand }}>
        <View style={{ flex: 1, alignItems: 'center', paddingTop: 32, paddingHorizontal: 20, gap: 8 }}>
          <Text style={{ color: '#fff', fontSize: 22, fontWeight: '700' }}>{client.circle.name}</Text>
          <Text style={{ color: '#FFFFFFE6', fontSize: elder ? 24 : 18, fontVariant: ['tabular-nums'] }}>{status}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 22, marginTop: 28 }}>
            {snap.peers.map((p) => {
              const m = client.members.get(p.id);
              return (
                <View key={p.id} accessible accessibilityLabel={`${client.displayName(p.id)}${p.speaking ? ', talking' : ''}${state(p.state) ? `, ${state(p.state)}` : ''}`} style={{ alignItems: 'center', gap: 6, width: size + 34 }}>
                  <View style={{ padding: 3, borderRadius: size, borderWidth: 3, borderColor: p.speaking ? '#FFFFFF' : 'transparent', opacity: p.state === 'connected' ? 1 : 0.55 }}>
                    {m ? <MemberAvatar client={client} member={m} size={size} /> : null}
                  </View>
                  <Text style={{ color: '#fff', fontSize: elder ? 18 : 15, fontWeight: '600' }} numberOfLines={1}>
                    {elder ? tileName(client, p.id) : client.displayName(p.id)}
                  </Text>
                  {state(p.state) ? <Text style={{ color: '#FFFFFFCC', fontSize: 14 }}>{state(p.state)}</Text> : null}
                </View>
              );
            })}
          </View>
        </View>
        <View style={{ paddingBottom: 40, paddingHorizontal: 24, gap: 28 }}>
          {elder ? null : (
            <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 40 }}>
              <Round label={snap.muted ? 'Unmute microphone' : 'Mute microphone'} on={snap.muted} onPress={() => setMeshMuted(!snap.muted)} bg={snap.muted ? '#FFFFFF' : '#FFFFFF33'}>
                <Glyph name={snap.muted ? 'micOff' : 'mic'} color={snap.muted ? '#1D2422' : '#FFFFFF'} />
              </Round>
              <Round label={route === 'speaker' ? 'Sound is on the speaker. Switch to the earpiece' : 'Sound is on the earpiece. Switch to the speaker'} on={route === 'speaker'} onPress={() => chooseGroupRoute(route === 'speaker' ? 'earpiece' : 'speaker')} bg={route === 'speaker' ? '#FFFFFF' : '#FFFFFF33'}>
                <Glyph name={route === 'speaker' ? 'speaker' : 'earpiece'} color={route === 'speaker' ? '#1D2422' : '#FFFFFF'} />
              </Round>
            </View>
          )}
          <View style={{ alignItems: 'center' }}>
            <Round label="Leave the call" onPress={() => leaveMesh()} bg={t.danger} size={elder ? 120 : 72}>
              <View style={{ transform: [{ rotate: '135deg' }] }}>
                <Icon name="phone" color="#fff" size={elder ? 52 : 30} />
              </View>
            </Round>
          </View>
        </View>
      </SafeAreaView>
    </Modal>
  );
}
