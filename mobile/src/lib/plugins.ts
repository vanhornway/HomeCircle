// What the map-tile plugins share on the phone: data for a person's grid cell
// (the server is sent only the cell, 0.1°), kept 10 minutes and refreshed
// while shown; and Home Assistant's name for a person.
import { useEffect, useState } from 'react';
import type { AirQuality, CircleClient, Madhab, MemberLocation, PrayerDays } from '@homecircle/core';

const FRESH_MS = 10 * 60_000;
export const cellKey = (lat: number, lng: number) => `${Math.round(lat * 10) / 10},${Math.round(lng * 10) / 10}`;
const cache = new Map<string, { at: number; data: unknown }>();

/** A plugin's data for someone's location, refreshed every 10 minutes while shown. */
export function useCellData<T>(kind: string, client: CircleClient, loc: MemberLocation | undefined, load: (lat: number, lng: number) => Promise<T>) {
  const key = loc ? `${kind}:${cellKey(loc.lat, loc.lng)}` : null;
  const [state, setState] = useState<{
    key: string | null;
    data: T | null;
    error: string | null;
  }>(() => ({
    key,
    data: key ? ((cache.get(key)?.data as T) ?? null) : null,
    error: null,
  }));
  useEffect(() => {
    if (!key || !loc) return;
    let live = true;
    const get = () => {
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < FRESH_MS) {
        setState({ key, data: hit.data as T, error: null });
        return;
      }
      load(loc.lat, loc.lng)
        .then((data) => {
          cache.set(key, { at: Date.now(), data });
          if (live) setState({ key, data, error: null });
        })
        .catch(
          (e: Error) =>
            live &&
            setState({
              key,
              data: (cache.get(key)?.data as T) ?? null,
              error: e.message,
            }),
        );
    };
    get();
    const timer = setInterval(get, FRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // loc changes on every update; the cell is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);
  return state.key === key ? state : { key, data: null, error: null };
}

/** Air quality and pollen for someone's location. */
export const useAir = (client: CircleClient, loc: MemberLocation | undefined) => useCellData<AirQuality>('air', client, loc, (lat, lng) => client.api.air(lat, lng));

/** Today's and tomorrow's prayer times where someone is, for your madhab. */
export const usePrayer = (client: CircleClient, loc: MemberLocation | undefined, madhab: Madhab) =>
  useCellData<PrayerDays>(`prayer-${madhab}`, client, loc, (lat, lng) => client.api.prayer(lat, lng, madhab));

/** Home Assistant's entity id part for a name ("Maya Ali" → maya_ali). */
export const slugName = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
