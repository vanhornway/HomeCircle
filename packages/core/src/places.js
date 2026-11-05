// Place detection helpers shared by the apps and tests. All of this runs on
// the phone; the server never sees positions or places.

/** Left a place and back within this long: someone walking along its edge, not a trip. */
export const QUICK_RETURN_MS = 3 * 60_000;

/**
 * The ids of arrived/left messages that cancel out: a "left" followed by an
 * "arrived" at the same place, by the same person, within QUICK_RETURN_MS. Both
 * still post as they happen; every viewer hides the pair once the return comes.
 */
export function quickReturns(messages, withinMs = QUICK_RETURN_MS) {
  const hidden = new Set();
  const lastLeft = new Map();
  for (const m of messages) {
    if (m.kind !== 'event' || m.body?.type !== 'place') continue;
    const key = `${m.from}|${m.body.placeId}`;
    const at = Number(m.body.at) || m.ts;
    if (m.body.action === 'left') {
      lastLeft.set(key, { id: m.id, at });
      continue;
    }
    const out = lastLeft.get(key);
    lastLeft.delete(key);
    if (out && at >= out.at && at - out.at <= withinMs) hidden.add(out.id).add(m.id);
  }
  return hidden;
}

/** Great-circle distance in meters. */
export function distanceM(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, x)));
}

/**
 * Is a position inside a place, outside it, or too close to the edge (or too
 * imprecise) to say? Leaving needs a margin beyond the radius, scaled by the
 * fix's accuracy, so GPS drift at the edge doesn't produce false "left"
 * messages. Returns 'inside', 'outside' or null.
 */
export function placeState({ distance, accuracy, radius }) {
  const acc = Number.isFinite(accuracy) && accuracy > 0 ? accuracy : 50;
  if (acc > 250) {
    // A rough fix can still be decisive when it's far from the edge.
    if (distance + acc < radius) return 'inside';
    if (distance - acc > radius) return 'outside';
    return null;
  }
  if (distance <= radius) return 'inside';
  const margin = Math.max(30, Math.min(acc, 100));
  if (distance >= radius + margin) return 'outside';
  return null;
}

/**
 * Round a position to a ~1 km grid for "approximate" sharing. Done on the
 * phone before encrypting, so the exact position never leaves it.
 */
export function approximate({ lat, lng }) {
  const step = 0.01;
  return { lat: Math.round(lat / step) * step, lng: Math.round(lng / step) * step, accuracy: 1000 };
}
