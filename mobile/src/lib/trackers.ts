// Meshtastic trackers kept by a home base (devices/meshtastic). A tracker is
// an ordinary member of the circle; what makes it one is its member record:
// `tracker.node` set, signed by the home base. The home base is the member
// whose record about itself carries `homeBase` (its status).
import { useEffect, useState } from 'react';
import { distanceM, type CircleClient, type HomeBaseStatus, type MemberLocation, type MeshNodeRadio, type TrackerHeard, type TrackerMode, type TrackerSettings } from '@homecircle/core';

/** The time now, updated every half minute: "heard 5 min ago" and the quiet-phone fallback stay current without reading the clock during render. */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

/** A phone that hasn't reported for this long is quiet: its person shows at their tracker (unless the home base says otherwise). */
export const QUIET_MS = 30 * 60_000;
/**
 * A tracker's position older than this isn't "where it is" any more: one on
 * the move reports every few minutes, and one sitting still every 15. Its pin
 * fades and its line says when it was last heard.
 */
export const TRACKER_STALE_MS = 20 * 60_000;

/**
 * A tracker's line: "At Home · 5 min ago · over radio" while current;
 * "Last heard over radio 1 h ago, at Home" when not, and "probably with
 * Umair" when the person who has it is somewhere else now (their phone says so).
 */
export function trackerStatusLine(client: CircleClient, memberId: string, now: number, where: (loc: MemberLocation) => string): string {
  const loc = client.locations.get(memberId);
  if (!loc) return trackerAway(client, memberId, now) ? 'Away · not heard over radio yet' : 'Not heard over radio yet';
  const at = where(loc); // "At Home", or "" when it isn't at a place
  if (now - loc.ts <= TRACKER_STALE_MS) return [at, ago(now - loc.ts), 'over radio'].filter(Boolean).join(' · ');
  const heard = trackerLastHeard(client, memberId) ?? loc.ts;
  // In range of home, just no new position (no GPS fix indoors, say).
  if (heardNearby(client, memberId, now)) {
    return `In range · heard directly ${ago(now - heard)} · no new position for ${ago(now - loc.ts).replace(' ago', '')}`;
  }
  // Heard lately through relays, but its last position is old: the home base has asked it where it is.
  if (trackerAway(client, memberId, now) && heard > loc.ts && now - heard <= TRACKER_STALE_MS) {
    return `Away · heard over radio ${ago(now - heard)} · asking it where it is`;
  }
  const bits = [
    ...(trackerAway(client, memberId, now) ? ['Away'] : []),
    `last heard over radio ${ago(now - heard)}${at && heard === loc.ts ? `, ${at.charAt(0).toLowerCase()}${at.slice(1)}` : ''}`,
  ];
  bits[0] = bits[0].charAt(0).toUpperCase() + bits[0].slice(1);
  const t = trackerOf(client, memberId);
  const carrier = t?.mode === 'carried' && t.carriedBy ? client.members.get(t.carriedBy) : null;
  const phone = carrier ? client.locations.get(carrier.id) : null;
  if (carrier && phone && phone.ts > loc.ts && now - phone.ts <= TRACKER_STALE_MS && distanceM(phone, loc) > 300) bits.push(`probably with ${carrier.name}`);
  return bits.join(' · ');
}

/** When the home base last heard anything from a tracker: its last position, or any packet (the home base's status). */
export function trackerLastHeard(client: CircleClient, memberId: string): number | null {
  const t = trackerOf(client, memberId);
  if (!t) return null;
  const st = homeBaseOf(client)?.status.trackers.find((x) => x.node === t.node);
  const heard = Math.max(client.locations.get(memberId)?.ts ?? 0, st?.radio?.at ?? 0);
  return heard || null;
}

/**
 * Away: the home base (at home, and online) hasn't heard the tracker for a
 * while, so it has left, or is out of the mesh's reach. Its pin comes off the
 * map until it's heard again. With the home base offline nothing can be said.
 */
export function trackerAway(client: CircleClient, memberId: string, now: number): boolean {
  if (!trackerOf(client, memberId)) return false;
  const home = homeBaseOf(client);
  if (!home || !homeBaseOnline(home.status, now)) return false;
  const loc = client.locations.get(memberId);
  if (loc && now - loc.ts <= TRACKER_STALE_MS) return false;
  // No fresh position, but the home base hears it directly: it's in range of home (indoors,
  // or without a GPS fix), not away. Heard only through relays, it's somewhere else.
  return !heardNearby(client, memberId, now);
}

/** The home base heard this tracker directly (no relays) in the last 20 minutes. */
export function heardNearby(client: CircleClient, memberId: string, now: number): boolean {
  const t = trackerOf(client, memberId);
  const r = t ? homeBaseOf(client)?.status.trackers.find((x) => x.node === t.node)?.radio : null;
  return !!r?.at && now - r.at <= TRACKER_STALE_MS && r.hops === 0;
}

/** "heard 6 times in 3 h, last through 2 relays (meshunit1)": what the home base heard of a tracker lately. */
export function tripLine(log: TrackerHeard[], now: number): string | null {
  const heard = log.filter((e) => now - e.at < 3 * 3600_000);
  if (!heard.length) return null;
  const last = heard[heard.length - 1];
  const how =
    last.hops == null ? '' : last.hops === 0 ? ', last heard directly' : `, last through ${last.hops} relay${last.hops === 1 ? '' : 's'}${last.relay?.name ? ` (${last.relay.name})` : ''}`;
  return `heard ${heard.length === 1 ? 'once' : `${heard.length} times`} in 3 h${how}`;
}

const ago = (ms: number) => (ms < 60_000 ? 'just now' : ms < 3600_000 ? `${Math.round(ms / 60_000)} min ago` : ms < 48 * 3600_000 ? `${Math.round(ms / 3600_000)} h ago` : `${Math.round(ms / 86400_000)} days ago`);

/** A home base that hasn't checked in for this long is shown as offline (older home bases report every 5 minutes). */
export const HOME_BASE_OFFLINE_MS = 15 * 60_000;

/**
 * What pressing a tracker's button 1 to 5 times does (the HomeCircle tracker
 * firmware; the server's Meshtastic plugin keeps the same defaults). `text`
 * is the message it sends unless the circle or the tracker has its own.
 */
export const TRACKER_PRESSES = [
  { n: 1, what: 'I’m OK', text: '✅ I’m OK', does: 'Answers “Ask to check in” when the tracker has beeped for one. On its own it sends nothing, so a bump in a pocket stays quiet.' },
  { n: 2, what: 'Here’s where I am', text: '📍 Here’s where I am', does: 'Sends the message and a fresh position.' },
  { n: 3, what: 'Come pick me up', text: '🚗 Please come pick me up', does: 'Sends the message and a fresh position, as an urgent alert.' },
  { n: 4, what: 'On my way home', text: '🏠 I’m on my way home', does: 'Sends the message and a fresh position.' },
  { n: 5, what: 'SOS', text: '🆘 I need help', does: 'Starts an SOS on everyone’s phone. 5 presses again send “I’m safe” and end it.' },
] as const;

/** The "Learn more" lines about the button, for anyone in the circle. */
export const PRESS_HELP = [
  'Press the tracker’s button 1 to 5 times, no more than 2 seconds apart. It beeps once for each press it counts.',
  ...TRACKER_PRESSES.map((p) => `${p.n} press${p.n === 1 ? '' : 'es'}: ${p.what}. ${p.does}`),
  'Holding the button down turns the tracker off or on.',
  'Presses need HomeCircle’s firmware on the tracker (a SenseCAP T1000-E). On a tracker with stock Meshtastic, 2 quick presses send a position and the rest do what Meshtastic does.',
];

/** How often a tracker reports unless the circle chose otherwise, in minutes (0: no battery reports). */
export const TRACKER_INTERVALS = { moving: 2, still: 15, battery: 30 };

/** Whether HomeCircle's settings are on this tracker, in words; null when the home base hasn't said. */
export function trackerSettingsLine(state: 'set' | 'sending' | 'needs-key' | null | undefined): string | null {
  if (state === 'set') return 'settings on the tracker';
  if (state === 'sending') return 'sending its settings…';
  if (state === 'needs-key') return 'needs the home base’s key';
  return null;
}

/** Whether the home base checked in lately: three missed reports, and never less than 5 minutes. */
export function homeBaseOnline(status: HomeBaseStatus, now: number): boolean {
  const late = status.every ? Math.max(3 * status.every * 1000, 5 * 60_000) : HOME_BASE_OFFLINE_MS;
  return now - status.at < late;
}

/** A LoRa signal in words: SNR above 5 dB is good, below -5 weak. */
function loraSignal(snr: number): string {
  return snr > 5 ? 'good' : snr >= -5 ? 'fair' : 'weak';
}

/** "battery 80% · signal good" for a node the home base hears; null when it knows nothing. */
export function radioFacts(r: MeshNodeRadio | null | undefined): string | null {
  if (!r) return null;
  const parts = [
    r.plugged ? 'plugged in' : r.battery != null ? `battery ${r.battery}%` : null,
    r.snr != null ? `signal ${loraSignal(r.snr)}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** The home base's own health in a line: power, Wi-Fi, uptime, GPS and how busy the radio channel is. */
export function homeBaseHealth(status: HomeBaseStatus): string | null {
  const s = status.self;
  const g = status.gps;
  const up = s?.up;
  const parts = [
    s ? (s.plugged ? (s.battery != null ? `plugged in, battery ${s.battery}%` : 'plugged in') : s.battery != null ? `on battery, ${s.battery}%` : null) : null,
    s?.wifi != null ? `Wi-Fi ${s.wifi > -60 ? 'strong' : s.wifi > -70 ? 'good' : s.wifi > -80 ? 'fair' : 'weak'}` : null,
    up != null ? `up ${up < 3600 ? `${Math.max(1, Math.round(up / 60))} min` : up < 48 * 3600 ? `${Math.round(up / 3600)} h` : `${Math.round(up / 86400)} days`}` : null,
    g ? (g.fix ? `GPS fix, ${g.sats ?? 0} satellites` : 'GPS searching') : null,
    s?.ch != null ? `radio channel ${Math.round(s.ch)}% busy` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** The member's tracker settings if it's a Meshtastic tracker, else null. */
export function trackerOf(client: CircleClient, memberId: string): TrackerSettings | null {
  const t = client.memberRecord(memberId)?.tracker;
  return t?.node ? t : null;
}

/** What a tracker can be for, with its pin's emoji. */
export const TRACKER_KINDS: { mode: TrackerMode; emoji: string; label: string }[] = [
  { mode: 'carried', emoji: '🎒', label: 'Someone carries it' },
  { mode: 'car', emoji: '🚗', label: 'In a car' },
  { mode: 'pet', emoji: '🐾', label: 'Pet' },
  { mode: 'luggage', emoji: '🧳', label: 'Luggage' },
  { mode: 'keys', emoji: '🔑', label: 'Keys' },
  { mode: 'other', emoji: '📍', label: 'Something else' },
];

/** The emoji for a tracker's pin: 🎒 someone carries it, 🚗 a car, 🐾 a pet… */
export function trackerEmoji(t: TrackerSettings): string {
  return TRACKER_KINDS.find((k) => k.mode === t.mode)?.emoji ?? '📍';
}

/** "4 people · 2 trackers": the circle's members, people and devices counted apart. */
export function circleCount(client: CircleClient): string {
  const people = client.peopleList().length;
  const trackers = trackerList(client).length;
  return `${people === 1 ? '1 person' : `${people} people`}${trackers ? ` · ${trackers === 1 ? '1 tracker' : `${trackers} trackers`}` : ''}`;
}

/** The circle's home base and what it last said about itself, or null if there's none. */
export function homeBaseOf(client: CircleClient): { id: string; name: string; status: HomeBaseStatus } | null {
  // The one that reported most lately: an old home base (one that joined again) left behind stays silent.
  let best: { id: string; name: string; status: HomeBaseStatus } | null = null;
  for (const m of client.memberList()) {
    const status = client.memberRecord(m.id)?.homeBase;
    if (status && (!best || status.at > best.status.at)) best = { id: m.id, name: m.name, status };
  }
  return best;
}

/** Home bases other than the one in use, silent for a while: left behind when it joined again, to be removed. */
export function oldHomeBases(client: CircleClient, now: number): { id: string; name: string; at: number }[] {
  const current = homeBaseOf(client);
  return client.memberList().flatMap((m) => {
    const status = client.memberRecord(m.id)?.homeBase;
    return status && m.id !== current?.id && !homeBaseOnline(status, now) ? [{ id: m.id, name: m.name, at: status.at }] : [];
  });
}

/** The trackers in the circle: member id, name and settings. */
export function trackerList(client: CircleClient): { id: string; name: string; tracker: TrackerSettings }[] {
  return client.memberList().flatMap((m) => {
    const tracker = trackerOf(client, m.id);
    return tracker ? [{ id: m.id, name: m.name, tracker }] : [];
  });
}

/**
 * Where to show someone whose phone has gone quiet: at the tracker they carry,
 * if it has reported since their phone last did. Null when their phone is
 * fine, they paused sharing (they chose not to be found), or no tracker helps.
 */
export function carriedFallback(
  client: CircleClient,
  personId: string,
  now: number,
): { loc: MemberLocation; trackerId: string; trackerName: string } | null {
  if (!client.feature('meshtastic') || client.paused.get(personId)) return null;
  const phone = client.locations.get(personId);
  // The same time the home base waits before asking the tracker (the plugin's setting).
  const quietMs = (homeBaseOf(client)?.status.quietMinutes ?? QUIET_MS / 60_000) * 60_000;
  if (phone && now - phone.ts <= quietMs) return null;
  let best: { loc: MemberLocation; trackerId: string; trackerName: string } | null = null;
  for (const t of trackerList(client)) {
    if (t.tracker.carriedBy !== personId) continue;
    const loc = client.locations.get(t.id);
    if (!loc || (phone && loc.ts <= phone.ts)) continue;
    if (!best || loc.ts > best.loc.ts) best = { loc, trackerId: t.id, trackerName: t.name };
  }
  return best;
}

/** Tell the home base what to do: a direct message it reads (devices/meshtastic README, "Commands"). */
export function tellHomeBase(client: CircleClient, homeBaseId: string, command: string): Promise<void> {
  return client.sendChat(command, { to: homeBaseId });
}

/**
 * Where a tracker was when it sent a message (a button press, an SOS, a Locate answer):
 * the position heard closest after it (the firmware sends one with the press), from its
 * current location or what the home base heard lately. `exact` is false when the best we
 * have is from before the message.
 */
export function messageSpot(
  client: CircleClient,
  trackerId: string,
  ts: number,
): { lat: number; lng: number; at: number; exact: boolean } | null {
  const t = trackerOf(client, trackerId);
  if (!t) return null;
  const seen: { lat: number; lng: number; at: number }[] = [];
  const loc = client.locations.get(trackerId);
  if (loc) seen.push({ lat: loc.lat, lng: loc.lng, at: loc.ts });
  const st = homeBaseOf(client)?.status.trackers.find((x) => x.node === t.node);
  for (const e of st?.log ?? []) seen.push({ lat: e.lat, lng: e.lng, at: e.at });
  // Heard with the message, or in the 15 minutes after: where it was.
  const after = seen.filter((s) => s.at >= ts - 2 * 60_000 && s.at <= ts + 15 * 60_000).sort((a, b) => Math.abs(a.at - ts) - Math.abs(b.at - ts))[0];
  if (after) return { ...after, exact: true };
  // Otherwise its last position before the message, if it's from the same day.
  const before = seen.filter((s) => s.at < ts && ts - s.at < 12 * 3600_000).sort((a, b) => b.at - a.at)[0];
  return before ? { ...before, exact: false } : null;
}

/** A Google Maps link for a spot. */
export function googleMapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lng.toFixed(6)}`;
}

/** The home base firmware on the latest release, for "Update" on the Trackers screen. */
export const HOMEBASE_FIRMWARE_URL = 'https://github.com/vanhornway/HomeCircle/releases/latest/download/homebase-heltec-v4.json';

export type HomeBaseFirmware = { version: string; url: string; sha256: string; size: number };

/** What the latest release offers (null if it can't be read, or has no home base firmware). */
export async function latestHomeBaseFirmware(fetchImpl: typeof fetch = fetch): Promise<HomeBaseFirmware | null> {
  try {
    const res = await fetchImpl(HOMEBASE_FIRMWARE_URL, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const j = await res.json();
    const ok = typeof j?.version === 'string' && /^https:\/\//.test(j.url ?? '') && /^[0-9a-f]{64}$/.test(j.sha256 ?? '') && Number.isFinite(j.size);
    return ok ? { version: j.version, url: j.url, sha256: j.sha256, size: j.size } : null;
  } catch {
    return null;
  }
}

/** 1 if version a is newer than b, -1 if older, 0 if the same ("0.29.0" vs "0.28.1"; a "-test" suffix sorts before its release). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main, pre] = v.replace(/^v/, '').split('-', 2);
    return { nums: main.split('.').map((x) => Number.parseInt(x, 10) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre > y.pre ? 1 : -1;
}
