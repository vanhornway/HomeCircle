// Shopping lists and reminders, as the helper keeps them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addItems, createList, doneShopping, emptyLists, findList, listText, parseListCommand, recipeWanted, recordBought, removeItems, shoppingName, viewList } from '../src/agent/lists.js';
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
