// Weather: the weather where the person you select on the map is. The phone
// sends only a grid cell, its position rounded to 0.1° (about 10 km), and the
// server asks Open-Meteo (free, no account or key) for that cell. Answers are
// kept 15 minutes per cell, so a family looking at one town makes one call; who
// asked is never kept. Data: Open-Meteo, CC BY 4.0.
import { fail } from '../http.js';

const TTL_MS = 15 * 60_000;
const MAX_CELLS = 500;
const cellOf = (v) => Math.round(v * 10) / 10;
const num = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

export const weather = {
  id: 'weather',
  feature: 'weather',
  name: 'Weather',
  hosts: ['api.open-meteo.com'],
  start: () => ({ cache: new Map() }),
  routes: [
    {
      method: 'GET',
      path: '/now',
      handler: async ({ query, fetch, state, log }) => {
        const lat = Number(query.get('lat'));
        const lng = Number(query.get('lng'));
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) fail(400, 'invalid', 'lat and lng must be a position');
        const cell = { lat: cellOf(lat), lng: cellOf(lng) };
        const key = `${cell.lat},${cell.lng}`;
        const hit = state.cache.get(key);
        if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
        let raw;
        try {
          raw = await fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${cell.lat}&longitude=${cell.lng}` +
              '&current=temperature_2m,apparent_temperature,weather_code,is_day' +
              '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
              '&hourly=temperature_2m,precipitation_probability,weather_code,is_day&forecast_hours=12&forecast_days=1&timezone=auto',
          );
        } catch (e) {
          log('weather: Open-Meteo failed', e.message);
          fail(502, 'unavailable', 'The weather isn’t available right now');
        }
        const data = shape(raw, cell);
        state.cache.set(key, { at: Date.now(), data });
        // Oldest first out, so the cache stays small.
        while (state.cache.size > MAX_CELLS) state.cache.delete(state.cache.keys().next().value);
        return data;
      },
    },
  ],
};

/** Open-Meteo's answer, cut to what the tile shows. Temperatures in °C (phones convert). */
export function shape(raw, cell) {
  const c = raw?.current ?? {};
  const d = raw?.daily ?? {};
  const h = raw?.hourly ?? {};
  return {
    cell,
    at: c.time ?? null,
    timezone: raw?.timezone ?? null,
    now: { temp: num(c.temperature_2m), feels: num(c.apparent_temperature), code: c.weather_code ?? null, day: c.is_day !== 0 },
    today: { high: num(d.temperature_2m_max?.[0]), low: num(d.temperature_2m_min?.[0]), rain: d.precipitation_probability_max?.[0] ?? null },
    hours: (h.time ?? []).slice(0, 12).map((time, i) => ({
      time,
      temp: num(h.temperature_2m?.[i]),
      rain: h.precipitation_probability?.[i] ?? null,
      code: h.weather_code?.[i] ?? null,
      day: h.is_day?.[i] !== 0,
    })),
    units: 'C',
    source: 'Open-Meteo',
  };
}
