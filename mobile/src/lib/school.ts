// Whether someone is probably in class, so a chirp only flashes. No device
// APIs here, so it can be tested on its own.
import { distanceM, type CircleClient } from '@homecircle/core';

// Class hours: from 8 AM up to 3 PM.
export const CLASS_FROM = 8;
export const CLASS_TO = 15;
// Most visited places have no radius of their own.
const SPOT_RADIUS_M = 150;

export type Spot = { lat: number; lng: number; approximate?: boolean; placeId?: string | null };

export const classHours = (now: Date) => now.getHours() >= CLASS_FROM && now.getHours() < CLASS_TO;

/**
 * Whether someone at `loc` is probably in class: it's 8 AM to 3 PM on this
 * phone's clock and they're at a school, meaning a circle place with "school"
 * in its name, or one of their most visited places that's a school.
 */
export function inClass(client: Pick<CircleClient, 'places' | 'frequent'>, memberId: string, loc: Spot | null | undefined, now = new Date()): boolean {
  if (!loc || loc.approximate || !classHours(now)) return false;
  for (const p of client.places.values()) {
    if (/school/i.test(p.name) && (loc.placeId === p.id || distanceM(loc, p) <= p.radius)) return true;
  }
  return (client.frequent.get(memberId)?.places ?? []).some((p) => p.kind === 'school' && distanceM(loc, p) <= SPOT_RADIUS_M);
}
