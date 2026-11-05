// When people are busy, plans, and how long trips take, worked out on the
// phone. Busy times carry a start and an end and nothing else, never a title.
import { quickReturns } from './places.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const MAX_BUSY = 300;
/** How far ahead a phone shares. */
export const BUSY_DAYS = 14;

/** Busy blocks as { s, e } (ms), checked, sorted and joined where they touch. Anything else on them is dropped. */
export function cleanBusy(blocks) {
  if (!Array.isArray(blocks)) return [];
  const list = blocks
    .filter((b) => Number.isFinite(b?.s) && Number.isFinite(b?.e) && b.e > b.s)
    .map((b) => ({ s: b.s, e: b.e }))
    .sort((a, b) => a.s - b.s);
  const out = [];
  for (const b of list) {
    const last = out[out.length - 1];
    if (last && b.s <= last.e) last.e = Math.max(last.e, b.e);
    else out.push(b);
  }
  return out.slice(0, MAX_BUSY);
}

/** Where someone stands now: { busy, until } while busy, { busy: false, until } with the next block's start (or null). */
export function busyNow(blocks, now = Date.now()) {
  const here = blocks.find((b) => b.s <= now && now < b.e);
  if (here) return { busy: true, until: here.e };
  const next = blocks.find((b) => b.s > now);
  return { busy: false, until: next?.s ?? null };
}

const pad = (n) => String(n).padStart(2, '0');
const isoDay = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** The days someone is busy for most of the day, for the helper's free-time answers: YYYY-MM-DD. */
export function busyDays(blocks, enough = 8 * HOUR) {
  const days = new Map();
  for (const { s, e } of blocks) {
    for (let t = s; t < e; ) {
      const d = new Date(t);
      const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
      const key = isoDay(t);
      days.set(key, (days.get(key) ?? 0) + Math.min(e, next) - t);
      t = next;
    }
  }
  return [...days].filter(([, ms]) => ms >= enough).map(([d]) => d).sort();
}

// --- plans -----------------------------------------------------------------

export const PLAN_ANSWERS = ['going', 'maybe', 'no'];

const text = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

/** A plan as stored in its message, checked and trimmed (null if unusable). */
export function cleanPlan(p) {
  const title = text(p?.title, 80);
  const start = Number(p?.start);
  if (!title || !Number.isFinite(start)) return null;
  const end = Number(p?.end);
  return { title, start, end: Number.isFinite(end) && end > start ? end : start + HOUR, allDay: p?.allDay === true, where: text(p?.where, 120) };
}

// --- travel times ----------------------------------------------------------

// A "left" and an "arrived" further apart than this were two separate outings.
const MAX_TRIP_MS = 2 * HOUR;

/** Trips from the circle's place events: someone left one place and arrived at another. Quick returns don't count. */
export function tripsFrom(messages) {
  const skip = quickReturns(messages);
  const away = new Map();
  const trips = [];
  for (const m of messages) {
    if (m.kind !== 'event' || m.body?.type !== 'place' || skip.has(m.id)) continue;
    const at = Number(m.body.at) || m.ts;
    if (m.body.action === 'left') {
      away.set(m.from, { place: m.body.placeName, at });
      continue;
    }
    const out = away.get(m.from);
    away.delete(m.from);
    if (!out || !out.place || !m.body.placeName || out.place === m.body.placeName) continue;
    if (at <= out.at || at - out.at > MAX_TRIP_MS) continue;
    trips.push({ memberId: m.from, from: out.place, to: m.body.placeName, left: out.at, arrived: at });
  }
  return trips;
}

const median = (list) => {
  const s = [...list].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};
const minutesOfDay = (t) => {
  const d = new Date(t);
  return d.getHours() * 60 + d.getMinutes();
};
const weekday = (t) => {
  const n = new Date(t).getDay();
  return n >= 1 && n <= 5;
};

/**
 * Per person and route, the usual trip: { memberId, from, to, n, mins, low,
 * high, leaves, arrives, days, trend }. leaves and arrives are minutes after
 * midnight; days is 'weekdays' when that's when it's usually made; trend is how
 * many minutes longer (or shorter) the last week ran, when that's worth saying.
 * Routes with fewer than `atLeast` trips aren't a habit yet.
 */
export function travelStats(trips, { atLeast = 3, now = Date.now() } = {}) {
  const routes = new Map();
  for (const t of trips) {
    const key = `${t.memberId}|${t.from}|${t.to}`;
    routes.set(key, [...(routes.get(key) ?? []), t]);
  }
  const out = [];
  for (const all of routes.values()) {
    if (all.length < atLeast) continue;
    const weekdays = all.filter((t) => weekday(t.left));
    const list = weekdays.length >= atLeast ? weekdays : all;
    const mins = (t) => Math.max(1, Math.round((t.arrived - t.left) / MIN));
    const durations = list.map(mins);
    const usual = median(durations);
    const lastWeek = list.filter((t) => now - t.left <= 7 * DAY).map(mins);
    const before = list.filter((t) => now - t.left > 7 * DAY).map(mins);
    const change = lastWeek.length >= 2 && before.length >= 2 ? median(lastWeek) - median(before) : 0;
    out.push({
      memberId: all[0].memberId,
      from: all[0].from,
      to: all[0].to,
      n: list.length,
      mins: usual,
      low: Math.min(...durations),
      high: Math.max(...durations),
      leaves: median(list.map((t) => minutesOfDay(t.left))),
      arrives: median(list.map((t) => minutesOfDay(t.arrived))),
      days: list === weekdays ? 'weekdays' : 'all',
      trend: Math.abs(change) >= 3 ? change : 0,
    });
  }
  return out.sort((a, b) => b.n - a.n);
}

/** Questions about how long a trip takes or when someone leaves. */
export const TRAVEL_RE = /\bhow long\b|\bcommute\b|\btravel time\b|\bwhat time does\b.*\b(?:leave|get to|arrive)\b|\bwhen does\b.*\b(?:leave|get to|arrive)\b|\busually\b.*\b(?:leave|get to|arrive)\b/i;
/** Questions the phones' busy times can help answer. */
export const FREE_RE = /\b(?:free|busy|available)\b/i;
