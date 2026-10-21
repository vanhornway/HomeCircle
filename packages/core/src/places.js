// Place detection helpers shared by the apps and tests. All of this runs on
// the phone; the server never sees positions or places.

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
