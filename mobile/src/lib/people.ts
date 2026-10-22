// What we show about a person, and the actions you can take on them, shared
// by the map's people list, the person sheet and direct conversations.
import { useSyncExternalStore } from 'react';
import { Alert, Linking, Platform } from 'react-native';
import { distanceM, type CircleClient, type Member, type MemberLocation, type Place } from '@homecircle/core';
import { formatFeet } from './units';
import { timeAgo } from './useCircle';
import { errorText } from './circle';

const STALE_MS = 30 * 60_000;
const COOLDOWN_MS = 60_000;

export function placeAt(loc: MemberLocation | undefined, places: Map<string, Place>): Place | null {
  if (!loc || loc.approximate) return null;
  if (loc.placeId && places.has(loc.placeId)) return places.get(loc.placeId)!;
  for (const p of places.values()) if (distanceM(loc, p) <= p.radius) return p;
  return null;
}

export function lowBattery(loc: MemberLocation | undefined) {
  return !!loc && (loc.trigger === 'low_battery' || (loc.battery != null && loc.battery <= 0.1 && !loc.charging));
}

const OFFLINE_MS = 2 * 3600_000;
const clockTime = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export type MemberState = 'live' | 'saver' | 'settings' | 'paused' | 'locating' | 'no-reply' | 'last-gasp' | 'offline' | 'none';

/**
 * Where someone stands, from the requirements' status table: live, battery
 * saver, settings issue, paused, locating, locate failed, last gasp, offline.
 */
export function memberState(client: CircleClient, m: Member, now = Date.now()): MemberState {
  if (client.paused.get(m.id)) return 'paused';
  const loc = client.locations.get(m.id);
  const ls = locateState(client, m.id, now);
  if (ls === 'sent' || ls === 'delivered') return 'locating';
  if (ls === 'no-reply') return 'no-reply';
  if (!loc) return 'none';
  const age = now - loc.ts;
  if (loc.trigger === 'low_battery' && (loc.battery ?? 1) <= 0.06 && age > 30 * 60_000) return 'last-gasp';
  if (age > OFFLINE_MS) return 'offline';
  if (loc.perm === 'foreground' || loc.precise === false) return 'settings';
  if (loc.power === 'saver') return 'saver';
  return 'live';
}

/** One line about where someone is: "At Home · 5 min ago · 80%", "Battery saver on · 40 min ago"… */
export function statusLine(client: CircleClient, m: Member, now = Date.now()): string {
  const paused = client.paused.get(m.id);
  if (paused) return [`Paused${paused.reason ? `: ${paused.reason}` : ''}`, timeAgo(paused.since)].join(' · ');
  const loc = client.locations.get(m.id);
  const state = memberState(client, m, now);
  const req = asked.get(`${client.circleId}:${m.id}`) ?? asked.get(`${client.circleId}:*`);
  if (state === 'locating') return req?.delivery === 'pushed' ? 'Sent · waiting for their phone…' : 'Delivered · locating…';
  if (state === 'no-reply') return `No reply${loc ? ` · last seen ${timeAgo(loc.ts)}` : ''}${loc?.battery != null ? ` · ${Math.round(loc.battery * 100)}%` : ''}${loc?.power === 'saver' ? ' · battery saver' : ''}`;
  if (!loc) return m.isMe ? 'Not shared yet' : 'No location yet';
  if (state === 'last-gasp') return `Battery may have died at ${Math.round((loc.battery ?? 0) * 100)}% · ${timeAgo(loc.ts)}`;
  if (state === 'offline') return `No signal since ${clockTime(loc.ts)}${now - loc.ts > 86400_000 ? ` (${timeAgo(loc.ts)})` : ''}`;
  const place = placeAt(loc, client.places);
  const where = loc.approximate ? 'Approximate area' : place ? `At ${place.name}` : `±${formatFeet(loc.accuracy || 0)}`;
  const bits = [where, timeAgo(loc.ts)];
  if (loc.battery != null) bits.push(`${lowBattery(loc) ? '🪫 ' : ''}${Math.round(loc.battery * 100)}%${loc.charging ? ' ⚡' : ''}`);
  if (state === 'settings') bits.push(loc.perm === 'foreground' ? 'Location set to While Using' : 'Precise location off');
  if (state === 'saver') bits.push('Battery saver on');
  return bits.join(' · ');
}

/** Open Google Maps (Android) or Apple Maps (iOS) with directions to someone's last location. */
export function openDirections(name: string, loc: MemberLocation, onLocate?: () => void) {
  const go = () => {
    const at = `${loc.lat},${loc.lng}`;
    const url = Platform.OS === 'ios' ? `http://maps.apple.com/?daddr=${at}&dirflg=d` : `https://www.google.com/maps/dir/?api=1&destination=${at}`;
    Linking.openURL(url).catch((e) => Alert.alert('Couldn’t open maps', errorText(e)));
  };
  const age = Date.now() - loc.ts;
  if (age < STALE_MS && !loc.approximate) return go();
  Alert.alert(
    loc.approximate ? `${name} shares an approximate area` : `${name}’s location is ${timeAgo(loc.ts)}`,
    loc.approximate ? 'Directions lead to the general area, not an exact spot.' : 'They may have moved since. You can ask for a fresh location first.',
    [
      { text: 'Cancel', style: 'cancel' },
      ...(onLocate && !loc.approximate ? [{ text: 'Locate first', onPress: onLocate }] : []),
      { text: 'Get directions', onPress: go },
    ],
  );
}

// --- Locate: one person, or everyone ------------------------------------
// Each request is remembered so its button can show "asking…" until that
// person's location arrives, then "updated", and a cooldown after.

// "circleId:memberId" or "circleId:*" -> when it was asked and how it reached them
const asked = new Map<string, { at: number; delivery?: 'delivered' | 'pushed' | 'unreachable' }>();
let version = 0;
const subs = new Set<() => void>();
const bump = () => {
  version++;
  subs.forEach((fn) => fn());
};

export function useLocateVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => version,
  );
}

/**
 * Where a Locate for this person stands: sent (as a push) or delivered (to
 * the open app), then updated; no reply after 60 seconds; cooldown after.
 */
export type LocateState = 'idle' | 'sent' | 'delivered' | 'updated' | 'no-reply' | 'cooldown';
/** Kept for screens that only need "is it in flight". */
export const isAsking = (s: LocateState) => s === 'sent' || s === 'delivered';
const NO_REPLY_MS = 60_000;
const SHOW_NO_REPLY_MS = 10 * 60_000;

export function locateState(client: CircleClient, memberId: string, now = Date.now()): LocateState {
  // Not you, and not someone who paused (they won't answer).
  if (memberId === client.account?.memberId || client.paused.has(memberId)) return 'idle';
  const one = asked.get(`${client.circleId}:${memberId}`);
  const all = asked.get(`${client.circleId}:*`);
  const req = (one?.at ?? 0) >= (all?.at ?? 0) ? one : all;
  if (!req) return 'idle';
  const loc = client.locations.get(memberId);
  const since = now - req.at;
  if (loc && loc.receivedAt >= req.at) {
    if (now - loc.receivedAt < 15_000) return 'updated';
    return since < COOLDOWN_MS ? 'cooldown' : 'idle';
  }
  if (since < NO_REPLY_MS) return req.delivery === 'pushed' ? 'sent' : 'delivered';
  if (since < SHOW_NO_REPLY_MS) return 'no-reply';
  return 'idle';
}

/** Can Locate be tapped again for this person? */
export const canLocate = (s: LocateState) => s === 'idle' || s === 'no-reply';

export function everyoneCoolingDown(client: CircleClient, now = Date.now()) {
  const req = asked.get(`${client.circleId}:*`);
  return !!req && now - req.at < COOLDOWN_MS;
}

/** Ask one person's phone for a fresh location. */
export async function locatePerson(client: CircleClient, memberId: string) {
  const key = `${client.circleId}:${memberId}`;
  asked.set(key, { at: Date.now() });
  bump();
  try {
    const res = await client.requestLocations([memberId]);
    asked.set(key, { at: asked.get(key)!.at, delivery: res.delivery?.[memberId] ?? (res.online ? 'delivered' : 'pushed') });
    bump();
  } catch (e) {
    asked.delete(`${client.circleId}:${memberId}`);
    bump();
    Alert.alert('Couldn’t ask for their location', errorText(e));
  }
  setTimeout(bump, NO_REPLY_MS + 100);
  setTimeout(bump, COOLDOWN_MS + 100);
  setTimeout(bump, SHOW_NO_REPLY_MS + 100);
}

/** Ask everyone in the circle for a fresh location. */
export async function refreshEveryone(client: CircleClient) {
  asked.set(`${client.circleId}:*`, { at: Date.now() });
  bump();
  try {
    await client.requestLocations();
  } catch (e) {
    asked.delete(`${client.circleId}:*`);
    bump();
    Alert.alert('Couldn’t ask for locations', errorText(e));
  }
  setTimeout(bump, NO_REPLY_MS + 100);
  setTimeout(bump, COOLDOWN_MS + 100);
}

export const isStale = (loc: MemberLocation | undefined) => !loc || Date.now() - loc.ts > 2 * 3600_000;
export type { Member };
