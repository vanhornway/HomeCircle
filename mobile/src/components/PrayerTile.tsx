import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { MADHABS, PRAYERS, prayerNow, type CircleClient, type MemberLocation, type PrayerDays } from '@homecircle/core';
import { usePrayer } from '../lib/plugins';
import { useSettings } from '../lib/storage';
import { useTheme } from '../theme';
import { Pill, type Face } from './TileParts';

// The square takes the colour of the sky at that prayer.
const SKY: Record<string, { bg: string; ink: string }> = {
  fajr: { bg: '#3E5C9A', ink: '#fff' },
  dhuhr: { bg: '#E3B341', ink: '#3A2E00' },
  asr: { bg: '#E08A3C', ink: '#fff' },
  maghrib: { bg: '#C8553D', ink: '#fff' },
  isha: { bg: '#2E3F73', ink: '#fff' },
};
const COUNTDOWN = { bg: '#CFC8F5', ink: '#2B2550' };
const NOW = { bg: '#BFE3D0', ink: '#13402B' };

/** "5:12 am" as the clock reads where the times are (`offset`: minutes from UTC). */
export function clockAt(ms: number | null, offset: number) {
  if (ms == null) return '–';
  const d = new Date(ms + offset * 60_000);
  const h = d.getUTCHours();
  return `${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

/** "in 1 h 20 m", "in 12 m". */
const until = (ms: number, now: number) => {
  const m = Math.max(1, Math.round((ms - now) / 60_000));
  return m < 60 ? `in ${m} m` : `in ${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} m` : ''}`;
};

/** How the place's clock compares with this phone's: "3 h ahead of you", or nothing. */
function zoneNote(data: PrayerDays, now: number) {
  if (data.roughZone) return 'Times by the sun (time zone not known)';
  const diff = data.days[0].offset + new Date(now).getTimezoneOffset();
  if (!diff) return null;
  const h = Math.abs(diff) / 60;
  return `Times there: ${Number.isInteger(h) ? h : h.toFixed(1)} h ${diff > 0 ? 'ahead of' : 'behind'} you`;
}

/** The time now, every 30 seconds, so "next" moves on when a prayer's time comes. */
function useNow() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The next prayer where someone is, for your madhab; big, the day's five with their windows. */
export function PrayerFace({ client, loc, title, big, z }: { client: CircleClient; loc: MemberLocation } & Face) {
  const t = useTheme();
  const { prayerMadhab } = useSettings();
  const { data, error } = usePrayer(client, loc, prayerMadhab);
  const now = useNow();
  const state = data ? prayerNow(data.days, now) : null;
  const next = state?.next ?? null;
  const current = state?.current ?? null;
  const offsetOf = (date: string) => data?.days.find((d) => d.date === date)?.offset ?? data?.days[0].offset ?? 0;
  const sky = SKY[next?.id ?? 'isha'];
  const madhab = MADHABS.find((m) => m.id === prayerMadhab)?.label ?? prayerMadhab;
  const today = data?.days[0];

  return (
    <View
      style={{ flex: 1, gap: z(6) }}
      accessible
      accessibilityLabel={
        next ? `Prayer times, ${title}: next ${next.name} at ${clockAt(next.start, offsetOf(next.date))}, ${until(next.start, now)}${current ? `; ${current.name} until ${clockAt(current.end, offsetOf(current.date))}` : ''}` : 'Prayer times'
      }
    >
      <Text style={{ color: t.text, fontSize: z(13), fontWeight: '700', textAlign: 'center' }} numberOfLines={1}>
        {title}
      </Text>
      {!data || !next ? (
        <Text style={{ flex: 1, color: t.muted, fontSize: z(13), textAlign: 'center', textAlignVertical: 'center' }}>
          {error ? 'Prayer times unavailable' : data ? 'No prayer times here today' : 'Prayer times…'}
        </Text>
      ) : (
        <>
          <View style={{ flexDirection: 'row', gap: z(6), ...(big ? { height: z(76) } : { flex: 1 }) }}>
            <View style={{ flex: 1, borderRadius: z(18), padding: z(8), justifyContent: 'flex-end', backgroundColor: sky.bg }}>
              <Text style={{ position: 'absolute', top: z(6), right: z(8), fontSize: z(16) }}>🕌</Text>
              <Text style={{ color: sky.ink, fontSize: z(11), fontWeight: '600', opacity: 0.9 }}>Next</Text>
              <Text style={{ color: sky.ink, fontSize: z(22), fontWeight: '800', lineHeight: z(26) }} numberOfLines={1}>
                {next.name}
              </Text>
              <Text style={{ color: sky.ink, fontSize: z(13), fontWeight: '700' }} numberOfLines={1}>
                {clockAt(next.start, offsetOf(next.date))}
              </Text>
            </View>
            <View style={{ width: z(big ? 84 : 74), gap: z(4) }}>
              <Pill z={z} bg={COUNTDOWN.bg}>
                <Text style={{ color: COUNTDOWN.ink, fontSize: z(big ? 13 : 12), fontWeight: '700' }} numberOfLines={1}>
                  {until(next.start, now)}
                </Text>
              </Pill>
              <Pill z={z} bg={current ? NOW.bg : t.surface2}>
                <Text style={{ color: current ? NOW.ink : t.muted, fontSize: z(11), fontWeight: '700', textAlign: 'center' }} numberOfLines={2}>
                  {current ? `${current.name} now` : 'Between'}
                </Text>
              </Pill>
            </View>
          </View>
          <Text style={{ color: t.text, fontSize: z(12), fontWeight: '700', textAlign: 'center' }} numberOfLines={1}>
            {current ? `${current.name} until ${clockAt(current.end, offsetOf(current.date))}` : `${madhab} · approximate`}
          </Text>
          {big && today ? (
            <>
              <View style={{ gap: 3 }}>
                {PRAYERS.map((p) => {
                  const start = today.times[p.id];
                  const end = today.times[p.until];
                  const isNow = current?.id === p.id && current.date === today.date;
                  const isNext = next.id === p.id && next.date === today.date;
                  return (
                    <View
                      key={p.id}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingVertical: 3,
                        paddingHorizontal: 8,
                        borderRadius: 10,
                        backgroundColor: isNow ? NOW.bg : 'transparent',
                      }}
                    >
                      <View style={{ width: 8, height: 8, borderRadius: 4, marginRight: 8, backgroundColor: SKY[p.id].bg }} />
                      <Text style={{ width: 62, color: isNow ? NOW.ink : t.text, fontSize: 13, fontWeight: isNow || isNext ? '800' : '600' }}>{p.name}</Text>
                      <Text style={{ flex: 1, color: isNow ? NOW.ink : t.text, fontSize: 13, fontVariant: ['tabular-nums'] }} numberOfLines={1}>
                        {clockAt(start, today.offset)} – {clockAt(end, today.offset)}
                      </Text>
                      {isNext ? <Text style={{ color: t.muted, fontSize: 10 }}>next</Text> : null}
                    </View>
                  );
                })}
              </View>
              <Text style={{ marginTop: 'auto', color: t.muted, fontSize: 10 }} numberOfLines={3}>
                {[zoneNote(data, now), `${madhab} · ${data.method.name} · approximate: allow a few minutes`].filter(Boolean).join('\n')}
              </Text>
            </>
          ) : null}
        </>
      )}
    </View>
  );
}
