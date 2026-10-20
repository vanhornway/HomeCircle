// Distances are stored in meters; the app shows feet.
export const FEET_PER_METER = 3.28084;

export const feetToMeters = (ft: number) => ft / FEET_PER_METER;
export const metersToFeet = (m: number) => m * FEET_PER_METER;

/** "450 ft", or miles once it's long: "1.2 mi". */
export function formatFeet(meters: number): string {
  const ft = metersToFeet(meters);
  if (ft >= 5280) return `${(ft / 5280).toFixed(ft >= 52800 ? 0 : 1)} mi`;
  // Round to a friendly step: 10 ft under 1,000, 50 ft above.
  const step = ft < 1000 ? 10 : 50;
  return `${(Math.round(ft / step) * step).toLocaleString()} ft`;
}
