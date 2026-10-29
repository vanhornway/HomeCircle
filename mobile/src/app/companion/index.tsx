import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import Svg, { Circle, Path } from 'react-native-svg';
import type { CallbackReply, CircleClient, Member } from '@homecircle/core';
import { allClients, errorText, useCircles } from '../../lib/circle';
import { startMySos, useMySos } from '../../lib/sos';
import { pageOf, myTimeZone, tilePeople } from '../../companion/people';
import { currentRequest, statusLine, tileReplies } from '../../companion/status';
import { askOrQueue } from '../../companion/outbox';
import { hush, say, text } from '../../companion/lines';
import { C, TILE_COLORS, URDU } from '../../companion/theme';

/** Minutes between reminders on the family's phones: care circles remind, grandkids circles don't. */
const CARE_REMIND_MIN = 10;
const SOS_HOLD_MS = 2000;

/** Re-draw when any circle's messages, members or connection change. */
function useClientsTick(clients: CircleClient[]) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const offs = clients.flatMap((c) => ['messages', 'members', 'status'].map((e) => c.on(e, () => setTick((n) => n + 1))));
    // "Calling now" fades after a while without any new message: check each minute.
    const timer = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => {
      offs.forEach((off) => off());
      clearInterval(timer);
    };
  }, [clients]);
}

/** Her pages, one per circle: care circles first, then grandkids circles. She swipes between them. */
export default function CompanionHome() {
  const { clients } = useCircles();
  useClientsTick(clients);
  const { width } = useWindowDimensions();
  const [page, setPage] = useState(0);
  const pages = [...clients].sort((a, b) => (pageOf(a) === pageOf(b) ? 0 : pageOf(a) === 'care' ? -1 : 1));
  if (!pages.length) return null;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / width))}
      >
        {pages.map((c, i) => (
          <View key={c.circleId} style={{ width }}>
            <CirclePage client={c} index={i} count={pages.length} current={page} />
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

function CirclePage({ client, index, count, current }: { client: CircleClient; index: number; count: number; current: number }) {
  const care = pageOf(client) === 'care';
  const request = currentRequest(client);
  const replies = tileReplies(request);
  const people = tilePeople(client);
  const [error, setError] = useState<string | null>(null);

  const ringEveryone = async () => {
    setError(null);
    // Already asked: tell her where it stands instead of asking again.
    if (request) return say(statusLine(client, request));
    try {
      if ((await askOrQueue(client, { tz: myTimeZone(), remind: care ? CARE_REMIND_MIN : 0 })) === 'sent') say({ key: 'sent.everyone' });
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <View style={{ flex: 1, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 24, gap: 14 }}>
      <View style={{ height: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View
          accessibilityLabel={care ? 'Care circle' : 'Grandkids circle'}
          style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: care ? C.care : C.kids, alignItems: 'center', justifyContent: 'center' }}
        >
          <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
            {care ? (
              <Path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21.2l8.8-8.8a5.5 5.5 0 0 0 0-7.8z" stroke={C.red} strokeWidth={2.2} strokeLinejoin="round" />
            ) : (
              <>
                <Circle cx={12} cy={12} r={9} stroke={C.amber} strokeWidth={2.2} />
                <Path d="M8.5 14.5c1 1.3 2.2 2 3.5 2s2.5-.7 3.5-2M9 9.5h.01M15 9.5h.01" stroke={C.amber} strokeWidth={2.4} strokeLinecap="round" />
              </>
            )}
          </Svg>
        </View>
        <Dots count={count} current={current} />
      </View>

      {care || request ? (
        request ? (
          <StatusBanner client={client} onPress={ringEveryone} />
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Ring everyone in this circle"
            onPress={ringEveryone}
            style={({ pressed }) => ({ height: 124, borderRadius: 32, backgroundColor: C.green, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.85 : 1 })}
          >
            <PeopleIcon size={72} />
          </Pressable>
        )
      ) : null}

      <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 14, alignContent: 'stretch' }}>
        {people.slice(0, 6).map((m, i) => (
          <Tile key={m.id} member={m} color={TILE_COLORS[i % TILE_COLORS.length]} reply={replies.get(m.id)} rows={Math.ceil(Math.min(people.length, 6) / 2)} onPress={() => router.push({ pathname: '/companion/person', params: { circle: client.circleId!, member: m.id } })} />
        ))}
      </View>

      {error ? <Text style={{ color: C.red, fontSize: 16, textAlign: 'center' }}>{error}</Text> : null}
      {care ? <SosHold /> : null}
    </View>
  );
}

function Dots({ count, current }: { count: number; current: number }) {
  if (count < 2) return null;
  return (
    <View accessibilityLabel={`Page ${current + 1} of ${count}`} style={{ flexDirection: 'row', gap: 10 }}>
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: i === current ? C.ink : C.dot }} />
      ))}
    </View>
  );
}

/** After she asked: who's calling, or who will call when, in Urdu. Tap to hear it again. */
function StatusBanner({ client, onPress }: { client: CircleClient; onPress: () => void }) {
  const request = currentRequest(client)!;
  const line = statusLine(client, request);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${text(line)}. Tap to hear it again`}
      onPress={onPress}
      style={({ pressed }) => ({ height: 124, borderRadius: 32, backgroundColor: C.green, flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 20, opacity: pressed ? 0.85 : 1 })}
    >
      <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: C.white, alignItems: 'center', justifyContent: 'center' }}>
        <Svg width={34} height={34} viewBox="0 0 24 24" fill="none">
          <Path d="M11 5 6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" stroke={C.green} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
        </Svg>
      </View>
      <Text style={[URDU, { flex: 1, color: C.white, fontSize: 24, lineHeight: 46 }]} numberOfLines={2}>
        {text(line)}
      </Text>
    </Pressable>
  );
}

const REPLY_BADGE: Record<CallbackReply, { bg: string; icon: 'phone' | 'clock' }> = {
  now: { bg: C.green, icon: 'phone' },
  '5min': { bg: C.amber, icon: 'clock' },
  morning: { bg: C.amber, icon: 'clock' },
  evening: { bg: C.amber, icon: 'clock' },
};

/** A person: their photo (coming with profile photos), else their name, big. Their answer shows as a badge. */
function Tile({ member, color, reply, rows, onPress }: { member: Member; color: string; reply?: CallbackReply; rows: number; onPress: () => void }) {
  const badge = reply ? REPLY_BADGE[reply] : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={member.name}
      onPress={onPress}
      style={({ pressed }) => ({
        width: '47.5%',
        height: rows > 2 ? '31%' : '47%',
        borderRadius: 28,
        borderWidth: reply === 'now' ? 6 : 4,
        borderColor: reply === 'now' ? C.green : C.ink,
        backgroundColor: color,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 8,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Text style={{ color: C.ink, fontSize: 30, fontWeight: '800', textAlign: 'center' }} numberOfLines={2} adjustsFontSizeToFit>
        {member.name}
      </Text>
      {badge ? (
        <View style={{ position: 'absolute', right: 8, top: 8, width: 46, height: 46, borderRadius: 23, backgroundColor: badge.bg, alignItems: 'center', justifyContent: 'center' }}>
          <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
            {badge.icon === 'phone' ? (
              <Path d="M5 4h3.5l1.5 4-2 1.5a11 11 0 0 0 6.5 6.5l1.5-2 4 1.5V19a1.5 1.5 0 0 1-1.5 1.5A15.5 15.5 0 0 1 3.5 5.5 1.5 1.5 0 0 1 5 4Z" stroke={C.white} strokeWidth={2.2} strokeLinejoin="round" />
            ) : (
              <>
                <Circle cx={12} cy={12} r={9} stroke={C.white} strokeWidth={2.4} />
                <Path d="M12 7v5l3 2" stroke={C.white} strokeWidth={2.4} strokeLinecap="round" />
              </>
            )}
          </Svg>
        </View>
      ) : null}
    </Pressable>
  );
}

function PeopleIcon({ size }: { size: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" stroke={C.white} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Circle cx={9} cy={7} r={4} stroke={C.white} strokeWidth={2} />
    </Svg>
  );
}

/**
 * SOS: press and hold for 2 seconds (a ring fills while she holds, and she
 * hears what it does). It goes to her care circles only. While one is on,
 * a tap opens it.
 */
function SosHold() {
  const sos = useMySos();
  const [fill] = useState(() => new Animated.Value(0));
  const run = useRef<Animated.CompositeAnimation | null>(null);
  const done = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const press = () => {
    if (sos) return router.push('/companion/sos');
    setError(null);
    done.current = false;
    say({ key: 'ui.sos_hold' });
    run.current = Animated.timing(fill, { toValue: 1, duration: SOS_HOLD_MS, easing: Easing.linear, useNativeDriver: false });
    run.current.start(async ({ finished }) => {
      if (!finished) return;
      done.current = true;
      fill.setValue(0);
      try {
        await startMySos((c) => allClients().includes(c) && pageOf(c) === 'care');
        say({ key: 'sos.sent' });
        router.push('/companion/sos');
      } catch (e) {
        setError(errorText(e));
      }
    });
  };
  const release = () => {
    if (sos) return;
    run.current?.stop();
    // Let go early: nothing is sent, and the spoken warning stops.
    if (!done.current) hush();
    Animated.timing(fill, { toValue: 0, duration: 150, useNativeDriver: false }).start();
  };

  return (
    <View style={{ gap: 6 }}>
      {error ? <Text style={{ color: C.red, fontSize: 16, textAlign: 'center' }}>{error}</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={sos ? 'SOS is on. Open it' : 'SOS, press and hold'}
        onPressIn={press}
        onPressOut={release}
        style={{ height: 84, borderRadius: 42, backgroundColor: C.red, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', borderWidth: sos ? 5 : 0, borderColor: C.ink }}
      >
        <Animated.View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.28)', width: fill.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }} />
        <Text style={{ color: C.white, fontSize: 40, fontWeight: '800', letterSpacing: 4 }}>SOS</Text>
      </Pressable>
    </View>
  );
}
