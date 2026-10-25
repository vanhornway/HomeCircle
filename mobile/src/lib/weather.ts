// The weather plugin, seen from the phone: the weather for a person's grid
// cell (the server is sent only the cell), what its codes mean, °F or °C,
// and a name for where they are (their place, or the town, named on this
// phone so no one else is asked).
import { useEffect, useState } from 'react';
import * as Location from 'expo-location';
import type { CircleClient, MemberLocation, Weather } from '@homecircle/core';

const FRESH_MS = 10 * 60_000;
const cellKey = (lat: number, lng: number) => `${Math.round(lat * 10) / 10},${Math.round(lng * 10) / 10}`;
const cache = new Map<string, { at: number; data: Weather }>();
const towns = new Map<string, string | null>();

/** WMO weather codes (what Open-Meteo sends) → words and an icon. */
export function describe(code: number | null, day = true): { text: string; icon: string; tone: 'clear' | 'cloud' | 'rain' | 'snow' | 'storm' | 'fog' } {
  const c = code ?? -1;
  if (c === 0) return { text: day ? 'Sunny' : 'Clear', icon: day ? '☀️' : '🌙', tone: 'clear' };
  if (c === 1) return { text: day ? 'Mostly sunny' : 'Mostly clear', icon: day ? '🌤️' : '🌙', tone: 'clear' };
  if (c === 2) return { text: 'Partly cloudy', icon: day ? '⛅' : '☁️', tone: 'cloud' };
  if (c === 3) return { text: 'Mostly cloudy', icon: '☁️', tone: 'cloud' };
  if (c === 45 || c === 48) return { text: 'Fog', icon: '🌫️', tone: 'fog' };
  if (c >= 51 && c <= 57) return { text: 'Drizzle', icon: '🌦️', tone: 'rain' };
  if ((c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return { text: c === 65 || c === 82 ? 'Heavy rain' : 'Rain', icon: '🌧️', tone: 'rain' };
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return { text: 'Snow', icon: '🌨️', tone: 'snow' };
  if (c >= 95) return { text: 'Thunderstorms', icon: '⛈️', tone: 'storm' };
  return { text: '—', icon: '🌡️', tone: 'cloud' };
}

/** °F where the phone's region uses it (US and a few others), unless chosen. */
export function prefersFahrenheit(choice: 'auto' | 'f' | 'c'): boolean {
  if (choice !== 'auto') return choice === 'f';
  let locale = 'en-US';
  try {
    locale = Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    // keep the default
  }
  const region = locale.split(/[-_]/).at(-1)?.toUpperCase() ?? '';
  return ['US', 'LR', 'MM', 'BS', 'BZ', 'KY', 'PW', 'FM', 'MH'].includes(region);
}

/** "65°" from °C, in the units chosen. */
export const deg = (c: number | null, f: boolean) => (c == null ? '–' : `${Math.round(f ? c * 1.8 + 32 : c)}°`);

/** The weather for someone's location, refreshed every 10 minutes while shown. */
export function useWeather(client: CircleClient, loc: MemberLocation | undefined) {
  const key = loc ? cellKey(loc.lat, loc.lng) : null;
  const [state, setState] = useState<{ key: string | null; data: Weather | null; error: string | null }>(() => ({ key, data: key ? (cache.get(key)?.data ?? null) : null, error: null }));
  useEffect(() => {
    if (!key || !loc) return;
    let live = true;
    const load = () => {
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < FRESH_MS) {
        setState({ key, data: hit.data, error: null });
        return;
      }
      client.api
        .weather(loc.lat, loc.lng)
        .then((data: Weather) => {
          cache.set(key, { at: Date.now(), data });
          if (live) setState({ key, data, error: null });
        })
        .catch((e: Error) => live && setState({ key, data: cache.get(key)?.data ?? null, error: e.message }));
    };
    load();
    const timer = setInterval(load, FRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // loc changes on every update; the cell is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);
  return state.key === key ? state : { key, data: null, error: null };
}

/** Where someone is, in words: the circle's place they're at, else the town (named on this phone). */
export function usePlaceName(client: CircleClient, loc: MemberLocation | undefined): string | null {
  const place = loc?.placeId ? client.places.get(loc.placeId)?.name : null;
  const key = loc ? cellKey(loc.lat, loc.lng) : null;
  // A town already named for this cell is used straight away; a new one is looked up once.
  const [, named] = useState(0);
  useEffect(() => {
    if (!key || !loc || place || towns.has(key)) return;
    let live = true;
    Location.reverseGeocodeAsync({ latitude: loc.lat, longitude: loc.lng })
      .then((r) => {
        const a = r[0];
        towns.set(key, a?.city || a?.district || a?.subregion || a?.region || null);
        if (live) named((n) => n + 1);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, place]);
  return place ?? (key ? (towns.get(key) ?? null) : null);
}
