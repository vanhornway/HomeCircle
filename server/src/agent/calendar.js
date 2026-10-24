// Calendars the agent reads: iCalendar feeds (.ics, webcal://, Google's and
// Apple's calendar addresses), parsed by code rather than the AI so dates are
// exact. Fetching only goes to the public internet (never the family's home
// network), with a size cap and a timeout.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_OCCURRENCES = 500;

// --- addresses -----------------------------------------------------------

/**
 * A calendar address people paste, made fetchable: webcal:// → https://, and
 * a Google Calendar share or embed link → its public iCal address. Returns
 * { url, note? } or throws with what to do instead.
 */
export function calendarUrl(input) {
  let s = String(input || '').trim();
  if (/^webcals?:\/\//i.test(s)) s = s.replace(/^webcals?:\/\//i, 'https://');
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error('That doesn’t look like a link');
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https links');
  if (u.hostname === 'calendar.google.com' && !/\.ics$/.test(u.pathname)) {
    // "Share" (?cid=) and "embed" (?src=) links point at the calendar's id.
    const cid = u.searchParams.get('cid');
    let id = u.searchParams.get('src');
    if (!id && cid) {
      try {
        id = Buffer.from(cid, 'base64').toString('utf8');
      } catch {
        id = null;
      }
    }
    if (!id || !/^[^\s/]+@[^\s/]+$/.test(id)) {
      throw new Error('That Google Calendar link only opens for people signed in to Google. In Google Calendar’s settings for the calendar, copy “Public address in iCal format” or “Secret address in iCal format” instead.');
    }
    return {
      url: `https://calendar.google.com/calendar/ical/${encodeURIComponent(id)}/public/basic.ics`,
      note: 'If this calendar isn’t public, use its “Secret address in iCal format” from Google Calendar’s settings instead.',
    };
  }
  return { url: u.toString() };
}

const privateV4 = (ip) => {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
};
const privateV6 = (ip) => {
  const s = ip.toLowerCase();
  if (s.startsWith('::ffff:')) return privateV4(s.slice(7));
  return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith('ff');
};

/** True if a host resolves only to public internet addresses. */
export async function isPublicHost(host) {
  const h = host.replace(/^\[|\]$/g, '');
  const addrs = isIP(h) ? [{ address: h, family: isIP(h) }] : await lookup(h, { all: true }).catch(() => []);
  return addrs.length > 0 && addrs.every((a) => (a.family === 6 ? !privateV6(a.address) : !privateV4(a.address)));
}

/**
 * Fetch a document from the public internet: no home-network addresses
 * (checked on every redirect), at most 5 MB, 20 seconds. Returns
 * { bytes: Buffer, type, url }.
 */
export async function fetchPublic(url, { fetchImpl = fetch, allowPrivate = false } = {}) {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(current);
    if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https links');
    if (!allowPrivate && !(await isPublicHost(u.hostname))) throw new Error('That address is on a private network; the agent only reads public links');
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 20_000);
    let res;
    try {
      res = await fetchImpl(current, { redirect: 'manual', signal: abort.signal, headers: { 'User-Agent': 'HomeCircle-agent' } });
    } catch (e) {
      clearTimeout(timer);
      throw new Error(`Couldn’t fetch it: ${e?.message ?? e}`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      clearTimeout(timer);
      current = new URL(res.headers.get('location'), current).toString();
      continue;
    }
    try {
      if (!res.ok) throw new Error(res.status === 404 || res.status === 403 ? 'That link isn’t public (the site said no)' : `The site answered ${res.status}`);
      const chunks = [];
      let size = 0;
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > MAX_BYTES) throw new Error('That file is too big (over 5 MB)');
        chunks.push(chunk);
      }
      return { bytes: Buffer.concat(chunks), type: res.headers.get('content-type') || '', url: current };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('Too many redirects');
}

// --- iCalendar -----------------------------------------------------------

const unescape = (v) => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};

/** "20261125" or "20261125T150000Z" → { date: '2026-11-25', time: '15:00' | null, allDay } */
function icsDate(value, params) {
  const m = String(value).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  if (!m[4] || /VALUE=DATE(?!-)/i.test(params)) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: null, allDay: true };
  // Times with a time zone are taken as written: a family calendar is local.
  return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}`, allDay: false };
}

/**
 * Events in an iCalendar file between `from` and `to` (inclusive dates):
 * [{ uid, summary, start, end, time, allDay }], end inclusive. Repeating
 * events (daily, weekly, monthly, yearly; COUNT, UNTIL, INTERVAL, BYDAY,
 * EXDATE) are expanded; cancelled ones are left out.
 */
export function parseIcs(text, { from = '0000-01-01', to = '9999-12-31' } = {}) {
  const lines = String(text).replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  const out = [];
  let ev = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      ev = { exdates: new Set() };
      continue;
    }
    if (line === 'END:VEVENT') {
      if (ev) expand(ev, from, to, out);
      ev = null;
      continue;
    }
    if (!ev) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const [name, ...rest] = line.slice(0, i).split(';');
    const params = rest.join(';');
    const value = line.slice(i + 1);
    switch (name.toUpperCase()) {
      case 'UID':
        ev.uid = value;
        break;
      case 'SUMMARY':
        ev.summary = unescape(value).trim();
        break;
      case 'DTSTART':
        ev.start = icsDate(value, params);
        break;
      case 'DTEND':
        ev.end = icsDate(value, params);
        break;
      case 'RRULE':
        ev.rrule = Object.fromEntries(value.split(';').map((kv) => kv.split('=')));
        break;
      case 'EXDATE':
        for (const v of value.split(',')) {
          const d = icsDate(v, params);
          if (d) ev.exdates.add(d.date);
        }
        break;
      case 'STATUS':
        ev.cancelled = value.toUpperCase() === 'CANCELLED';
        break;
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start) || a.summary.localeCompare(b.summary));
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function expand(ev, from, to, out) {
  if (!ev.start || ev.cancelled) return;
  // All-day DTEND is exclusive; inclusive end date, same day if missing.
  const lastDay = ev.end ? (ev.start.allDay ? addDays(ev.end.date, -1) : ev.end.date) : ev.start.date;
  const span = Math.max(0, Math.round((Date.parse(lastDay) - Date.parse(ev.start.date)) / 86400_000));
  const push = (date) => {
    const end = addDays(date, span);
    if (ev.exdates.has(date) || end < from || date > to) return;
    out.push({ uid: ev.uid || `${ev.summary}@${date}`, summary: ev.summary || '(no title)', start: date, end, time: ev.start.time, allDay: ev.start.allDay });
  };
  const r = ev.rrule;
  if (!r) return push(ev.start.date);
  const freq = String(r.FREQ || '').toUpperCase();
  const interval = Math.max(1, Number(r.INTERVAL) || 1);
  const count = Number(r.COUNT) || Infinity;
  const until = r.UNTIL ? icsDate(r.UNTIL, '')?.date : null;
  const byDay = r.BYDAY ? r.BYDAY.split(',').map((d) => WEEKDAYS.indexOf(d.slice(-2))).filter((d) => d >= 0) : null;
  let n = 0;
  let cursor = ev.start.date;
  for (let i = 0; n < count && n < MAX_OCCURRENCES && i < 5000; i++) {
    if ((until && cursor > until) || cursor > to) break;
    if (freq === 'WEEKLY' && byDay) {
      // Each week from the start's week: the listed weekdays.
      const weekStart = addDays(cursor, -new Date(`${cursor}T00:00:00Z`).getUTCDay());
      for (const wd of byDay.sort()) {
        const d = addDays(weekStart, wd);
        if (d < ev.start.date || (until && d > until) || n >= count) continue;
        n++;
        push(d);
      }
      cursor = addDays(weekStart, 7 * interval);
      continue;
    }
    n++;
    push(cursor);
    if (freq === 'DAILY') cursor = addDays(cursor, interval);
    else if (freq === 'WEEKLY') cursor = addDays(cursor, 7 * interval);
    else if (freq === 'MONTHLY' || freq === 'YEARLY') {
      const d = new Date(`${cursor}T00:00:00Z`);
      if (freq === 'MONTHLY') d.setUTCMonth(d.getUTCMonth() + interval);
      else d.setUTCFullYear(d.getUTCFullYear() + interval);
      cursor = iso(d);
    } else break;
  }
}

// --- free time -----------------------------------------------------------

// What makes a school-calendar day a day off.
const DAY_OFF = /no school|no classes|holiday|break|vacation|recess|closed|non[- ]?(attendance|student)|staff (development|day)|teacher (work|planning|in-?service)|professional (development|learning)|in-?service|thanksgiving|winter|spring break|summer|labor day|memorial day|veterans|presidents|mlk|martin luther king|juneteenth|independence day|christmas|new year|indigenous|columbus/i;
// …unless it's one of these (still a school day, or the start of the year).
const NOT_OFF = /first day|last day of school|minimum day|early (release|dismissal)|half day|back to school|open house|picture day|conference/i;

export const isDayOff = (summary) => DAY_OFF.test(summary) && !NOT_OFF.test(summary);

/**
 * When everyone named is free for `days` days in a row, starting after
 * `from`: the first few stretches, [{ start, end }].
 *
 * Each person: { school: events[] (their school calendars), busy: events[]
 * (anything else booked) }. A school day is a weekday inside the school
 * year (the calendar's first to last date) that no day-off event covers.
 * Weekends, days off and days outside the school year are free unless
 * something else is booked.
 */
export function freeStretches(people, { days, from, horizon = 365, limit = 3 }) {
  const busyDays = people.map((p) => {
    const set = new Set();
    const school = p.school ?? [];
    const first = school.reduce((m, e) => (m && m < e.start ? m : e.start), null);
    const last = school.reduce((m, e) => (m && m > e.end ? m : e.end), null);
    const off = new Set();
    for (const e of school) if (isDayOff(e.summary)) for (let d = e.start; d <= e.end; d = addDays(d, 1)) off.add(d);
    return { set, first, last, off, busy: p.busy ?? [] };
  });
  for (const b of busyDays) for (const e of b.busy) for (let d = e.start; d <= e.end; d = addDays(d, 1)) b.set.add(d);
  const freeOn = (d) =>
    busyDays.every((b) => {
      if (b.set.has(d)) return false;
      const weekday = new Date(`${d}T00:00:00Z`).getUTCDay();
      const schoolDay = b.first && d >= b.first && d <= b.last && weekday !== 0 && weekday !== 6 && !b.off.has(d);
      return !schoolDay;
    });
  const out = [];
  let run = null;
  for (let i = 1; i <= horizon && out.length < limit; i++) {
    const d = addDays(from, i);
    if (freeOn(d)) {
      run = run ?? { start: d, end: d };
      run.end = d;
    } else {
      if (run && dayCount(run) >= days) out.push(run);
      run = null;
    }
  }
  if (run && dayCount(run) >= days && out.length < limit) out.push(run);
  return out;
}

const dayCount = (r) => Math.round((Date.parse(r.end) - Date.parse(r.start)) / 86400_000) + 1;
