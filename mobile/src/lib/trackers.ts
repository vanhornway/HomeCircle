// Meshtastic trackers kept by a home base (devices/meshtastic). A tracker is
// an ordinary member of the circle; what makes it one is its member record:
// `tracker.node` set, signed by the home base. The home base is the member
// whose record about itself carries `homeBase` (its status).
import { useEffect, useState } from 'react';
import type { CircleClient, HomeBaseStatus, MemberLocation, MeshNodeRadio, TrackerSettings } from '@homecircle/core';

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
/** A home base that hasn't checked in for this long is shown as offline (older home bases report every 5 minutes). */
export const HOME_BASE_OFFLINE_MS = 15 * 60_000;

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

/** 🚗 for a car, 🎒 for a tracker someone carries. */
export function trackerEmoji(t: TrackerSettings): string {
  return t.mode === 'car' ? '🚗' : '🎒';
}

/** The circle's home base and what it last said about itself, or null if there's none. */
export function homeBaseOf(client: CircleClient): { id: string; name: string; status: HomeBaseStatus } | null {
  for (const m of client.memberList()) {
    const status = client.memberRecord(m.id)?.homeBase;
    if (status) return { id: m.id, name: m.name, status };
  }
  return null;
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
