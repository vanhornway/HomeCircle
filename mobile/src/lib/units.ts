// Distances are stored in meters; the app shows feet.
export const FEET_PER_METER = 3.28084;

export const feetToMeters = (ft: number) => ft / FEET_PER_METER;
export const metersToFeet = (m: number) => m * FEET_PER_METER;

// How far a tracker is, or how far it went: in miles (feet when close) or
// kilometres (metres when close), as chosen on this phone (Settings →
// Display, or tap a distance). Kept here, plain, so helpers and their tests
// use it; distanceUnit.ts remembers the choice.
export type DistanceUnit = 'mi' | 'km';
let unit: DistanceUnit = 'mi';
export const getDistanceUnit = (): DistanceUnit => unit;
export function setUnitValue(u: DistanceUnit) {
  unit = u === 'km' ? 'km' : 'mi';
}

/** "2.3 km" / "650 m", or "1.4 mi" / "450 ft". */
export function formatDistance(meters: number, u: DistanceUnit = unit): string {
  if (u === 'mi') return formatFeet(meters);
  if (meters >= 1000) return `${(meters / 1000).toFixed(meters >= 10_000 ? 0 : 1)} km`;
  return `${Math.round(meters / 10) * 10} m`;
}

/** "450 ft", or miles once it's long: "1.2 mi". */
export function formatFeet(meters: number): string {
  const ft = metersToFeet(meters);
  if (ft >= 5280) return `${(ft / 5280).toFixed(ft >= 52800 ? 0 : 1)} mi`;
  // Round to a friendly step: 10 ft under 1,000, 50 ft above.
  const step = ft < 1000 ? 10 : 50;
  return `${(Math.round(ft / step) * step).toLocaleString()} ft`;
}
