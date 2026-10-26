import { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Alert, Linking, Platform, Pressable, ScrollView, Text, Vibration, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { distanceM } from '@homecircle/core';
import { Button } from '../components/ui';
import { clientForCircle, errorText } from '../lib/circle';
import { locatePerson, openDirections } from '../lib/people';
import { SAFE_EMOJI, SAFE_KIND_NAME, endMySos, startMySos, useMySos, type SafePlace } from '../lib/sos';
import { stopAlarm, useAlarmRinging } from '../lib/sosAlarm';
import { formatFeet } from '../lib/units';
import { timeAgo, useAllCircles } from '../lib/useCircle';
import { useTheme } from '../theme';

const COUNTDOWN = 5;
// Countdowns already run (by when they were asked for). The SOS screen can be
// shown again from history or a relaunch: it must never count down and send
// on its own a second time.
const counted = new Set<string>();
const freshCountdown = (asked?: string) => !!asked && !counted.has(asked) && Date.now() - Number(asked) < 60_000;
const EMERGENCY_NUMBER = '911';
const clock = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/**
 * The SOS screen: the 5-second countdown before sending, your own SOS while
 * it's on, or someone else's (`circle` + `member`).
 */
export default function SosScreen() {
  const { countdown, circle, member } = useLocalSearchParams<{ countdown?: string; circle?: string; member?: string }>();
  const mine = useMySos();
  // Once this screen has sent an SOS, it never counts down again: after "I'm
  // safe" it must not start a new one on its own.
  const [sent, setSent] = useState(false);
  if (mine && !sent) setSent(true);
  if (circle && member) return <TheirSos circleId={circle} memberId={member} />;
  if (mine === undefined) return null;
  if (!mine && !sent && freshCountdown(countdown)) return <Countdown asked={countdown!} />;
  if (!mine) return <Ended text="Your SOS has ended." />;
  return <MySosView />;
}

function Countdown({ asked }: { asked: string }) {
  const t = useTheme();
  const [left, setLeft] = useState(COUNTDOWN);
  useEffect(() => {
    counted.add(asked);
  }, [asked]);
  const sending = left === 0;
  // One tick a second; Cancel leaves the screen, which stops the clock before it sends.
  useEffect(() => {
    if (left === 0) return;
    Vibration.vibrate(60);
    const id = setTimeout(() => {
      setLeft(left - 1);
      if (left > 1) return;
      startMySos().catch((e) => {
        Alert.alert('Couldn’t send the SOS', `${errorText(e)}\n\nCall ${EMERGENCY_NUMBER} if you need help now.`);
        router.back();
      });
    }, 1000);
    return () => clearTimeout(id);
  }, [left]);
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.danger, padding: 24, justifyContent: 'space-between' }}>
      <View style={{ alignItems: 'center', marginTop: 60, gap: 12 }}>
        <Text style={{ color: '#fff', fontSize: 22, fontWeight: '700' }}>{sending ? 'Sending SOS…' : 'Sending SOS in'}</Text>
        {sending ? <ActivityIndicator color="#fff" size="large" /> : <Text style={{ color: '#fff', fontSize: 120, fontWeight: '800' }}>{left}</Text>}
        <Text style={{ color: '#fff', fontSize: 16, textAlign: 'center', lineHeight: 22 }}>
          Everyone in your circles is alerted, and your exact location is shared every minute until you say you’re safe.
        </Text>
      </View>
      {sending ? null : (
        <Pressable
          accessibilityRole="button"
          onPress={() => router.back()}
          style={({ pressed }) => ({ backgroundColor: '#fff', borderRadius: 20, minHeight: 64, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.8 : 1 })}
        >
          <Text style={{ color: t.danger, fontSize: 20, fontWeight: '800' }}>Cancel</Text>
        </Pressable>
      )}
    </SafeAreaView>
  );
}

function MySosView() {
  const t = useTheme();
  const sos = useMySos()!;
  const [ending, setEnding] = useState(false);
  const here = sos.at;
  const safe = () =>
    Alert.alert('Are you safe?', 'Everyone in your circles is told you’re safe, and location sharing goes back to normal.', [
      { text: 'Not yet', style: 'cancel' },
      {
        text: 'I’m safe',
        onPress: () => {
          setEnding(true);
          endMySos()
            .then(() => router.back())
            .catch((e) => Alert.alert('Couldn’t end the SOS', errorText(e)))
            .finally(() => setEnding(false));
        },
      },
    ]);
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={['top', 'bottom']}>
      <View style={{ backgroundColor: t.danger, padding: 20, gap: 6 }}>
        <Text style={{ color: '#fff', fontSize: 26, fontWeight: '800' }}>🆘 SOS is on</Text>
        <Text style={{ color: '#fff', fontSize: 15, lineHeight: 21 }}>
          Since {clock(sos.startedAt)}. Your exact location goes to everyone in your circles every minute, until you tap I’m safe.
        </Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <Button variant="danger" title={`📞 Call ${EMERGENCY_NUMBER}`} onPress={() => Linking.openURL(`tel:${EMERGENCY_NUMBER}`)} />
        <Button variant="primary" title="I’m safe" loading={ending} onPress={safe} />
        <Text style={{ color: t.muted, fontSize: 13, fontWeight: '700', marginTop: 8 }}>SAFE PLACES NEARBY</Text>
        {sos.places.length ? (
          sos.places.map((p) => <SafePlaceRow key={p.id} place={p} here={here} reached={sos.reached.includes(p.id)} />)
        ) : (
          <Text style={{ color: t.muted, fontSize: 15 }}>Looking for police, fire stations, hospitals and other safe places near you…</Text>
        )}
        <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17, marginTop: 8 }}>
          When you reach one of these places, your circles are told. HomeCircle doesn’t call emergency services for you.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function SafePlaceRow({ place, here, reached }: { place: SafePlace; here: { lat: number; lng: number } | null; reached: boolean }) {
  const t = useTheme();
  const go = () => {
    const at = `${place.lat},${place.lng}`;
    Linking.openURL(Platform.OS === 'ios' ? `http://maps.apple.com/?daddr=${at}&dirflg=w` : `https://www.google.com/maps/dir/?api=1&destination=${at}&travelmode=walking`).catch(() => {});
  };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: t.surface, borderRadius: 14, padding: 12 }}>
      <Text style={{ fontSize: 24 }}>{SAFE_EMOJI[place.kind]}</Text>
      <View style={{ flex: 1 }}>
        <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }} numberOfLines={1}>
          {reached ? '✓ ' : ''}
          {place.name}
        </Text>
        <Text style={{ color: t.muted, fontSize: 13 }}>
          {SAFE_KIND_NAME[place.kind]}
          {here ? ` · ${formatFeet(distanceM(here, place))}` : ''}
        </Text>
      </View>
      <Button small title="Directions" onPress={go} />
    </View>
  );
}

function TheirSos({ circleId, memberId }: { circleId: string; memberId: string }) {
  const t = useTheme();
  useAllCircles(['messages', 'locations', 'members']);
  const client = clientForCircle(circleId);
  const ringing = useAlarmRinging();
  if (!client) return <Ended text="This circle isn’t on this phone anymore." />;
  const name = client.members.get(memberId)?.name || 'Someone';
  const sos = client.activeSos().find((s) => s.memberId === memberId);
  if (!sos) return <Ended text={`${name}’s SOS has ended. They said they’re safe.`} />;
  const loc = client.locations.get(memberId);
  const me = client.account?.memberId ? client.locations.get(client.account.memberId) : undefined;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={['top', 'bottom']}>
      <View style={{ backgroundColor: t.danger, padding: 20, gap: 6 }}>
        <Text style={{ color: '#fff', fontSize: 26, fontWeight: '800' }}>🆘 {name} needs help</Text>
        <Text style={{ color: '#fff', fontSize: 15 }}>
          SOS since {clock(sos.since)}
          {client.circle.name ? ` · ${client.circle.name}` : ''}
        </Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {ringing ? <Button variant="danger" title="🔕 Stop the alarm" onPress={stopAlarm} /> : null}
        <View style={{ backgroundColor: t.surface, borderRadius: 14, padding: 14, gap: 4 }}>
          <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>{loc ? `Location ${timeAgo(loc.ts)}` : 'No location yet'}</Text>
          {loc && me ? <Text style={{ color: t.muted, fontSize: 14 }}>{formatFeet(distanceM(me, loc))} from you</Text> : null}
          {sos.arrived ? (
            <Text style={{ color: t.ok, fontSize: 15, fontWeight: '600' }}>
              📍 Reached {sos.arrived.place} at {clock(sos.arrived.at)}
            </Text>
          ) : null}
          <Text style={{ color: t.muted, fontSize: 13 }}>Their phone shares its location every minute until they say they’re safe.</Text>
        </View>
        {/* Doing anything about it also stops the alarm. */}
        <Button
          variant="primary"
          title={`Directions to ${name}`}
          disabled={!loc}
          onPress={() => {
            stopAlarm();
            if (loc) openDirections(name, loc, () => locatePerson(client, memberId));
          }}
        />
        <Button
          title="Locate now"
          onPress={() => {
            stopAlarm();
            locatePerson(client, memberId);
          }}
        />
        <Button
          title="Open the chat"
          onPress={() => {
            stopAlarm();
            router.push({ pathname: '/conversation', params: { circle: circleId, peer: '' } });
          }}
        />
        <Button
          variant="danger"
          title={`📞 Call ${EMERGENCY_NUMBER}`}
          onPress={() => {
            stopAlarm();
            Linking.openURL(`tel:${EMERGENCY_NUMBER}`);
          }}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

function Ended({ text }: { text: string }) {
  const t = useTheme();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg, padding: 24, gap: 16, justifyContent: 'center' }}>
      <Text style={{ color: t.text, fontSize: 20, textAlign: 'center' }}>{text}</Text>
      <Button title="Back" onPress={() => router.back()} />
    </SafeAreaView>
  );
}
