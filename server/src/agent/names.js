// Names swapped out before anything goes to the AI provider: people become
// Person A, Person B…, places Place 1, Place 2…, and the real names go back
// into the answer. The provider sees what was asked, not who your family is.

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {{ people?: string[], places?: string[] }} names
 * @returns {{ mask(text: string): string, unmask(text: string): string, standIns: Map<string, string> }}
 */
export function nameSwapper({ people = [], places = [] } = {}) {
  const pairs = [];
  const seen = new Set();
  const add = (real, standIn) => {
    const key = real.trim().toLowerCase();
    if (key.length < 2 || seen.has(key)) return false;
    seen.add(key);
    pairs.push([real.trim(), standIn]);
    return true;
  };
  let p = 0;
  for (const name of people) if (add(String(name), `Person ${LETTERS[p % 26]}${p >= 26 ? Math.floor(p / 26) : ''}`)) p++;
  let q = 0;
  for (const name of places) if (add(String(name), `Place ${q + 1}`)) q++;
  // Longest first, so "Lincoln Elementary" goes before "Lincoln".
  const byLength = [...pairs].sort((a, b) => b[0].length - a[0].length);
  const word = (s) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(s)}(?![\\p{L}\\p{N}])`, 'giu');
  const toStandIn = byLength.map(([real, standIn]) => [word(real), standIn]);
  const toReal = [...pairs].sort((a, b) => b[1].length - a[1].length).map(([real, standIn]) => [word(standIn), real]);
  return {
    standIns: new Map(pairs),
    mask: (text) => toStandIn.reduce((t, [re, s]) => t.replace(re, s), String(text ?? '')),
    unmask: (text) => toReal.reduce((t, [re, r]) => t.replace(re, r), String(text ?? '')),
  };
}
