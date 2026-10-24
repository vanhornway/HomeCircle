// The logic behind most visited places, with no storage or device APIs, so it
// can be tested on its own: stays from location fixes, places from stays, and
// a first guess at what each place is.
import type { FrequentKind, FrequentPlace } from '@homecircle/core';

export const KEEP_MS = 30 * 86400_000;
const STAY_RADIUS_M = 120; // still "here" within this distance
export const PLACE_RADIUS_M = 150; // stays this close together are one place
const MIN_STAY_MS = 10 * 60_000;
const MAX_GAP_MS = 8 * 3600_000; // no fixes for longer than this ends a stay
const MAX_ACCURACY_M = 150;
const TOP = 8;

export type Stay = { lat: number; lng: number; start: number; end: number };
type Current = { lat: number; lng: number; start: number; last: number; n: number };
/** What you (or the phone's map lookup) called a place, matched by distance. */
export type Label = { lat: number; lng: number; name?: string; kind?: FrequentKind; hidden?: boolean; auto?: { name: string; kind: FrequentKind } };
export type VisitData = { stays: Stay[]; current: Current | null; labels: Label[] };
export type Cluster = { lat: number; lng: number; ms: number; visits: number; nightMs: number; weekdayMs: number; lastAt: number };
export type MyPlace = FrequentPlace & { hidden: boolean; named: boolean };

export const emptyData = (): VisitData => ({ stays: [], current: null, labels: [] });

export function distM(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/** One location fix: extends the current stay, or ends it and starts another. */
export function addFix(d: VisitData, lat: number, lng: number, accuracy: number | null, ts: number) {
  if (accuracy != null && accuracy > MAX_ACCURACY_M) return;
  const cur = d.current;
  if (cur && ts - cur.last <= MAX_GAP_MS && distM(cur, { lat, lng }) <= STAY_RADIUS_M) {
    // Still here: refine the center a little with each fix.
    cur.lat += (lat - cur.lat) / (cur.n + 1);
    cur.lng += (lng - cur.lng) / (cur.n + 1);
    cur.n += 1;
    cur.last = Math.max(cur.last, ts);
  } else {
    if (cur && cur.last - cur.start >= MIN_STAY_MS) d.stays.push({ lat: cur.lat, lng: cur.lng, start: cur.start, end: cur.last });
    d.current = { lat, lng, start: ts, last: ts, n: 1 };
  }
  d.stays = d.stays.filter((s) => s.end >= ts - KEEP_MS).slice(-3000);
}

/** Time in [start, end) during hours h0..h1 (local; may wrap midnight), on the given weekdays (0 = Sunday). */
export function msInHours(start: number, end: number, h0: number, h1: number, days: number[] | null) {
  let total = 0;
  for (let t = start; t < end; ) {
    const d = new Date(t);
    const next = new Date(d);
    next.setMinutes(60, 0, 0);
    const step = Math.min(end, next.getTime()) - t;
    const h = d.getHours();
    const inHours = h0 <= h1 ? h >= h0 && h < h1 : h >= h0 || h < h1;
    if (inHours && (!days || days.includes(d.getDay()))) total += step;
    t += step;
  }
  return total;
}

function cluster(stays: Stay[]): Cluster[] {
  const out: Cluster[] = [];
  for (const s of stays) {
    const ms = s.end - s.start;
    let c = out.find((x) => distM(x, s) <= PLACE_RADIUS_M);
    if (!c) {
      c = { lat: s.lat, lng: s.lng, ms: 0, visits: 0, nightMs: 0, weekdayMs: 0, lastAt: 0 };
      out.push(c);
    }
    const w = ms / (c.ms + ms || 1);
    c.lat += (s.lat - c.lat) * w;
    c.lng += (s.lng - c.lng) * w;
    c.ms += ms;
    c.visits += 1;
    c.nightMs += msInHours(s.start, s.end, 22, 6, null);
    c.weekdayMs += msInHours(s.start, s.end, 8, 17, [1, 2, 3, 4, 5]);
    c.lastAt = Math.max(c.lastAt, s.end);
  }
  return out;
}

/** The places worth listing: visited at least twice or for 2+ hours, by time spent and visits. */
export function topClusters(d: VisitData, now: number): Cluster[] {
  const stays = [...d.stays];
  if (d.current && d.current.last - d.current.start >= MIN_STAY_MS) stays.push({ lat: d.current.lat, lng: d.current.lng, start: d.current.start, end: d.current.last });
  const score = (c: Cluster) => c.ms / 3600_000 + c.visits * 0.5;
  return cluster(stays.filter((s) => s.end >= now - KEEP_MS))
    .filter((c) => c.visits >= 2 || c.ms >= 2 * 3600_000)
    .sort((a, b) => score(b) - score(a))
    .slice(0, TOP);
}

export const labelFor = (labels: Label[], p: { lat: number; lng: number }) =>
  labels.filter((l) => distM(l, p) <= PLACE_RADIUS_M).sort((a, b) => distM(a, p) - distM(b, p))[0];

const KEYWORDS: [FrequentKind, RegExp][] = [
  ['school', /\b(school|elementary|middle|high school|academy|preschool|daycare|montessori|university|college|campus)\b/i],
  ['gas', /\b(shell|chevron|arco|exxon|mobil|valero|texaco|sunoco|76|bp|circle k|gas|fuel|gasoline)\b/i],
  ['grocery', /\b(safeway|trader joe['’]?s|whole foods|kroger|sprouts|aldi|lidl|publix|h-e-b|99 ranch|grocery|supermarket|market|foods)\b/i],
  ['shopping', /\b(costco|target|walmart|home depot|lowe['’]?s|ikea|best buy|mall|outlet|store|shop)\b/i],
  ['food', /\b(starbucks|mcdonald['’]?s|chipotle|subway|cafe|café|coffee|restaurant|pizza|grill|kitchen|bakery|diner)\b/i],
  ['gym', /\b(gym|fitness|24 hour|planet fitness|ymca|crossfit|yoga|athletic)\b/i],
  ['health', /\b(hospital|clinic|medical|dental|dentist|pharmacy|cvs|walgreens|kaiser|urgent care|health)\b/i],
  ['worship', /\b(church|temple|mosque|masjid|gurdwara|synagogue|chapel)\b/i],
  ['park', /\b(park|trail|playground|beach|garden)\b/i],
];

export const KIND_NAMES: Record<FrequentKind, string> = {
  home: 'Home',
  work: 'Work',
  school: 'School',
  shopping: 'Shopping',
  grocery: 'Groceries',
  gas: 'Gas station',
  food: 'Food',
  gym: 'Gym',
  health: 'Health',
  worship: 'Worship',
  park: 'Park',
  other: 'Place',
};

/** A name and kind from a map lookup result (Android's geocoder). */
export function classify(a: { name?: string | null; street?: string | null; district?: string | null; city?: string | null }): { name: string; kind: FrequentKind } {
  // `name` is often a business ("Costco Wholesale"); sometimes just a house number or the street.
  const poi = a.name && !/^\d+[a-z]?$/i.test(a.name.trim()) && a.name !== a.street ? a.name.trim() : null;
  const text = [poi, a.street, a.district].filter(Boolean).join(' ');
  const kind = KEYWORDS.find(([, re]) => re.test(text))?.[0] ?? 'other';
  const name = poi || (a.street ? `Near ${a.street}` : a.city || 'Place');
  return { name: name.slice(0, 40), kind };
}

/** Name the top places: your names first, then Home/Work/School by time pattern, then the map lookup. */
export function nameClusters(clusters: Cluster[], labels: Label[]): MyPlace[] {
  // Home: where most nights are spent. Work or School: weekday working hours.
  const home = [...clusters].sort((a, b) => b.nightMs - a.nightMs)[0];
  const isHome = (c: Cluster) => c === home && c.nightMs >= 10 * 3600_000;
  const workday = clusters.filter((c) => !isHome(c)).sort((a, b) => b.weekdayMs - a.weekdayMs)[0];
  const isWork = (c: Cluster) => c === workday && c.weekdayMs >= 8 * 3600_000;
  return clusters.map((c) => {
    const label = labelFor(labels, c);
    const auto = label?.auto;
    let kind: FrequentKind = label?.kind ?? auto?.kind ?? 'other';
    let name = label?.name ?? auto?.name ?? 'Place';
    if (!label?.name && !label?.kind) {
      if (isHome(c)) {
        kind = 'home';
        name = 'Home';
      } else if (isWork(c)) {
        kind = auto?.kind === 'school' ? 'school' : 'work';
        // A real business or school name beats a bare "Work".
        name = auto && auto.kind !== 'other' && !auto.name.startsWith('Near ') ? auto.name : KIND_NAMES[kind];
      }
    }
    return {
      id: `${c.lat.toFixed(4)},${c.lng.toFixed(4)}`,
      name,
      kind,
      lat: c.lat,
      lng: c.lng,
      visits: c.visits,
      hours: Math.round((c.ms / 3600_000) * 10) / 10,
      lastAt: c.lastAt,
      hidden: !!label?.hidden,
      named: !!label?.name,
    };
  });
}
