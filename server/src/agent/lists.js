// Shopping lists, kept by the circle's helper (in its encrypted memory).
// One list per store (Costco, the desi store…); anyone in the circle adds,
// ticks and removes items. "Done shopping" clears what was ticked and counts
// it as bought; receipts count too. Everything ever bought at a store is
// offered back to pick from, most often bought first, and what's bought
// most goes to the top of the list. Receipts also leave what each thing cost
// (every sighting, with its date), so items and the whole list can show an
// estimated price: a usual price (the median of regular prices as printed
// before discounts, so sales don't pull it down) and a low to high range.
import { randomBytes } from 'node:crypto';

const MAX_LISTS = 30;
const MAX_ITEMS = 200;
// Items offered back per store, and items remembered per store (the least
// bought, longest ago, are forgotten past that).
export const MAX_USUAL = 300;
const MAX_KNOWN = 500;
// Price sightings kept per item, and how many of the latest are used.
const MAX_SEEN = 12;
const RECENT_SEEN = 8;
// How far above and below a price the real one might be, at least: a price seen once, or seen a few times.
const SINGLE_MARGIN = 0.1;
const MIN_MARGIN = 0.05;
const id = () => randomBytes(6).toString('base64url');

/** "Eggs ", "egg", "EGGS" → "egg"; "berries" → "berry". For matching only. */
export function itemKey(name) {
  let k = String(name || '').toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (k.length > 4 && k.endsWith('ies')) k = `${k.slice(0, -3)}y`;
  else if (k.length > 3 && k.endsWith('s') && !k.endsWith('ss')) k = k.slice(0, -1);
  return k;
}

/** "Costco list", "the costco" → "costco". */
export const listKey = (name) => itemKey(String(name || '').replace(/\b(the|my|our|list|shopping)\b/gi, ' '));

const cleanName = (s, max = 60) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

export const emptyLists = () => ({ lists: [], bought: {} });

export function findList(state, nameOrId) {
  const key = listKey(nameOrId);
  return state.lists.find((l) => l.id === nameOrId) ?? state.lists.find((l) => listKey(l.name) === key) ?? state.lists.find((l) => key && listKey(l.name).includes(key)) ?? null;
}

export function createList(state, name, by, now) {
  const n = cleanName(name, 40);
  if (!n) throw new Error('Give the list a name, like Costco');
  const existing = findList(state, n);
  if (existing && listKey(existing.name) === listKey(n)) return existing;
  if (state.lists.length >= MAX_LISTS) throw new Error('That’s a lot of lists already. Delete one you don’t use.');
  const list = { id: id(), name: n, createdBy: by, createdAt: now, items: [] };
  state.lists.push(list);
  return list;
}

/** Add items (skipping ones already there, unticking them if ticked). Returns what was added. */
export function addItems(state, list, names, by, now) {
  const added = [];
  for (const raw of names) {
    const name = cleanName(raw);
    const key = itemKey(name);
    if (!key) continue;
    const there = list.items.find((i) => itemKey(i.name) === key);
    if (there) {
      there.ticked = false;
      continue;
    }
    if (list.items.length >= MAX_ITEMS) throw new Error('That list is full.');
    const item = { id: id(), name, by, at: now, ticked: false };
    list.items.push(item);
    added.push(item);
  }
  return added;
}

/** How many of an item to get (1 to 99); anything else is 1. */
export function setQty(item, qty) {
  const n = Math.floor(Number(qty));
  if (n > 1) item.qty = Math.min(n, 99);
  else delete item.qty;
}

/** Remove items by name. Returns what was removed. */
export function removeItems(list, names) {
  const keys = new Set(names.map(itemKey).filter(Boolean));
  const gone = list.items.filter((i) => keys.has(itemKey(i.name)));
  list.items = list.items.filter((i) => !keys.has(itemKey(i.name)));
  return gone;
}

const DAY = 86_400_000;
const dayOf = (ms) => Math.floor(ms / DAY);

/** A price off a receipt: a number above zero (rounded to cents), else null. */
export function cleanPrice(p) {
  const n = typeof p === 'string' ? Number(p.replace(/[^\d.]/g, '')) : p;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && n < 100_000 ? Math.round(n * 100) / 100 : null;
}

/** "usd", " CAD." → "USD"; anything that isn't a three-letter code → ''. */
export const cleanCurrency = (c) => (/^[A-Za-z]{3}$/.test(String(c ?? '').trim().replace(/\.$/, '')) ? String(c).trim().replace(/\.$/, '').toUpperCase() : '');

/**
 * Count items as bought from a list (Done shopping, or a receipt). An entry is
 * a name, or { name, price } with what one cost on a receipt; `currency` is the
 * receipt's and `at` its date (default: now). Every price seen is kept.
 */
export function recordBought(state, list, entries, now, { currency = '', at = now } = {}) {
  const h = (state.bought[list.id] ??= {});
  const cur = cleanCurrency(currency) || listCurrency(state, list);
  for (const entry of entries) {
    const raw = typeof entry === 'string' ? entry : entry?.name;
    const key = itemKey(raw);
    if (!key) continue;
    const e = (h[key] ??= { name: cleanName(raw), count: 0, last: 0 });
    e.count += 1;
    e.last = now;
    const price = cleanPrice(entry?.price);
    if (price === null) continue;
    // The same receipt scanned twice isn't two sightings.
    const seen = (e.prices ??= []);
    if (seen.some((o) => dayOf(o.at) === dayOf(at) && o.p === price && o.c === cur)) continue;
    seen.push({ at, p: price, c: cur });
    seen.sort((a, b) => a.at - b.at);
    if (seen.length > MAX_SEEN) seen.splice(0, seen.length - MAX_SEEN);
  }
  const keys = Object.keys(h);
  if (keys.length > MAX_KNOWN) {
    keys.sort((a, b) => h[a].count - h[b].count || h[a].last - h[b].last);
    for (const k of keys.slice(0, keys.length - MAX_KNOWN)) delete h[k];
  }
}

/** The currency a store's receipts were last in ('' when never seen with prices). */
export function listCurrency(state, list) {
  let best = null;
  for (const e of Object.values(state.bought?.[list.id] ?? {})) for (const o of e.prices ?? []) if (!best || o.at >= best.at) best = o;
  return best?.c ?? '';
}

/** Value at fraction q (0 to 1) of sorted numbers, between neighbours. */
function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const cents = (n) => Math.round(n * 100) / 100;

/**
 * What one of these usually costs, from the latest sightings in the list's
 * currency: { est, low, high, n }. est is the median (a sale price seen once
 * or twice doesn't move it); low and high are the lower and upper quartile,
 * at least 5% either side. A single sighting is that price give or take 10%. Null if never seen priced.
 */
export function priceEstimate(entry, currency) {
  const seen = (entry?.prices ?? []).filter((o) => o.c === currency).slice(-RECENT_SEEN);
  if (!seen.length) return null;
  const v = seen.map((o) => o.p).sort((a, b) => a - b);
  const est = quantile(v, 0.5);
  if (v.length === 1) return { est: cents(est), low: cents(est * (1 - SINGLE_MARGIN)), high: cents(est * (1 + SINGLE_MARGIN)), n: 1 };
  return { est: cents(est), low: cents(Math.min(est * (1 - MIN_MARGIN), quantile(v, 0.25))), high: cents(Math.max(est * (1 + MIN_MARGIN), quantile(v, 0.75))), n: v.length };
}

/** "$4.20", "CA$4.20"; with no currency known, just "4.20". */
export function money(amount, currency, { whole = false } = {}) {
  const digits = whole ? 0 : 2;
  try {
    return currency
      ? new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount)
      : amount.toFixed(digits);
  } catch {
    return `${currency} ${amount.toFixed(digits)}`.trim();
  }
}

/** "~ $63 to $78": the low end rounded down and the high end up, to whole units. */
export function rangeText(low, high, currency) {
  const a = Math.floor(low);
  const b = Math.ceil(high);
  return a === b ? `~${money(a, currency, { whole: true })}` : `~${money(a, currency, { whole: true })} to ${money(b, currency, { whole: true })}`;
}

/** Done shopping: ticked items leave the list and count as bought. Returns how many. */
export function doneShopping(state, list, now) {
  const ticked = list.items.filter((i) => i.ticked);
  recordBought(state, list, ticked.map((i) => i.name), now);
  list.items = list.items.filter((i) => !i.ticked);
  return ticked.length;
}

const usualCount = (state, list, name) => state.bought[list.id]?.[itemKey(name)]?.count ?? 0;

/**
 * A list to show: unticked first, the usual ones at the top, and what's been
 * bought there before that isn't on it (most often first; `minCount` 2 for
 * only what's bought again and again). Items and suggestions with a price
 * history carry `price` ({ est, low, high, n }); when anything is priced,
 * `currency` and `total` say what the whole list (ticked or not, each times
 * its quantity) should cost ({ low, high, priced, count }, from the items
 * priced in that currency).
 * Nothing is added for a list with no prices.
 */
export function viewList(state, list, { suggest = MAX_USUAL, minCount = 1 } = {}) {
  const currency = listCurrency(state, list);
  const known = state.bought[list.id] ?? {};
  const priced = (name) => {
    const price = priceEstimate(known[itemKey(name)], currency);
    return price ? { price } : {};
  };
  const items = [...list.items]
    .map((i) => ({ ...i, qty: i.qty ?? 1, usual: usualCount(state, list, i.name), ...priced(i.name) }))
    .sort((a, b) => Number(a.ticked) - Number(b.ticked) || b.usual - a.usual || a.at - b.at);
  const on = new Set(list.items.map((i) => itemKey(i.name)));
  const usual = Object.entries(known)
    .filter(([k, e]) => !on.has(k) && e.count >= minCount)
    .sort((a, b) => b[1].count - a[1].count || b[1].last - a[1].last)
    .slice(0, suggest)
    .map(([, e]) => ({ name: e.name, count: e.count, ...priced(e.name) }));
  const view = { id: list.id, name: list.name, createdBy: list.createdBy, items, usual };
  const total = listTotal(items);
  if (total) Object.assign(view, { currency, total });
  return view;
}

/** What every item on the list should cost, times its quantity: { low, high, priced, count }, or null if none is priced. */
export function listTotal(items) {
  const priced = items.filter((i) => i.price);
  if (!priced.length) return null;
  const sum = (key) => cents(priced.reduce((t, i) => t + i.price[key] * (i.qty ?? 1), 0));
  return { low: sum('low'), high: sum('high'), priced: priced.length, count: items.length };
}

/** For chat: "Costco: milk, eggs (2 ticked)". */
export function listText(state, list) {
  const v = viewList(state, list, { suggest: 5, minCount: 2 });
  const open = v.items.filter((i) => !i.ticked);
  const about = (p, qty = 1) => (p ? ` · ~${money(p.est * qty, v.currency)}` : '');
  const lines = [`🛒 ${v.name}${open.length ? ':' : ' is empty.'}`, ...open.map((i) => `• ${i.qty > 1 ? `${i.qty} × ` : ''}${i.name}${about(i.price, i.qty)}`)];
  const ticked = v.items.length - open.length;
  if (ticked) lines.push(`(${ticked} ticked off)`);
  if (v.total) lines.push(`Estimated ${rangeText(v.total.low, v.total.high, v.currency)} (${v.total.priced} of ${v.total.count} item${v.total.count === 1 ? '' : 's'} priced)`);
  if (v.usual.length) lines.push(`Usually also: ${v.usual.map((u) => `${u.name}${about(u.price)}`).join(', ')}`);
  return lines.join('\n');
}

/**
 * Plain list commands, so the common ones need no AI: "what's on the costco
 * list", "add milk, eggs to costco", "remove eggs from the costco list",
 * "shopping lists". Returns { action, list, items } or null.
 */
export function parseListCommand(text) {
  const t = String(text || '').trim().replace(/[?.!]+$/, '');
  let m = t.match(/^(?:please\s+)?(?:add|put)\s+(.+?)\s+(?:to|on|onto)\s+(?:the |my |our )?(.+?)(?:\s+(?:shopping\s+)?list)?$/i);
  // "add the ingredients for mac and cheese to Costco": one recipe, not items to split.
  if (m && recipeWanted([m[1]])) return { action: 'add', list: m[2], items: [], recipe: recipeWanted([m[1]]) };
  if (m) return { action: 'add', list: m[2], items: splitItems(m[1]) };
  m = t.match(/^(?:please\s+)?(?:remove|delete|take)\s+(.+?)\s+(?:off|from)\s+(?:the |my |our )?(.+?)(?:\s+(?:shopping\s+)?list)?$/i);
  if (m) return { action: 'remove', list: m[2], items: splitItems(m[1]) };
  if (/^(?:(?:show|list)\s+)?(?:my |our |the |all )?(?:shopping\s+)?lists$/i.test(t)) return { action: 'lists', list: null, items: [] };
  m = t.match(/^(?:what(?:'s| is)(?: on)?|show(?: me)?|read(?: me)?|check)\s+(?:the |my |our )?(.+?)\s+(?:shopping\s+)?list$/i);
  if (m) return { action: 'show', list: m[1], items: [] };
  m = t.match(/^(?:the |my |our )?(.+?)\s+(?:shopping\s+)?list$/i);
  if (m && m[1].split(/\s+/).length <= 4) return { action: 'show', list: m[1], items: [] };
  return null;
}

export const splitItems = (s) =>
  String(s || '')
    .split(/,|\band\b|&|\n/i)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 50);

/** ["the ingredients for Nani's biryani"], ["biryani ingredients"] → "Nani's biryani"; anything else → null. */
export function recipeWanted(items) {
  if (!Array.isArray(items) || items.length !== 1) return null;
  const t = String(items[0]).trim();
  const m =
    t.match(/^(?:all\s+)?(?:of\s+)?(?:the\s+|what\s+)?ingredients\s+(?:for|of|in|from)\s+(?:the\s+|my\s+|our\s+)?(.+?)(?:\s+recipe)?$/i) ??
    t.match(/^(?:all\s+)?(?:the\s+|my\s+|our\s+)?(.+?)(?:\s+recipe)?(?:'s|’s)?\s+ingredients$/i);
  return m ? m[1].trim() || null : null;
}

const UNITS =
  'cups?|c|tablespoons?|tbsps?|tbs|tsps?|teaspoons?|grams?|g|kgs?|kilos?|kilograms?|mls?|millilit(?:er|re)s?|l|lit(?:er|re)s?|lbs?|pounds?|oz|ounces?|pinch(?:es)?|handfuls?|cloves?|cans?|tins?|packets?|packs?|bunch(?:es)?|sprigs?|sticks?|slices?|pieces?|pcs|inch(?:es)?|cm|dash(?:es)?|drops?|jars?|bottles?|heads?|stalks?|knobs?';
const AMOUNT = new RegExp(`^(?:(?:about|approx\\.?|around)\\s+)?(?:[\\d½¼¾⅓⅔⅛.,/\\s-]+|(?:a few|an?|one|two|three|four|five|six|some)\\b)\\s*(?:(?:${UNITS})\\.?\\b\\s*)?(?:of\\s+)?`, 'i');

/** "2 cups basmati rice, washed" → "basmati rice"; "salt to taste" → "salt". For a shopping list. */
export function shoppingName(ingredient) {
  let s = String(ingredient || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/,.*$/, '').replace(/\b(?:to taste|as needed|for garnish|optional)\b.*$/i, '');
  const bare = s.replace(AMOUNT, '').trim();
  return cleanName(bare || s);
}
