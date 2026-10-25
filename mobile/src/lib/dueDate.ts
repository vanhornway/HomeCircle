// A date typed for a reminder: "Nov 30", "November 30 2027", "11/30",
// "11/30/2027" or "2027-11-30". Without a year it's the next time that day
// comes. Returns YYYY-MM-DD, or null if it isn't a date.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number) => String(n).padStart(2, '0');

function make(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
}

export function parseDueDate(input: string, today = new Date()): string | null {
  const s = input.trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return make(+m[1], +m[2], +m[3]);
  let month: number | null = null;
  let dayOf: number | null = null;
  let year: number | null = null;
  m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (m) [month, dayOf, year] = [+m[1], +m[2], m[3] ? +m[3] : null];
  m = s.match(/^([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/) ?? s.match(/^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+)\.?(?: (\d{4}))?$/);
  if (m) {
    const [word, num] = /^\d/.test(m[1]) ? [m[2], m[1]] : [m[1], m[2]];
    const idx = MONTHS.indexOf(word.slice(0, 3));
    if (idx >= 0) [month, dayOf, year] = [idx + 1, +num, m[3] ? +m[3] : null];
  }
  if (!month || !dayOf) return null;
  if (year != null && year < 100) year += 2000;
  if (year != null) return make(year, month, dayOf);
  const todayIso = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const thisYear = make(today.getFullYear(), month, dayOf);
  return thisYear && thisYear >= todayIso ? thisYear : make(today.getFullYear() + 1, month, dayOf);
}

/** "Sat, Nov 30, 2026" */
export const prettyDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

/** Whole days from today to a date (negative once it's past). */
export function daysUntil(d: string, today = new Date()) {
  const a = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const [y, m, dd] = d.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, dd) - a) / 86400_000);
}
