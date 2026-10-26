// Air and pollen: the air quality and pollen where the person you select on
// the map is. Like weather, the phone sends only a grid cell (0.1°, about
// 10 km). Air quality comes from Open-Meteo (free, no key, worldwide). Pollen
// from Open-Meteo covers only Europe; with a Google Pollen API key in this
// circle's settings, pollen comes from Google instead (most of the world,
// including North America). Answers are kept 30 minutes per cell.
// Data: Open-Meteo (CC BY 4.0), CAMS; Google Pollen API.
import { fail } from '../http.js';

const TTL_MS = 30 * 60_000;
const MAX_CELLS = 500;
const cellOf = (v) => Math.round(v * 10) / 10;
const int = (v) => (Number.isFinite(v) ? Math.round(v) : null);

// US AQI bands (EPA).
const AQI = [
  [50, 'Good'],
  [100, 'Moderate'],
  [150, 'Unhealthy for sensitive groups'],
  [200, 'Unhealthy'],
  [300, 'Very unhealthy'],
  [Infinity, 'Hazardous'],
];
export const aqiCategory = (v) => (v == null ? null : AQI.find(([max]) => v <= max)[1]);

// Pollen levels on one scale for both sources: 0 none … 5 very high (as Google's index).
const LEVELS = ['None', 'Very low', 'Low', 'Moderate', 'High', 'Very high'];
// Grains per m³ where each level starts (US National Allergy Bureau bands).
const BANDS = { tree: [15, 90, 1500], grass: [5, 20, 200], weed: [10, 50, 500] };
const TYPES = [
  ['tree', 'Trees', ['alder_pollen', 'birch_pollen', 'olive_pollen']],
  ['grass', 'Grass', ['grass_pollen']],
  ['weed', 'Weeds', ['mugwort_pollen', 'ragweed_pollen']],
];

/** Grains per m³ → level 0…5. */
export function grainsLevel(type, grains) {
  if (grains == null) return null;
  if (grains < 1) return 0;
  const [moderate, high, veryHigh] = BANDS[type];
  return grains >= veryHigh ? 5 : grains >= high ? 4 : grains >= moderate ? 3 : 2;
}

export const air = {
  id: 'air',
  feature: 'air',
  name: 'Air and pollen',
  hosts: ['air-quality-api.open-meteo.com', 'pollen.googleapis.com'],
  settings: [
    {
      id: 'googleKey',
      label: 'Google Pollen API key (optional)',
      secret: true,
      optional: true,
      help: 'Pollen from Open-Meteo covers only Europe. For pollen anywhere else (the US included), make a key in Google Cloud with the Pollen API on, and paste it here.',
    },
  ],
  configure: async (values, { fetch }) => {
    if (values.googleKey) {
      // One small lookup, to say now rather than later if the key is wrong.
      try {
        await fetch(`https://pollen.googleapis.com/v1/forecast:lookup?key=${encodeURIComponent(values.googleKey)}&location.latitude=40.7&location.longitude=-74&days=1`);
      } catch (e) {
        fail(400, 'invalid', `Google didn’t accept that key (${e.message}). Check that the Pollen API is on for it.`);
      }
    }
    return { googleKey: values.googleKey };
  },
  start: () => ({ cache: new Map() }),
  routes: [
    {
      method: 'GET',
      path: '/now',
      handler: async ({ query, fetch, state, config, log }) => {
        const lat = Number(query.get('lat'));
        const lng = Number(query.get('lng'));
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) fail(400, 'invalid', 'lat and lng must be a position');
        const cell = { lat: cellOf(lat), lng: cellOf(lng) };
        const googleKey = config?.googleKey || null;
        // Circles with a Google key get Google's pollen; they share Open-Meteo's air.
        const key = `${cell.lat},${cell.lng},${googleKey ? 'g' : 'o'}`;
        const hit = state.cache.get(key);
        if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
        let raw;
        try {
          raw = await fetch(
            `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${cell.lat}&longitude=${cell.lng}` +
              `&current=us_aqi,european_aqi,pm2_5,pm10,ozone,${TYPES.flatMap(([, , v]) => v).join(',')}` +
              '&hourly=us_aqi&forecast_hours=12&timezone=auto',
          );
        } catch (e) {
          log('air: Open-Meteo failed', e.message);
          fail(502, 'unavailable', 'Air quality isn’t available right now');
        }
        let google = null;
        if (googleKey) {
          try {
            google = await fetch(
              `https://pollen.googleapis.com/v1/forecast:lookup?key=${encodeURIComponent(googleKey)}&location.latitude=${cell.lat}&location.longitude=${cell.lng}&days=1&plantsDescription=false`,
            );
          } catch (e) {
            // Air quality still shows; pollen falls back to Open-Meteo's (Europe).
            log('air: Google Pollen failed', e.message);
          }
        }
        const data = shape(raw, google, cell);
        state.cache.set(key, { at: Date.now(), data });
        while (state.cache.size > MAX_CELLS) state.cache.delete(state.cache.keys().next().value);
        return data;
      },
    },
  ],
};

/** Open-Meteo's answer (and Google's, if any), cut to what the tile shows. */
export function shape(raw, google, cell) {
  const c = raw?.current ?? {};
  const h = raw?.hourly ?? {};
  const us = int(c.us_aqi);
  return {
    cell,
    at: c.time ?? null,
    aqi: { us, eu: int(c.european_aqi), category: aqiCategory(us), pm25: int(c.pm2_5), pm10: int(c.pm10), ozone: int(c.ozone) },
    hours: (h.time ?? []).slice(0, 12).map((time, i) => ({ time, aqi: int(h.us_aqi?.[i]) })),
    pollen: googlePollen(google) ?? meteoPollen(c),
    source: 'Open-Meteo',
  };
}

function meteoPollen(c) {
  const types = TYPES.map(([id, label, vars]) => {
    const values = vars.map((v) => c[v]).filter(Number.isFinite);
    const level = values.length ? grainsLevel(id, Math.max(...values)) : null;
    return { id, label, level, category: level == null ? null : LEVELS[level] };
  });
  return types.some((t) => t.level != null) ? { source: 'Open-Meteo', types } : null;
}

function googlePollen(g) {
  const day = g?.dailyInfo?.[0];
  if (!day?.pollenTypeInfo) return null;
  const types = TYPES.map(([id, label]) => {
    const info = day.pollenTypeInfo.find((p) => String(p.code).toLowerCase() === id);
    const v = info?.indexInfo?.value;
    const level = Number.isFinite(v) ? Math.max(0, Math.min(5, Math.round(v))) : info?.inSeason === false ? 0 : null;
    return { id, label, level, category: level == null ? null : LEVELS[level] };
  });
  return { source: 'Google', types };
}
