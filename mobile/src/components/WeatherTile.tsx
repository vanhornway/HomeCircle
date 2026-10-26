import { Pressable, Text, View } from 'react-native';
import type { CircleClient, MemberLocation } from '@homecircle/core';
import { updateSettings, useSettings } from '../lib/storage';
import { deg, describe, prefersFahrenheit, useWeather } from '../lib/weather';
import { useTheme } from '../theme';
import { HourGrid, Pill, type Face } from './TileParts';

// The big square takes the sky's colour; the pills stay the same, as on a watch face.
const SKY = {
  clear: ['#5B8DEF', '#2E3F73'],
  cloud: ['#6F86B3', '#3A4560'],
  rain: ['#4E79A7', '#2C3E57'],
  snow: ['#8BA6C9', '#4B5B73'],
  storm: ['#5D568C', '#36325A'],
  fog: ['#8E98A6', '#4C535E'],
} as const;
const HIGH_LOW = { bg: '#CFC8F5', ink: '#2B2550' };
const RAIN = { bg: '#7CCBF2', ink: '#0B3550' };

const hourLabel = (iso: string) => {
  const h = Number(iso.slice(11, 13));
  return h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`;
};

/** The weather where someone is, laid out like a watch face; big, with the next 12 hours too. */
export function WeatherFace({ client, loc, title, big, z }: { client: CircleClient; loc: MemberLocation } & Face) {
  const t = useTheme();
  const settings = useSettings();
  const { data, error } = useWeather(client, loc);
  const f = prefersFahrenheit(settings.weatherUnits);
  const sky = data ? describe(data.now.code, data.now.day) : null;
  const square = SKY[sky?.tone ?? 'cloud'][data?.now.day === false ? 1 : 0];
  return (
    <View
      style={{ flex: 1, gap: z(6) }}
      accessible
      accessibilityLabel={
        data && sky ? `Weather, ${title}: ${deg(data.now.temp, f)}, ${sky.text}, high ${deg(data.today.high, f)}, low ${deg(data.today.low, f)}, ${data.today.rain ?? 0}% chance of rain` : 'Weather'
      }
    >
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
          {error ? 'Weather unavailable' : 'Weather…'}
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
                backgroundColor: square,
              }}
            >
              <Text
                style={{
                  position: 'absolute',
                  top: z(6),
                  right: z(8),
                  fontSize: z(20),
                }}
              >
                {sky?.icon}
              </Text>
              <Text
                style={{
                  color: '#fff',
                  fontSize: z(30),
                  fontWeight: '800',
                  lineHeight: z(34),
                }}
              >
                {deg(data.now.temp, f)}
              </Text>
              <Text style={{ color: '#fff', fontSize: z(11), fontWeight: '600' }}>Feels {deg(data.now.feels, f)}</Text>
            </View>
            <View style={{ width: z(74), gap: z(6) }}>
              <Pill z={z} bg={HIGH_LOW.bg}>
                <Text
                  style={{
                    color: HIGH_LOW.ink,
                    fontSize: z(13),
                    fontWeight: '600',
                  }}
                >
                  ↑ {deg(data.today.high, f)}
                </Text>
                <Text
                  style={{
                    color: HIGH_LOW.ink,
                    fontSize: z(13),
                    fontWeight: '600',
                  }}
                >
                  ↓ {deg(data.today.low, f)}
                </Text>
              </Pill>
              <Pill z={z} bg={RAIN.bg}>
                <Text
                  style={{
                    color: RAIN.ink,
                    fontSize: z(13),
                    fontWeight: '700',
                  }}
                >
                  ☔ {data.today.rain ?? 0}%
                </Text>
              </Pill>
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
            {sky?.text}
          </Text>
          {big ? (
            <>
              <HourGrid
                hours={data.hours.map((h) => ({
                  key: h.time,
                  label: hourLabel(h.time),
                  top: describe(h.code, h.day).icon,
                  value: deg(h.temp, f),
                  note: h.rain ? `${h.rain}%` : '',
                }))}
              />
              <View
                style={{
                  marginTop: 'auto',
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <Text style={{ color: t.muted, fontSize: 10 }}>Weather: Open-Meteo</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={f ? 'Show °C' : 'Show °F'}
                  hitSlop={8}
                  onPress={() => updateSettings({ weatherUnits: f ? 'c' : 'f' })}
                  style={{
                    paddingHorizontal: 8,
                    paddingVertical: 3,
                    borderRadius: 999,
                    backgroundColor: t.surface2,
                  }}
                >
                  <Text style={{ color: t.text, fontSize: 11, fontWeight: '600' }}>{f ? '°F · use °C' : '°C · use °F'}</Text>
                </Pressable>
              </View>
            </>
          ) : null}
        </>
      )}
    </View>
  );
}
