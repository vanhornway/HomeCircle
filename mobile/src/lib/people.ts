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

/** One line about where someone is: "At Home · 5 min ago · 80%", "Paused: at the doctor · 2 h ago"… */
export function statusLine(client: CircleClient, m: Member): string {
  const paused = client.paused.get(m.id);
  if (paused) return [`Paused${paused.reason ? `: ${paused.reason}` : ''}`, timeAgo(paused.since)].join(' · ');
  const loc = client.locations.get(m.id);
  if (!loc) return m.isMe ? 'Not shared yet' : 'No location yet';
  const place = placeAt(loc, client.places);
  const bits = [loc.approximate ? 'Approximate area' : place ? `At ${place.name}` : `±${formatFeet(loc.accuracy || 0)}`, timeAgo(loc.ts)];
  if (loc.battery != null) bits.push(`${lowBattery(loc) ? '🪫 ' : ''}${Math.round(loc.battery * 100)}%${loc.charging ? ' ⚡' : ''}`);
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

const asked = new Map<string, number>(); // "circleId:memberId" or "circleId:*" -> when
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

export type LocateState = 'idle' | 'asking' | 'updated' | 'cooldown';

/** Where a Locate for this person stands. */
export function locateState(client: CircleClient, memberId: string, now = Date.now()): LocateState {
  const at = Math.max(asked.get(`${client.circleId}:${memberId}`) ?? 0, asked.get(`${client.circleId}:*`) ?? 0);
  if (!at || now - at > COOLDOWN_MS) return 'idle';
  const loc = client.locations.get(memberId);
  if (loc && loc.receivedAt >= at) return now - loc.receivedAt < 15_000 ? 'updated' : 'cooldown';
  return now - at < 45_000 ? 'asking' : 'cooldown';
}

export function everyoneCoolingDown(client: CircleClient, now = Date.now()) {
  const at = asked.get(`${client.circleId}:*`);
  return !!at && now - at < COOLDOWN_MS;
}

/** Ask one person's phone for a fresh location. */
export async function locatePerson(client: CircleClient, memberId: string) {
  asked.set(`${client.circleId}:${memberId}`, Date.now());
  bump();
  try {
    await client.requestLocations([memberId]);
  } catch (e) {
    asked.delete(`${client.circleId}:${memberId}`);
    bump();
    Alert.alert('Couldn’t ask for their location', errorText(e));
  }
  setTimeout(bump, COOLDOWN_MS + 100);
}

/** Ask everyone in the circle for a fresh location. */
export async function refreshEveryone(client: CircleClient) {
  asked.set(`${client.circleId}:*`, Date.now());
  bump();
  try {
    await client.requestLocations();
  } catch (e) {
    asked.delete(`${client.circleId}:*`);
    bump();
    Alert.alert('Couldn’t ask for locations', errorText(e));
  }
  setTimeout(bump, COOLDOWN_MS + 100);
}

export const isStale = (loc: MemberLocation | undefined) => !loc || Date.now() - loc.ts > 2 * 3600_000;
export type { Member };
