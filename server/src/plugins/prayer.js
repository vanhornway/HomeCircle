// Prayer times: the five daily prayers where the person you select is, for
// the madhab of whoever is looking. The phone sends only a grid cell (0.1°,
// about 10 km: a minute or less of difference); the server works the times out
// itself (packages/core/src/prayer.js) and asks Open-Meteo only for the cell's
// time zone, kept a week per cell, so the times show as the clock there reads.
import { fail } from '../http.js';
import { DEFAULT_MADHAB, MADHABS, METHODS, methodFor, prayerTimes } from '../../../packages/core/src/prayer.js';

const ZONE_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_CELLS = 2000;
const DAY_MS = 24 * 60 * 60_000;
const cellOf = (v) => Math.round(v * 10) / 10;
const pad = (n) => String(n).padStart(2, '0');

/** The date there and its offset from UTC in minutes, at an instant (a zone, or a fixed offset if none is known). */
export function localDay(ms, zone, fallbackOffset) {
  if (!zone) {
    const d = new Date(ms + fallbackOffset * 60_000);
    return { date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, offset: fallbackOffset };
  }
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ms);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const there = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return { date: `${get('year')}-${pad(get('month'))}-${pad(get('day'))}`, offset: Math.round((there - Math.floor(ms / 60_000) * 60_000) / 60_000) };
}

export const prayer = {
  id: 'prayer',
  feature: 'prayer',
  name: 'Prayer times',
  hosts: ['api.open-meteo.com'],
  start: () => ({ zones: new Map() }),
  routes: [
    {
      method: 'GET',
      path: '/times',
      handler: async ({ query, fetch, state, log }) => {
        const lat = Number(query.get('lat'));
        const lng = Number(query.get('lng'));
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) fail(400, 'invalid', 'lat and lng must be a position');
        const madhab = MADHABS.some((m) => m.id === query.get('madhab')) ? query.get('madhab') : DEFAULT_MADHAB;
        const cell = { lat: cellOf(lat), lng: cellOf(lng) };
        const key = `${cell.lat},${cell.lng}`;

        // The cell's time zone; if Open-Meteo can't be reached, the sun's (longitude ÷ 15), marked rough.
        let zone = state.zones.get(key);
        if (!zone || Date.now() - zone.at > ZONE_TTL_MS) {
          try {
            const raw = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${cell.lat}&longitude=${cell.lng}&daily=sunrise&forecast_days=1&timezone=auto`);
            zone = { at: Date.now(), name: typeof raw?.timezone === 'string' && raw.timezone !== 'GMT' ? raw.timezone : null };
            state.zones.set(key, zone);
            while (state.zones.size > MAX_CELLS) state.zones.delete(state.zones.keys().next().value);
          } catch (e) {
            log('prayer: time zone lookup failed', e.message);
            zone = { at: 0, name: null };
          }
        }
        const fallback = Math.round(cell.lng / 15) * 60;
        const method = methodFor(zone.name, madhab);
        const now = Date.now();
        // Today and tomorrow there: after Isha, the next prayer is tomorrow's Fajr.
        const days = [now, now + DAY_MS].map((ms) => {
          const { date } = localDay(ms, zone.name, fallback);
          const times = prayerTimes({ ...cell, date, madhab, method });
          const { offset } = localDay(times.dhuhr ?? ms, zone.name, fallback);
          return { date, offset, times };
        });
        return { cell, timezone: zone.name, roughZone: !zone.name, madhab, method: { id: method, name: METHODS[method].name }, days, source: 'Worked out on your server' };
      },
    },
  ],
};
