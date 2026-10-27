// Most visited places get real names: the circle's own places first, the map
// lookup when it found something, and otherwise where they are ("1.2 mi north
// of Home"), never a bare "Place".
//   node --experimental-strip-types --test src/lib/visitsCore.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, describeNear, nameClusters, spotName, type Anchor, type Cluster } from './visitsCore.ts';

const HOUR = 3600_000;
const cluster = (lat: number, lng: number, o: Partial<Cluster> = {}): Cluster => ({ lat, lng, ms: 3 * HOUR, visits: 3, nightMs: 0, weekdayMs: 0, lastAt: 0, ...o });
// Austin: home, a school 1 km away, a park 2 km north.
const HOME = { lat: 30.3105, lng: -97.7395 };
const places: Anchor[] = [
  { name: 'Home', ...HOME, radius: 150 },
  { name: 'Maple Grove Elementary', lat: 30.302, lng: -97.729, radius: 150 },
];

test('a map lookup with nothing useful gives no name (so it is tried again), not "Place"', () => {
  assert.deepEqual(classify({}), { name: null, kind: 'other' });
  assert.equal(classify({ name: '1201' }).name, null);
  assert.equal(classify({ district: 'Hyde Park', city: 'Austin' }).name, 'Near Hyde Park');
  assert.equal(classify({ city: 'Austin' }).name, 'Near Austin');
  assert.deepEqual(classify({ name: 'Costco Wholesale', street: 'Main St' }), { name: 'Costco Wholesale', kind: 'shopping' });
});

test('a spot inside one of the circle’s places takes its name, and its kind from the name', () => {
  const [school] = nameClusters([cluster(30.3021, -97.7291)], [], places);
  assert.equal(school.name, 'Maple Grove Elementary');
  assert.equal(school.kind, 'school');
});

test('a nameless spot is described from the nearest named one; nothing near: Unnamed place', () => {
  const [park, far] = nameClusters([cluster(30.3285, -97.7395), cluster(40.7, -74.0)], [], places);
  assert.equal(park.name, '1.2 mi north of Home');
  assert.equal(far.name, 'Unnamed place');
  assert.equal(describeNear({ lat: 30.3106, lng: -97.7396 }, places), 'By Home');
});

test('an old lookup that saved "Place" no longer names it', () => {
  const [p] = nameClusters([cluster(30.3285, -97.7395)], [{ lat: 30.3285, lng: -97.7395, auto: { name: 'Place', kind: 'other' } }], places);
  assert.equal(p.name, '1.2 mi north of Home');
});

test('your own name always wins', () => {
  const [p] = nameClusters([cluster(30.3021, -97.7291)], [{ lat: 30.3021, lng: -97.7291, name: 'Leo’s school' }], places);
  assert.equal(p.name, 'Leo’s school');
});

test('on someone’s card, a "Place" from an older phone gets a name too', () => {
  assert.equal(spotName({ name: 'Place', lat: 30.302, lng: -97.729 }, places), 'Maple Grove Elementary');
  assert.equal(spotName({ name: 'Place', lat: 30.3285, lng: -97.7395 }, places), '1.2 mi north of Home');
  assert.equal(spotName({ name: 'Costco', lat: 1, lng: 1 }, places), 'Costco');
});
