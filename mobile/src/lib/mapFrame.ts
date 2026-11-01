// What the family map opens on, and the chips at its edges for people out of
// view. Pure (no React Native), so it runs under `node --test`.

export interface GeoPoint {
  id: string;
  lat: number;
  lng: number;
  /** When the location was taken: breaks ties between groups the same size. */
  ts?: number;
}

/** People this close to someone else in a group are in that group (a town and its suburbs). */
export const NEAR_KM = 50;

const R_KM = 6371;
const rad = (d: number) => (d * Math.PI) / 180;

export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Groups of points, each within `linkKm` of another in its group (so a
 * family spread across one city is one group, and Nani in another country is
 * her own). Groups, and the points in them, keep the order they came in.
 */
export function groups<T extends GeoPoint>(points: T[], linkKm = NEAR_KM): T[][] {
  const groupOf = points.map((_, i) => i);
  const root = (i: number): number => (groupOf[i] === i ? i : (groupOf[i] = root(groupOf[i])));
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++)
      if (distanceKm(points[i], points[j]) <= linkKm) {
        const a = root(i);
        const b = root(j);
        if (a !== b) groupOf[Math.max(a, b)] = Math.min(a, b);
      }
  const out = new Map<number, T[]>();
  points.forEach((p, i) => {
    const r = root(i);
    if (!out.has(r)) out.set(r, []);
    out.get(r)!.push(p);
  });
  return [...out.values()];
}

const freshest = (g: GeoPoint[]) => Math.max(...g.map((p) => p.ts ?? 0));

/**
 * The people to fit when the map opens, and everyone else (in groups, for
 * chips at the edge of the map). Fitting everyone would show two continents
 * with each town squashed into one blob, so it frames one group:
 * - yours, when someone's near you;
 * - you away from everyone (a trip): the biggest group of the rest, since
 *   you know where you are and want to see them;
 * - no location for you: the biggest group;
 * - nobody near anybody: you, or (no location for you) whoever's freshest.
 * Ties go to the group with the freshest location, then to the first.
 */
export function openingFrame<T extends GeoPoint>(points: T[], meId: string | null | undefined, linkKm = NEAR_KM): { frame: T[]; away: T[][] } {
  const all = groups(points, linkKm);
  if (!all.length) return { frame: [], away: [] };
  const mine = meId ? all.find((g) => g.some((p) => p.id === meId)) : undefined;
  const biggest = (gs: T[][]) => gs.reduce((best, g) => (g.length > best.length || (g.length === best.length && freshest(g) > freshest(best)) ? g : best));
  let frame: T[];
  if (mine && mine.length > 1) frame = mine;
  else {
    const others = all.filter((g) => g !== mine);
    const best = others.length ? biggest(others) : null;
    frame = best && best.length > 1 ? best : (mine ?? best!);
  }
  return { frame, away: all.filter((g) => g !== frame) };
}

// --- Chips at the edge of the map -----------------------------------------

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const inside = (p: { x: number; y: number }, r: Rect) => p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;

export interface Chip {
  ids: string[];
  /** Top-left of the chip's box, in the map's pixels. */
  left: number;
  top: number;
  /** The edge it sits on, so the chip can hug it. */
  side: 'left' | 'right' | 'top' | 'bottom';
  /** Which way they are, in degrees: 0 is right, 90 is down. */
  angle: number;
}

/**
 * Where a chip goes for something at `target` (in the map's pixels, may be
 * far off screen): on the edge of `area`, where a line from the area's middle
 * to the target leaves it, with the whole chip (w × h) inside the area.
 */
export function edgePoint(target: { x: number; y: number }, area: Rect, w: number, h: number): Omit<Chip, 'ids'> {
  const cx = (area.left + area.right) / 2;
  const cy = (area.top + area.bottom) / 2;
  const dx = target.x - cx;
  const dy = target.y - cy;
  // Room for the chip's middle: the area shrunk by half a chip all round.
  const hw = Math.max(0, (area.right - area.left - w) / 2);
  const hh = Math.max(0, (area.bottom - area.top - h) / 2);
  // How far along the line the edge is, across and down; the nearer one wins.
  const sx = dx ? hw / Math.abs(dx) : Infinity;
  const sy = dy ? hh / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy, 1e9);
  const side: Chip['side'] = sx <= sy ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'top' : 'bottom';
  return {
    left: cx + dx * s - w / 2,
    top: cy + dy * s - h / 2,
    side,
    angle: (Math.atan2(dy, dx) * 180) / Math.PI,
  };
}

/**
 * Chips for the people out of view, one per group: `groups` holds each
 * group's people with where they are on the map in pixels. People inside
 * `visible` need none; a group partly in view gets a chip for the rest.
 * Chips go on the edge of `area` (the visible part, minus room kept clear,
 * e.g. for the SOS button) and are moved apart along an edge if they'd overlap.
 */
export function edgeChips(groups: { id: string; x: number; y: number }[][], visible: Rect, area: Rect, w: number, h: number, gap = 6): Chip[] {
  const chips: Chip[] = [];
  for (const g of groups) {
    const out = g.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && !inside(p, visible));
    if (!out.length) continue;
    const x = out.reduce((s, p) => s + p.x, 0) / out.length;
    const y = out.reduce((s, p) => s + p.y, 0) / out.length;
    chips.push({ ids: out.map((p) => p.id), ...edgePoint({ x, y }, area, w, h) });
  }
  // Along each edge, in order, push each chip clear of the one before; then
  // back from the far end if that ran past it.
  for (const side of ['left', 'right', 'top', 'bottom'] as const) {
    const across = side === 'top' || side === 'bottom';
    const key = across ? 'left' : 'top';
    const size = (across ? w : h) + gap;
    const lo = across ? area.left : area.top;
    const hi = (across ? area.right - w : area.bottom - h) as number;
    const row = chips.filter((c) => c.side === side).sort((a, b) => a[key] - b[key]);
    for (let i = 1; i < row.length; i++) row[i][key] = Math.max(row[i][key], row[i - 1][key] + size);
    for (let i = row.length - 1; i >= 0; i--) {
      const limit = i === row.length - 1 ? hi : row[i + 1][key] - size;
      row[i][key] = Math.max(lo, Math.min(row[i][key], limit));
    }
  }
  return chips;
}
