// Works out the demo's road routes once and saves them in routes.json, so the
// demo needs no routing service. Run by hand after changing TRIPS or PLACES:
//   node server/demo/build-routes.mjs
import { writeFileSync } from 'node:fs';
import { PLACES, TRIPS, routeKey } from './family.mjs';

const OSRM = 'https://router.project-osrm.org/route/v1/driving';
const metres = ([a, b], [c, d]) => Math.hypot((a - c) * 111_320, (b - d) * 111_320 * Math.cos((a * Math.PI) / 180));

/** Drop points that barely change the line (Ramer–Douglas–Peucker, about 6 m). */
function simplify(line, tolerance = 6) {
  if (line.length < 3) return line;
  const [first, last] = [line[0], line.at(-1)];
  const off = (p) => {
    const len = metres(first, last) || 1;
    const area = Math.abs((last[0] - first[0]) * 111_320 * (first[1] - p[1]) * 88_000 - (first[0] - p[0]) * 111_320 * (last[1] - first[1]) * 88_000);
    return area / len;
  };
  let worst = 0;
  let at = 0;
  line.forEach((p, i) => {
    const d = off(p);
    if (d > worst) [worst, at] = [d, i];
  });
  if (worst <= tolerance) return [first, last];
  return [...simplify(line.slice(0, at + 1), tolerance).slice(0, -1), ...simplify(line.slice(at), tolerance)];
}

const routes = {};
for (const key of new Set(TRIPS.map((t) => routeKey(t.from, t.to)))) {
  const [a, b] = key.split('>').map((k) => PLACES[k]);
  const res = await fetch(`${OSRM}/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`);
  const body = await res.json();
  if (body.code !== 'Ok') throw new Error(`No route for ${key}: ${body.code}`);
  const line = body.routes[0].geometry.coordinates.map(([lng, lat]) => [Number(lat.toFixed(5)), Number(lng.toFixed(5))]);
  routes[key] = simplify(line);
  console.log(key, `${Math.round(body.routes[0].distance)} m`, routes[key].length, 'points');
  await new Promise((r) => setTimeout(r, 1100));
}
writeFileSync(new URL('./routes.json', import.meta.url), `${JSON.stringify(routes)}\n`);
