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
/**
 * What you (or the phone's map lookup) called a place, matched by distance.
 * `triedAt`: when a lookup last found nothing useful, so it's tried again later
 * rather than every time (or never).
 */
export type Label = { lat: number; lng: number; name?: string; kind?: FrequentKind; hidden?: boolean; auto?: { name: string; kind: FrequentKind }; triedAt?: number };
/** A named spot to describe others by: the circle's places (with their radius) or your own named ones. */
export type Anchor = { name: string; lat: number; lng: number; radius?: number };
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

/** A name and kind from a map lookup result (Android's geocoder); no name when it gave nothing to go on. */
export function classify(a: {
  name?: string | null;
  street?: string | null;
  district?: string | null;
  subregion?: string | null;
  city?: string | null;
}): { name: string | null; kind: FrequentKind } {
  // `name` is often a business ("Costco Wholesale"); sometimes just a house number or the street.
  const poi = a.name && !/^\d+[a-z]?$/i.test(a.name.trim()) && a.name !== a.street ? a.name.trim() : null;
  const text = [poi, a.street, a.district].filter(Boolean).join(' ');
  const kind = KEYWORDS.find(([, re]) => re.test(text))?.[0] ?? 'other';
  const area = a.district || a.city || a.subregion;
  const name = poi || (a.street ? `Near ${a.street}` : area ? `Near ${area}` : null);
  return { name: name ? name.slice(0, 40) : null, kind };
}

/** What a place's name says it is ("Home", "Maple Grove Elementary" → school), or null. */
export function kindFromName(name: string): FrequentKind | null {
  if (/\bhome\b/i.test(name)) return 'home';
  if (/\b(work|office)\b/i.test(name)) return 'work';
  return KEYWORDS.find(([, re]) => re.test(name))?.[0] ?? null;
}

/** The circle place a spot is in (its radius, plus GPS slack), nearest first. */
export function placeAt(p: { lat: number; lng: number }, anchors: Anchor[]): Anchor | null {
  return (
    anchors
      .filter((a) => a.radius != null && distM(a, p) <= a.radius + 50)
      .sort((a, b) => distM(a, p) - distM(b, p))[0] ?? null
  );
}

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
function compass(from: { lat: number; lng: number }, to: { lat: number; lng: number }) {
  const y = Math.sin(((to.lng - from.lng) * Math.PI) / 180) * Math.cos((to.lat * Math.PI) / 180);
  const x =
    Math.cos((from.lat * Math.PI) / 180) * Math.sin((to.lat * Math.PI) / 180) -
    Math.sin((from.lat * Math.PI) / 180) * Math.cos((to.lat * Math.PI) / 180) * Math.cos(((to.lng - from.lng) * Math.PI) / 180);
  const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return COMPASS[Math.round(deg / 45) % 8];
}

/**
 * A spot with no name of its own, described by the nearest named one within
 * 25 miles: "By Home", "1.2 mi northwest of Home". Null when nothing's near.
 */
export function describeNear(p: { lat: number; lng: number }, anchors: Anchor[]): string | null {
  const near = anchors.filter((a) => a.name).sort((a, b) => distM(a, p) - distM(b, p))[0];
  if (!near) return null;
  const miles = distM(near, p) / 1609.344;
  if (miles > 25) return null;
  if (miles < 0.15) return `By ${near.name}`;
  return `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi ${compass(near, p)} of ${near.name}`;
}

/** A most visited place's name to show: its own, else the circle place it's in, else where it is. */
export function spotName(p: { name: string; lat: number; lng: number }, anchors: Anchor[]): string {
  if (p.name && p.name !== KIND_NAMES.other) return p.name;
  return placeAt(p, anchors)?.name ?? describeNear(p, anchors) ?? 'Unnamed place';
}

/**
 * Name the top places: your names first, then the circle place it's in, then
 * Home/Work/School by time pattern, then the map lookup, and last where it is
 * from the nearest named spot ("1.2 mi north of Home").
 */
export function nameClusters(clusters: Cluster[], labels: Label[], places: Anchor[] = []): MyPlace[] {
  // Home: where most nights are spent. Work or School: weekday working hours.
  const home = [...clusters].sort((a, b) => b.nightMs - a.nightMs)[0];
  const isHome = (c: Cluster) => c === home && c.nightMs >= 10 * 3600_000;
  const workday = clusters.filter((c) => !isHome(c)).sort((a, b) => b.weekdayMs - a.weekdayMs)[0];
  const isWork = (c: Cluster) => c === workday && c.weekdayMs >= 8 * 3600_000;
  const named = clusters.map((c) => {
    const label = labelFor(labels, c);
    const auto = label?.auto?.name && label.auto.name !== KIND_NAMES.other ? label.auto : undefined;
    let kind: FrequentKind = label?.kind ?? auto?.kind ?? 'other';
    let name = label?.name ?? auto?.name ?? '';
    if (!label?.name && !label?.kind) {
      const saved = placeAt(c, places);
      if (isHome(c)) {
        kind = 'home';
        name = saved?.name ?? 'Home';
      } else if (isWork(c)) {
        kind = auto?.kind === 'school' || (saved && kindFromName(saved.name) === 'school') ? 'school' : 'work';
        // A real place, business or school name beats a bare "Work".
        name = saved?.name ?? (auto && auto.kind !== 'other' && !auto.name.startsWith('Near ') ? auto.name : KIND_NAMES[kind]);
      } else if (saved) {
        name = saved.name;
        kind = kindFromName(saved.name) ?? kind;
      }
    }
    return { c, label, kind, name };
  });
  // Still nameless: described from the circle's places and the ones named above.
  const anchors: Anchor[] = [...places, ...named.filter((x) => x.name).map((x) => ({ name: x.name, lat: x.c.lat, lng: x.c.lng }))];
  return named.map(({ c, label, kind, name: given }) => {
    const name = given || describeNear(c, anchors) || 'Unnamed place';
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
