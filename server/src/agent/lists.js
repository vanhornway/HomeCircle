// Shopping lists, kept by the circle's helper (in its encrypted memory).
// One list per store (Costco, the desi store…); anyone in the circle adds,
// ticks and removes items. "Done shopping" clears what was ticked and counts
// it as bought; receipts count too. What's bought most often is "usual":
// it goes to the top of the list and is suggested when it isn't on it.
import { randomBytes } from 'node:crypto';

const MAX_LISTS = 30;
const MAX_ITEMS = 200;
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

/** Remove items by name. Returns what was removed. */
export function removeItems(list, names) {
  const keys = new Set(names.map(itemKey).filter(Boolean));
  const gone = list.items.filter((i) => keys.has(itemKey(i.name)));
  list.items = list.items.filter((i) => !keys.has(itemKey(i.name)));
  return gone;
}

/** Count items as bought from a list (Done shopping, or a receipt). */
export function recordBought(state, list, names, now) {
  const h = (state.bought[list.id] ??= {});
  for (const raw of names) {
    const key = itemKey(raw);
    if (!key) continue;
    const e = (h[key] ??= { name: cleanName(raw), count: 0, last: 0 });
    e.count += 1;
    e.last = now;
  }
}

/** Done shopping: ticked items leave the list and count as bought. Returns how many. */
export function doneShopping(state, list, now) {
  const ticked = list.items.filter((i) => i.ticked);
  recordBought(state, list, ticked.map((i) => i.name), now);
  list.items = list.items.filter((i) => !i.ticked);
  return ticked.length;
}

const usualCount = (state, list, name) => state.bought[list.id]?.[itemKey(name)]?.count ?? 0;

/** A list to show: unticked first, the usual ones at the top, and usual items that aren't on it. */
export function viewList(state, list, { suggest = 8 } = {}) {
  const items = [...list.items]
    .map((i) => ({ ...i, usual: usualCount(state, list, i.name) }))
    .sort((a, b) => Number(a.ticked) - Number(b.ticked) || b.usual - a.usual || a.at - b.at);
  const on = new Set(list.items.map((i) => itemKey(i.name)));
  const usual = Object.entries(state.bought[list.id] ?? {})
    .filter(([k, e]) => !on.has(k) && e.count >= 2)
    .sort((a, b) => b[1].count - a[1].count || b[1].last - a[1].last)
    .slice(0, suggest)
    .map(([, e]) => ({ name: e.name, count: e.count }));
  return { id: list.id, name: list.name, createdBy: list.createdBy, items, usual };
}

/** For chat: "Costco: milk, eggs (2 ticked)". */
export function listText(state, list) {
  const v = viewList(state, list, { suggest: 5 });
  const open = v.items.filter((i) => !i.ticked);
  const lines = [`🛒 ${v.name}${open.length ? ':' : ' is empty.'}`, ...open.map((i) => `• ${i.name}`)];
  const ticked = v.items.length - open.length;
  if (ticked) lines.push(`(${ticked} ticked off)`);
  if (v.usual.length) lines.push(`Usually also: ${v.usual.map((u) => u.name).join(', ')}`);
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
