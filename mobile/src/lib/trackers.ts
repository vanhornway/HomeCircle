// Meshtastic trackers kept by a home base (devices/meshtastic). A tracker is
// an ordinary member of the circle; what makes it one is its member record:
// `tracker.node` set, signed by the home base. The home base is the member
// whose record about itself carries `homeBase` (its status).
import { useEffect, useState } from 'react';
import type { CircleClient, HomeBaseStatus, MemberLocation, TrackerSettings } from '@homecircle/core';

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
/** A home base that hasn't checked in for this long is shown as offline. */
export const HOME_BASE_OFFLINE_MS = 15 * 60_000;

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
