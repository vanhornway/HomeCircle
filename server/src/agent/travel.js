// "How long does it take Nyel to get to EVHS?" The asker's phone works out the
// numbers from the circle's place events (this server can't read those) and
// sends the summary with the question; the answer needs no AI.

const clock = (mins) => {
  const h = Math.floor(mins / 60);
  return `${h % 12 || 12}:${String(mins % 60).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
};
const has = (text, word) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^\\p{L}\\p{N}]|$)`, 'iu').test(text);

/** The routes the question is about, best first: whose (a name, or "I"), and where to. */
export function matchTravel(text, routes, asker) {
  const named = routes.filter((r) => has(text, r.who));
  const mine = /\b(?:i|me|my)\b/i.test(text) ? routes.filter((r) => r.who === asker) : [];
  const people = named.length ? named : mine.length ? mine : routes;
  const toPlace = people.filter((r) => has(text, r.to));
  // "To school" when the place is called something else: the only place with that word in it, or nothing.
  return toPlace.length ? toPlace : people.length === 1 ? people : [];
}

/** The answer in words, or null when there's nothing to go on. */
export function travelAnswer(text, routes, asker) {
  const found = matchTravel(text, routes, asker);
  if (!found.length) return null;
  const lines = found.slice(0, 3).map((r) => {
    const span = r.low === r.high ? '' : `, ${r.low} to ${r.high} min`;
    const days = r.days === 'weekdays' ? ', on weekdays' : '';
    const trend = r.trend ? ` This past week it’s been about ${Math.abs(r.trend)} min ${r.trend > 0 ? 'longer' : 'shorter'}.` : '';
    return `🚗 ${r.who} usually takes ${r.mins} min from ${r.from} to ${r.to} (${r.n} trips${span}${days}). Leaves around ${clock(r.leaves)}, gets there around ${clock(r.arrives)}.${trend}`;
  });
  return lines.join('\n');
}
