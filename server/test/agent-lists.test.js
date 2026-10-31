// Shopping lists and reminders, as the helper keeps them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_USUAL, addItems, cleanPrice, createList, doneShopping, emptyLists, findList, itemKey, listText, money, parseListCommand, priceEstimate, rangeText, recipeWanted, recordBought, removeItems, shoppingName, viewList } from '../src/agent/lists.js';
import { addMonths, addReminder, canSeeReminder, cleanReminder, dueMessage, markDone, nextYear, reminderLine } from '../src/agent/reminders.js';

test('lists: one per store; items once each; usual items first and suggested', () => {
  const s = emptyLists();
  const costco = createList(s, 'Costco', 'mom', 1);
  assert.equal(createList(s, 'costco', 'dad', 2), costco);
  assert.equal(findList(s, 'the Costco list'), costco);
  addItems(s, costco, ['Milk', 'eggs', 'Bananas'], 'mom', 10);
  assert.equal(addItems(s, costco, ['Egg', 'paper towels'], 'dad', 11).map((i) => i.name).join(), 'paper towels');
  // Bought milk often, eggs once: milk goes to the top.
  for (let i = 0; i < 3; i++) recordBought(s, costco, ['milk'], 100 + i);
  recordBought(s, costco, ['eggs', 'coffee', 'coffee'], 200);
  const v = viewList(s, costco);
  assert.deepEqual(v.items.map((i) => i.name), ['Milk', 'eggs', 'Bananas', 'paper towels']);
  // Coffee was bought twice and isn't on the list: suggested.
  assert.deepEqual(v.usual, [{ name: 'coffee', count: 2 }]);
});

test('lists: everything from a receipt is offered back, up to 300; a new receipt adds what is new', () => {
  const s = emptyLists();
  const costco = createList(s, 'Costco', 'mom', 1);
  recordBought(s, costco, Array.from({ length: 120 }, (_, i) => `item ${i + 1}`), 10);
  // One receipt: every item is offered, not just what's bought twice.
  assert.equal(viewList(s, costco).usual.length, 120);
  // A newer receipt with some of the same and some new: the new ones join, the repeats move up.
  recordBought(s, costco, ['item 5', 'item 7', 'rotisserie chicken', 'olive oil'], 20);
  const v = viewList(s, costco);
  assert.equal(v.usual.length, 122);
  assert.deepEqual(v.usual.slice(0, 2).map((u) => u.name), ['item 5', 'item 7']);
  assert.ok(v.usual.some((u) => u.name === 'rotisserie chicken'));
  // What's on the list isn't offered.
  addItems(s, costco, ['olive oil'], 'mom', 30);
  assert.ok(!viewList(s, costco).usual.some((u) => u.name === 'olive oil'));
  // Up to 300 offered; past 500 known, the least bought and oldest are forgotten.
  recordBought(s, costco, Array.from({ length: 450 }, (_, i) => `more ${i}`), 40);
  assert.equal(viewList(s, costco).usual.length, MAX_USUAL);
  assert.equal(Object.keys(s.bought[costco.id]).length, 500);
  assert.ok(s.bought[costco.id][itemKey('item 5')], 'bought twice: kept');
  // In chat, only what's bought again and again.
  assert.match(listText(s, costco), /Usually also: item 5, item 7$/);
});

test('lists: tick, then Done shopping clears what was ticked and counts it', () => {
  const s = emptyLists();
  const desi = createList(s, 'Desi store', 'mom', 1);
  addItems(s, desi, ['paneer', 'atta', 'chai'], 'mom', 2);
  desi.items[0].ticked = true;
  desi.items[2].ticked = true;
  assert.equal(doneShopping(s, desi, 3), 2);
  assert.deepEqual(desi.items.map((i) => i.name), ['atta']);
  assert.equal(s.bought[desi.id].paneer.count, 1);
  assert.deepEqual(removeItems(desi, ['Atta']).map((i) => i.name), ['atta']);
  assert.equal(listText(s, desi), '🛒 Desi store is empty.');
});

test('lists: plain commands', () => {
  assert.deepEqual(parseListCommand('add milk, eggs and bananas to costco'), { action: 'add', list: 'costco', items: ['milk', 'eggs', 'bananas'] });
  assert.deepEqual(parseListCommand('Remove eggs from the Costco list.'), { action: 'remove', list: 'Costco', items: ['eggs'] });
  assert.deepEqual(parseListCommand("what's on the desi store list?"), { action: 'show', list: 'desi store', items: [] });
  assert.equal(parseListCommand('shopping lists').action, 'lists');
  assert.equal(parseListCommand('when is the dentist'), null);
});

test('reminders: 30, 7, 1 days before, on the day, then every 3 days; yearly ones come back', () => {
  const list = [];
  const r = addReminder(list, { title: 'Car registration', due: '2026-11-30', repeat: 'yearly' }, 'mom', 0);
  const sent = ['2026-10-25', '2026-10-31', '2026-11-01', '2026-11-23', '2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02', '2026-12-04'].map((d) => [d, !!dueMessage(r, d)]);
  assert.deepEqual(sent.filter(([, s]) => s).map(([d]) => d), ['2026-10-31', '2026-11-23', '2026-11-29', '2026-11-30', '2026-12-01', '2026-12-04']);
  markDone(r, 'dad', 1);
  assert.equal(r.due, '2027-11-30');
  assert.equal(r.done, false);
  // Added 5 days out: one message, "in 5 days", not the 30- and 7-day ones too.
  const late = addReminder(list, { title: 'Passport', due: '2026-11-05' }, 'mom', 0);
  assert.match(dueMessage(late, '2026-10-31'), /in 5 days/);
  assert.equal(dueMessage(late, '2026-11-01'), null);
  markDone(late, 'mom', 2);
  assert.equal(late.done, true);
  assert.equal(nextYear('2028-02-29'), '2029-02-28');
});

test('a recipe’s ingredients for a list: which recipe, and each ingredient as you’d shop for it', () => {
  assert.deepEqual(parseListCommand('add the ingredients for mac and cheese to the Costco list'), { action: 'add', list: 'Costco', items: [], recipe: 'mac and cheese' });
  assert.deepEqual(parseListCommand('add milk and eggs to costco'), { action: 'add', list: 'costco', items: ['milk', 'eggs'] });
  assert.equal(recipeWanted(['ingredients for Nani’s biryani']), 'Nani’s biryani');
  assert.equal(recipeWanted(['the biryani recipe ingredients']), 'biryani');
  assert.equal(recipeWanted(['paneer', 'chai']), null);
  assert.equal(recipeWanted(['paneer']), null);
  const shop = ['2 cups basmati rice, washed', 'salt to taste', '3 cloves garlic', '½ tsp turmeric', '1 kg chicken (bone-in)', 'a pinch of saffron', '2-3 green chillies', 'apple', 'an onion', '1 can coconut milk', '6 cloves'];
  assert.deepEqual(shop.map(shoppingName), ['basmati rice', 'salt', 'garlic', 'turmeric', 'chicken', 'saffron', 'green chillies', 'apple', 'onion', 'coconut milk', '6 cloves']);
});

test('reminders every few months move on that many months; private ones are only for their person', () => {
  assert.equal(addMonths('2027-01-31', 1), '2027-02-28');
  assert.equal(addMonths('2031-03-01', -6), '2030-09-01');
  const list = [];
  const r = addReminder(list, { title: 'HVAC filter', due: '2027-02-03', repeat: 'months', months: 3 }, 'mom', 0);
  assert.equal(reminderLine(r), '• HVAC filter: Feb 3, 2027 (every 3 months)');
  markDone(r, 'dad', 1);
  assert.deepEqual([r.due, r.done], ['2027-05-03', false]);
  // Every 12 months is every year; nonsense counts don't repeat.
  assert.equal(cleanReminder({ title: 'X', due: '2027-01-01', repeat: 'months', months: 12 }).repeat, 'yearly');
  assert.equal(cleanReminder({ title: 'X', due: '2027-01-01', repeat: 'months', months: 0 }).repeat, 'none');
  const refill = addReminder(list, { title: 'Refill inhaler', due: '2026-11-20', repeat: 'none', only: 'dad' }, 'dad', 0);
  assert.deepEqual([canSeeReminder(refill, 'dad'), canSeeReminder(refill, 'mom'), canSeeReminder(r, 'mom')], [true, false, true]);
  // An edit keeps who it's for.
  assert.equal(cleanReminder({ ...refill, title: 'Refill the inhaler' }).only, 'dad');
});

const DAY = 86_400_000;
const T0 = Date.parse('2026-09-01T12:00:00Z');
const receipt = (s, list, day, buys, currency = 'USD') => recordBought(s, list, buys, T0 + day * DAY, { currency, at: T0 + day * DAY });

test('prices: every receipt adds a sighting; a one-off sale barely moves the usual price', () => {
  const s = emptyLists();
  const costco = createList(s, 'Costco', 'mom', 1);
  receipt(s, costco, 0, [{ name: 'Milk', price: 4.2 }, { name: 'Eggs', price: 7.5 }, 'paper towels']);
  receipt(s, costco, 14, [{ name: 'milk', price: 4.3 }, { name: 'Eggs', price: 7.5 }]);
  receipt(s, costco, 28, [{ name: 'Milk', price: 4.2 }]);
  receipt(s, costco, 42, [{ name: 'Milk', price: 2.9 }]); // on sale that week
  const milk = s.bought[costco.id].milk;
  assert.deepEqual(milk.prices.map((o) => o.p), [4.2, 4.3, 4.2, 2.9]);
  assert.equal(milk.count, 4);
  addItems(s, costco, ['milk', 'eggs', 'paper towels', 'batteries'], 'mom', T0);
  const v = viewList(s, costco);
  const price = (n) => v.items.find((i) => i.name === n).price;
  // Median, not the lowest: the sale moves it by a cent, not by a dollar.
  assert.equal(price('milk').est, 4.2);
  assert.deepEqual(price('milk'), { est: 4.2, low: 3.88, high: 4.41, n: 4 });
  // Seen twice at the same price: a small margin either way. Never priced: no price at all.
  assert.deepEqual(price('eggs'), { est: 7.5, low: 7.13, high: 7.88, n: 2 });
  assert.deepEqual(Object.keys(v.items.find((i) => i.name === 'paper towels')), ['id', 'name', 'by', 'at', 'ticked', 'usual']);
  assert.equal(v.items.find((i) => i.name === 'batteries').price, undefined);
  // Suggestions carry the price too, and only when there is one.
  receipt(s, costco, 50, [{ name: 'Olive oil', price: 18.99 }, 'bananas']);
  const u = viewList(s, costco).usual;
  assert.deepEqual(u.find((x) => x.name === 'Olive oil').price, { est: 18.99, low: 17.09, high: 20.89, n: 1 });
  assert.equal(u.find((x) => x.name === 'bananas').price, undefined);
});

test('prices: the same receipt scanned twice is one sighting; only the latest sightings count', () => {
  const s = emptyLists();
  const l = createList(s, 'Costco', 'mom', 1);
  receipt(s, l, 0, [{ name: 'rice', price: 20 }]);
  receipt(s, l, 0, [{ name: 'rice', price: 20 }]);
  assert.equal(s.bought[l.id].rice.prices.length, 1);
  assert.equal(s.bought[l.id].rice.count, 2);
  // Prices go up over months: the old ones fall out of the estimate.
  for (let i = 1; i <= 10; i++) receipt(s, l, i * 30, [{ name: 'rice', price: 30 }]);
  assert.equal(s.bought[l.id].rice.prices.length, 11);
  assert.equal(priceEstimate(s.bought[l.id].rice, 'USD').est, 30);
  // Junk prices are ignored.
  receipt(s, l, 400, [{ name: 'rice', price: -3 }, { name: 'rice', price: 'free' }, { name: 'rice', price: 0 }]);
  assert.equal(s.bought[l.id].rice.prices.length, 11);
  assert.equal(cleanPrice('$4.20'), 4.2);
});

test('prices: the list total is a range over the items still to get, with how many are priced', () => {
  const s = emptyLists();
  const l = createList(s, 'Costco', 'mom', 1);
  receipt(s, l, 0, [{ name: 'milk', price: 4 }, { name: 'eggs', price: 8 }, { name: 'coffee', price: 20 }]);
  receipt(s, l, 14, [{ name: 'milk', price: 5 }, { name: 'eggs', price: 8 }, { name: 'coffee', price: 24 }]);
  addItems(s, l, ['milk', 'eggs', 'coffee', 'batteries'], 'mom', T0);
  let v = viewList(s, l);
  assert.equal(v.currency, 'USD');
  // Low: 4.25 + 7.60 + 20.90; high: 4.75 + 8.40 + 23.10.
  assert.deepEqual(v.total, { low: 32.75, high: 36.25, priced: 3, count: 4 });
  assert.match(listText(s, l), /Estimated about \$32 to \$37 \(3 of 4 items priced\)/);
  assert.match(listText(s, l), /• milk · about \$4\.50/);
  assert.match(listText(s, l), /• batteries$/m);
  // Ticking or removing moves it; the unpriced one never reads as free.
  l.items.find((i) => i.name === 'coffee').ticked = true;
  v = viewList(s, l);
  assert.deepEqual([v.total.low, v.total.high, v.total.priced, v.total.count], [11.85, 13.15, 2, 3]);
  removeItems(l, ['milk', 'eggs']);
  assert.equal(viewList(s, l).total, undefined);
});

test('prices: lists with no prices show none; currencies never mix', () => {
  const s = emptyLists();
  const desi = createList(s, 'Desi store', 'mom', 1);
  addItems(s, desi, ['paneer', 'atta'], 'mom', 2);
  recordBought(s, desi, ['paneer'], 3);
  const plain = viewList(s, desi);
  assert.deepEqual(Object.keys(plain), ['id', 'name', 'createdBy', 'items', 'usual']);
  assert.equal(listText(s, desi), '🛒 Desi store:\n• paneer\n• atta');
  // A store seen in dollars, then rupees (a trip): the latest currency is the list's; old dollar prices aren't added in.
  const l = createList(s, 'Market', 'mom', 1);
  receipt(s, l, 0, [{ name: 'tea', price: 6 }, { name: 'sugar', price: 3 }], 'USD');
  receipt(s, l, 30, [{ name: 'tea', price: 1500 }], 'pkr');
  addItems(s, l, ['tea', 'sugar'], 'mom', T0);
  const v = viewList(s, l);
  assert.equal(v.currency, 'PKR');
  assert.deepEqual(v.items.map((i) => i.price?.est), [1500, undefined]);
  assert.deepEqual([v.total.priced, v.total.count], [1, 2]);
  // A receipt that doesn't say its currency is in the store's.
  receipt(s, l, 40, [{ name: 'sugar', price: 300 }], '');
  assert.equal(s.bought[l.id].sugar.prices.at(-1).c, 'PKR');
  assert.equal(money(4.2, 'USD'), '$4.20');
  assert.equal(money(4.2, ''), '4.20');
  assert.equal(rangeText(62.6, 77.1, 'USD'), 'about $62 to $78');
});
