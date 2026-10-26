import { Text, View } from 'react-native';
import type { AirQuality, CircleClient, MemberLocation } from '@homecircle/core';
import { useAir } from '../lib/plugins';
import { useTheme } from '../theme';
import { HourGrid, Pill, type Face } from './TileParts';

// The square takes the US AQI band's colour (EPA's, softened to sit on the map).
const BANDS: { max: number; bg: string; ink: string }[] = [
  { max: 50, bg: '#3FA66B', ink: '#fff' },
  { max: 100, bg: '#E3BE3B', ink: '#3A2E00' },
  { max: 150, bg: '#EE8A3C', ink: '#fff' },
  { max: 200, bg: '#DC4A3F', ink: '#fff' },
  { max: 300, bg: '#8F3F97', ink: '#fff' },
  { max: Infinity, bg: '#7E0023', ink: '#fff' },
];
const band = (aqi: number | null) => (aqi == null ? { bg: '#8E98A6', ink: '#fff' } : BANDS.find((b) => aqi <= b.max)!);
// Pollen 0 none … 5 very high.
const POLLEN = ['#D6EFD9', '#D6EFD9', '#E6F0C2', '#F6E3A1', '#F7C08A', '#F29B8C'];
const POLLEN_INK = '#2E2A1E';
const SHORT = ['None', 'V. low', 'Low', 'Mod.', 'High', 'V. high'];
const ICON = { tree: '🌳', grass: '🌾', weed: '🌿' } as const;

const hourLabel = (iso: string) => {
  const h = Number(iso.slice(11, 13));
  return h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`;
};
const words = (a: AirQuality) =>
  [
    `Air quality ${a.aqi.us ?? 'unknown'}${a.aqi.category ? `, ${a.aqi.category}` : ''}`,
    ...(a.pollen?.types.map((p) => `${p.label} pollen ${p.category ?? 'unknown'}`) ?? ['pollen not available here']),
  ].join('; ');

/** Air quality and pollen where someone is, laid out like the weather; big, with the next 12 hours. */
export function AirFace({ client, loc, title, big, z }: { client: CircleClient; loc: MemberLocation } & Face) {
  const t = useTheme();
  const { data, error } = useAir(client, loc);
  const b = band(data?.aqi.us ?? null);
  return (
    <View style={{ flex: 1, gap: z(6) }} accessible accessibilityLabel={data ? `${title}: ${words(data)}` : 'Air quality'}>
      <Text
        style={{
          color: t.text,
          fontSize: z(13),
          fontWeight: '700',
          textAlign: 'center',
        }}
        numberOfLines={1}
      >
        {title}
      </Text>
      {!data ? (
        <Text
          style={{
            flex: 1,
            color: t.muted,
            fontSize: z(13),
            textAlign: 'center',
            textAlignVertical: 'center',
          }}
        >
          {error ? 'Air quality unavailable' : 'Air quality…'}
        </Text>
      ) : (
        <>
          <View
            style={{
              flexDirection: 'row',
              gap: z(6),
              ...(big ? { height: z(100) } : { flex: 1 }),
            }}
          >
            <View
              style={{
                flex: 1,
                borderRadius: z(18),
                padding: z(8),
                justifyContent: 'flex-end',
                backgroundColor: b.bg,
              }}
            >
              <Text
                style={{
                  position: 'absolute',
                  top: z(6),
                  right: z(8),
                  fontSize: z(18),
                }}
              >
                🌬️
              </Text>
              <Text
                style={{
                  color: b.ink,
                  fontSize: z(30),
                  fontWeight: '800',
                  lineHeight: z(34),
                }}
              >
                {data.aqi.us ?? '–'}
              </Text>
              <Text style={{ color: b.ink, fontSize: z(11), fontWeight: '600' }}>Air (US AQI)</Text>
            </View>
            <View style={{ width: z(big ? 84 : 74), gap: z(4) }}>
              {data.pollen ? (
                data.pollen.types.map((p) => (
                  <Pill key={p.id} z={z} bg={POLLEN[p.level ?? 0]}>
                    <Text
                      style={{
                        color: POLLEN_INK,
                        fontSize: z(big ? 12 : 11),
                        fontWeight: '700',
                      }}
                      numberOfLines={1}
                    >
                      {ICON[p.id]} {p.level == null ? '–' : big ? p.category : SHORT[p.level]}
                    </Text>
                  </Pill>
                ))
              ) : (
                <Pill z={z} bg={t.surface2}>
                  <Text
                    style={{
                      color: t.muted,
                      fontSize: z(11),
                      fontWeight: '600',
                      textAlign: 'center',
                    }}
                  >
                    🌼 Pollen{'\n'}n/a here
                  </Text>
                </Pill>
              )}
            </View>
          </View>
          <Text
            style={{
              color: t.text,
              fontSize: z(13),
              fontWeight: '700',
              textAlign: 'center',
            }}
            numberOfLines={1}
          >
            {data.aqi.category ?? 'Air quality'}
          </Text>
          {big ? (
            <>
              <HourGrid
                hours={data.hours.map((h) => ({
                  key: h.time,
                  label: hourLabel(h.time),
                  top: null,
                  value: h.aqi == null ? '–' : String(h.aqi),
                  dot: band(h.aqi).bg,
                }))}
              />
              <Text style={{ color: t.muted, fontSize: 11, textAlign: 'center' }}>
                PM2.5 {data.aqi.pm25 ?? '–'} · PM10 {data.aqi.pm10 ?? '–'} · Ozone {data.aqi.ozone ?? '–'} µg/m³
              </Text>
              {!data.pollen ? (
                <Text style={{ color: t.muted, fontSize: 11, textAlign: 'center' }}>
                  {client.isAdmin ? 'Pollen here needs a Google Pollen key: Settings → Features.' : 'Pollen isn’t available here.'}
                </Text>
              ) : null}
              <Text style={{ marginTop: 'auto', color: t.muted, fontSize: 10 }}>
                Air: Open-Meteo
                {data.pollen ? ` · Pollen: ${data.pollen.source}` : ''}
              </Text>
            </>
          ) : null}
        </>
      )}
    </View>
  );
}
