import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { CircleClient } from '@homecircle/core';
import { updateSettings, useSettings } from '../lib/storage';
import { deg, describe, prefersFahrenheit, usePlaceName, useWeather } from '../lib/weather';
import { useTheme } from '../theme';

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
  return h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`;
};

/**
 * The weather plugin's tile, in the map's top-right corner: the weather where
 * the selected person is (or you), laid out like a watch face. Tap it for the
 * next 12 hours.
 */
export function WeatherTile({ client, memberId }: { client: CircleClient; memberId: string | null }) {
  const t = useTheme();
  const settings = useSettings();
  const [open, setOpen] = useState(false);
  const me = client.account?.memberId ?? null;
  const id = memberId ?? me;
  const loc = id ? client.locations.get(id) : undefined;
  const who = id && id !== me ? client.members.get(id)?.name : null;
  const { data, error } = useWeather(client, loc);
  const place = usePlaceName(client, loc);
  if (!loc) return null;
  const f = prefersFahrenheit(settings.weatherUnits);
  const sky = data ? describe(data.now.code, data.now.day) : null;
  const square = SKY[sky?.tone ?? 'cloud'][data?.now.day === false ? 1 : 0];
  const title = [who, place].filter(Boolean).join(' · ') || 'Weather';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={data && sky ? `Weather for ${who ?? 'you'}${place ? ` in ${place}` : ''}: ${deg(data.now.temp, f)}, ${sky.text}, high ${deg(data.today.high, f)}, low ${deg(data.today.low, f)}, ${data.today.rain ?? 0}% chance of rain` : 'Weather'}
      onPress={() => setOpen((v) => !v)}
      style={{ width: open ? 252 : 176, borderRadius: 22, padding: 8, gap: 6, backgroundColor: t.surface, shadowColor: '#000', shadowOpacity: 0.16, shadowRadius: 10, elevation: 4 }}
    >
      <Text style={{ color: t.text, fontSize: 13, fontWeight: '700', textAlign: 'center' }} numberOfLines={1}>
        {title}
      </Text>
      {!data ? (
        <Text style={{ color: t.muted, fontSize: 13, textAlign: 'center', paddingVertical: 24 }}>{error ? 'Weather unavailable' : 'Weather…'}</Text>
      ) : (
        <>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            <View style={{ flex: 1, height: 100, borderRadius: 18, padding: 8, justifyContent: 'flex-end', backgroundColor: square }}>
              <Text style={{ position: 'absolute', top: 6, right: 8, fontSize: 20 }}>{sky?.icon}</Text>
              <Text style={{ color: '#fff', fontSize: 30, fontWeight: '800', lineHeight: 34 }}>{deg(data.now.temp, f)}</Text>
              <Text style={{ color: '#fff', fontSize: 11, fontWeight: '600' }}>Feels {deg(data.now.feels, f)}</Text>
            </View>
            <View style={{ width: 74, gap: 6 }}>
              <View style={{ flex: 1, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: HIGH_LOW.bg }}>
                <Text style={{ color: HIGH_LOW.ink, fontSize: 13, fontWeight: '600' }}>↑ {deg(data.today.high, f)}</Text>
                <Text style={{ color: HIGH_LOW.ink, fontSize: 13, fontWeight: '600' }}>↓ {deg(data.today.low, f)}</Text>
              </View>
              <View style={{ flex: 1, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: RAIN.bg }}>
                <Text style={{ color: RAIN.ink, fontSize: 13, fontWeight: '700' }}>☔ {data.today.rain ?? 0}%</Text>
              </View>
            </View>
          </View>
          <Text style={{ color: t.text, fontSize: 13, fontWeight: '700', textAlign: 'center' }}>{sky?.text}</Text>
          {open ? (
            <View style={{ gap: 6 }}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingHorizontal: 2 }}>
                {data.hours.map((h) => (
                  <View key={h.time} style={{ alignItems: 'center', gap: 2, minWidth: 40 }}>
                    <Text style={{ color: t.muted, fontSize: 11 }}>{hourLabel(h.time)}</Text>
                    <Text style={{ fontSize: 16 }}>{describe(h.code, h.day).icon}</Text>
                    <Text style={{ color: t.text, fontSize: 13, fontWeight: '600' }}>{deg(h.temp, f)}</Text>
                    <Text style={{ color: t.muted, fontSize: 10 }}>{h.rain ? `${h.rain}%` : ' '}</Text>
                  </View>
                ))}
              </ScrollView>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={{ color: t.muted, fontSize: 10 }}>Weather: Open-Meteo</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={f ? 'Show °C' : 'Show °F'}
                  hitSlop={8}
                  onPress={() => updateSettings({ weatherUnits: f ? 'c' : 'f' })}
                  style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, backgroundColor: t.surface2 }}
                >
                  <Text style={{ color: t.text, fontSize: 11, fontWeight: '600' }}>{f ? '°F · switch to °C' : '°C · switch to °F'}</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
        </>
      )}
    </Pressable>
  );
}
