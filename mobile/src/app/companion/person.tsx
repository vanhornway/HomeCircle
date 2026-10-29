import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import Svg, { Path } from 'react-native-svg';
import { clientForCircle, errorText, useCircles } from '../../lib/circle';
import { myTimeZone, pageOf } from '../../companion/people';
import { currentRequest, statusLine } from '../../companion/status';
import { askOrQueue } from '../../companion/outbox';
import { say, text } from '../../companion/lines';
import { C, TILE_COLORS, URDU } from '../../companion/theme';

/** One person (design 03): their face, then Call me. Play a game comes with games. */
export default function Person() {
  const { circle, member } = useLocalSearchParams<{ circle: string; member: string }>();
  useCircles();
  const client = clientForCircle(circle);
  const m = client?.members.get(member);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!client || !m) return null;
  const index = client.memberList().filter((x) => !x.isMe).findIndex((x) => x.id === m.id);

  const callMe = async () => {
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
      if ((await askOrQueue(client, { to: m.id, tz: myTimeZone(), remind: pageOf(client) === 'care' ? 10 : 0 })) === 'sent') say({ key: 'sent.one', name: m.name });
      router.back();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
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
          style={{ width: 180, height: 180, borderRadius: 90, borderWidth: 5, borderColor: C.ink, backgroundColor: TILE_COLORS[Math.max(0, index) % TILE_COLORS.length], alignItems: 'center', justifyContent: 'center', padding: 12 }}
        >
          <Text style={{ color: C.ink, fontSize: 34, fontWeight: '800', textAlign: 'center' }} numberOfLines={2} adjustsFontSizeToFit>
            {m.name}
          </Text>
        </View>
        <View style={{ alignSelf: 'stretch', flex: 1, gap: 14 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Ask ${m.name} to call you`}
            onPress={() => {
              say({ key: 'ui.call_me' });
              callMe();
            }}
            style={({ pressed }) => ({ flex: 1, maxHeight: 220, borderRadius: 28, backgroundColor: C.green, flexDirection: 'row', alignItems: 'center', gap: 20, paddingHorizontal: 28, opacity: pressed || busy ? 0.8 : 1 })}
          >
            <Svg width={52} height={52} viewBox="0 0 24 24" fill="none">
              <Path d="M5 4h3.5l1.5 4-2 1.5a11 11 0 0 0 6.5 6.5l1.5-2 4 1.5V19a1.5 1.5 0 0 1-1.5 1.5A15.5 15.5 0 0 1 3.5 5.5 1.5 1.5 0 0 1 5 4Z" stroke={C.white} strokeWidth={2.2} strokeLinejoin="round" />
            </Svg>
            <Text style={[URDU, { flex: 1, color: C.white, fontSize: 28, lineHeight: 56 }]}>{text({ key: 'ui.call_me' })}</Text>
          </Pressable>
        </View>
        {error ? <Text style={{ color: C.red, fontSize: 16, textAlign: 'center' }}>{error}</Text> : null}
      </View>
    </SafeAreaView>
  );
}
