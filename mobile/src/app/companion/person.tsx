import { useEffect, useRef, useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import Svg, { Path } from 'react-native-svg';
import { allClients, clientForCircle, errorText, useCircles } from '../../lib/circle';
import { inSleepHours, myTimeZone, settingsOf, tileName } from '../../companion/people';
import { currentRequest, statusLine } from '../../companion/status';
import { askOrQueue } from '../../companion/outbox';
import { canCall, startCall } from '../../lib/calls';
import { openChat } from '../../lib/whatsapp';
import { usePhotoUri } from '../../lib/photos';
import { markUsed } from '../../companion/used';
import { hush, say, text } from '../../companion/lines';
import { C, TILE_COLORS, URDU, isUrdu } from '../../companion/theme';

// How long she has to change her mind after touching Call, while her phone says who it's calling.
const BEFORE_RING_MS = 3500;

/** One person (design 03): their face, Call (she rings them herself) and Call me. Play a game comes with games. */
export default function Person() {
  const { circle, member } = useLocalSearchParams<{ circle: string; member: string }>();
  useCircles();
  const client = clientForCircle(circle);
  const m = client?.members.get(member);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Her call is about to ring: a big way out until it does.
  const [placing, setPlacing] = useState(false);
  const waiting = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (waiting.current) clearTimeout(waiting.current);
    },
    [],
  );
  const photo = usePhotoUri(client, client?.account && m ? client.tilePhoto(client.account.memberId, m.id) : null);
  if (!client || !m) return null;
  const index = client.memberList().filter((x) => !x.isMe).findIndex((x) => x.id === m.id);
  const label = tileName(client, m.id);

  const callMe = async () => {
    markUsed();
    if (busy) return;
    const open = currentRequest(client);
    // Already asked (everyone, or this person): tell her where it stands.
    if (open?.open && (!open.for || open.for.includes(m.id))) {
      say(statusLine(client, open));
      router.back();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const awake = !inSleepHours(allClients());
      if ((await askOrQueue(client, { to: m.id, tz: myTimeZone(), remind: settingsOf(client).remindEvery, awake })) === 'sent') say({ key: 'sent.one', name: label });
      router.back();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  // In HomeCircle when that works, otherwise WhatsApp; neither (or an admin turned it off): only Call me.
  const inApp = canCall(client, m.id);
  const phone = client.feature('whatsapp') ? client.phoneOf(m.id) : null;
  const canDial = settingsOf(client).canDial && (inApp || !!phone);
  const dial = () => {
    markUsed();
    setPlacing(true);
    setError(null);
    say({ key: 'call.placing', name: label });
    waiting.current = setTimeout(() => {
      hush();
      setPlacing(false);
      const placed = inApp ? startCall(client, m.id).then(() => true) : openChat(phone!).then((o) => o.ok);
      placed.catch(() => false).then((ok) => ok || say({ key: 'call.failed' }));
    }, BEFORE_RING_MS);
  };
  const dontDial = () => {
    if (waiting.current) clearTimeout(waiting.current);
    hush();
    setPlacing(false);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ flex: 1, alignItems: 'center', gap: 18, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 32 }}>
        <View style={{ alignSelf: 'stretch' }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={() => router.back()}
            style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: C.soft, alignItems: 'center', justifyContent: 'center' }}
          >
            <Svg width={30} height={30} viewBox="0 0 24 24" fill="none">
              <Path d="M18 6 6 18M6 6l12 12" stroke={C.ink} strokeWidth={2.6} strokeLinecap="round" />
            </Svg>
          </Pressable>
        </View>
        <View
          accessibilityLabel={`Photo of ${m.name}`}
          style={{ width: 180, height: 180, borderRadius: 90, borderWidth: 5, borderColor: C.ink, backgroundColor: TILE_COLORS[Math.max(0, index) % TILE_COLORS.length], alignItems: 'center', justifyContent: 'center', padding: photo ? 0 : 12, overflow: 'hidden' }}
        >
          {photo ? (
            <Image source={{ uri: photo }} accessibilityLabel={label} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} resizeMode="cover" />
          ) : (
          <Text
            style={isUrdu(label) ? [URDU, { color: C.ink, fontSize: 34, lineHeight: 68, textAlign: 'center' }] : { color: C.ink, fontSize: 34, fontWeight: '800', textAlign: 'center' }}
            numberOfLines={2}
            adjustsFontSizeToFit
          >
            {label}
          </Text>
          )}
        </View>
        {placing ? (
          <View style={{ alignSelf: 'stretch', flex: 1, gap: 14 }}>
            <Text style={[URDU, { color: C.ink, fontSize: 28, lineHeight: 60, textAlign: 'center' }]}>{text({ key: 'call.placing', name: label })}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Don't call"
              onPress={dontDial}
              style={({ pressed }) => ({ flex: 1, maxHeight: 220, borderRadius: 28, backgroundColor: C.red, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, opacity: pressed ? 0.8 : 1 })}
            >
              <Text style={[URDU, { color: C.white, fontSize: 34, lineHeight: 68, textAlign: 'center' }]}>{text({ key: 'ui.cancel' })}</Text>
            </Pressable>
          </View>
        ) : (
          <View style={{ alignSelf: 'stretch', flex: 1, gap: 14 }}>
            {canDial ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Call ${m.name}`}
                onPress={dial}
                style={({ pressed }) => ({ flex: 1, maxHeight: 220, borderRadius: 28, backgroundColor: C.green, flexDirection: 'row', alignItems: 'center', gap: 20, paddingHorizontal: 28, opacity: pressed ? 0.8 : 1 })}
              >
                <Svg width={52} height={52} viewBox="0 0 24 24" fill="none">
                  <Path d="M5 4h3.5l1.5 4-2 1.5a11 11 0 0 0 6.5 6.5l1.5-2 4 1.5V19a1.5 1.5 0 0 1-1.5 1.5A15.5 15.5 0 0 1 3.5 5.5 1.5 1.5 0 0 1 5 4Z" stroke={C.white} strokeWidth={2.2} strokeLinejoin="round" />
                </Svg>
                <Text style={[URDU, { flex: 1, color: C.white, fontSize: 28, lineHeight: 56 }]} numberOfLines={1} adjustsFontSizeToFit>
                  {text({ key: 'ui.call_person', name: label })}
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Ask ${m.name} to call you`}
              onPress={() => {
                say({ key: 'ui.call_me' });
                callMe();
              }}
              style={({ pressed }) => ({
                flex: 1,
                maxHeight: 220,
                borderRadius: 28,
                borderWidth: canDial ? 4 : 0,
                borderColor: C.green,
                backgroundColor: canDial ? C.white : C.green,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 20,
                paddingHorizontal: 28,
                opacity: pressed || busy ? 0.8 : 1,
              })}
            >
              <Svg width={52} height={52} viewBox="0 0 24 24" fill="none">
                <Path d="M5 4h3.5l1.5 4-2 1.5a11 11 0 0 0 6.5 6.5l1.5-2 4 1.5V19a1.5 1.5 0 0 1-1.5 1.5A15.5 15.5 0 0 1 3.5 5.5 1.5 1.5 0 0 1 5 4Z" stroke={canDial ? C.green : C.white} strokeWidth={2.2} strokeLinejoin="round" />
              </Svg>
              <Text style={[URDU, { flex: 1, color: canDial ? C.green : C.white, fontSize: 28, lineHeight: 56 }]}>{text({ key: 'ui.call_me' })}</Text>
            </Pressable>
          </View>
        )}
        {error ? <Text style={{ color: C.red, fontSize: 16, textAlign: 'center' }}>{error}</Text> : null}
      </View>
    </SafeAreaView>
  );
}
