// Checks the most-visited-places logic (src/lib/visitsCore.ts) against two
// simulated weeks of someone's movements.
//
//   node scripts/test-visits.mjs
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const MOBILE = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const ts = createRequire(`${MOBILE}/package.json`)('typescript');
const src = readFileSync(`${MOBILE}/src/lib/visitsCore.ts`, 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const out = join(mkdtempSync(join(tmpdir(), 'visits-')), 'visitsCore.mjs');
writeFileSync(out, js);
const V = await import(out);

// --- classify ----------------------------------------------------------------
assert.deepEqual(V.classify({ name: 'Costco Wholesale', street: 'Coleman Ave' }), { name: 'Costco Wholesale', kind: 'shopping' });
assert.deepEqual(V.classify({ name: 'Shell', street: 'El Camino Real' }), { name: 'Shell', kind: 'gas' });
assert.deepEqual(V.classify({ name: 'Lincoln High School' }), { name: 'Lincoln High School', kind: 'school' });
assert.deepEqual(V.classify({ name: '1234', street: 'Main St', city: 'San Jose' }), { name: 'Near Main St', kind: 'other' });
assert.deepEqual(V.classify({ name: 'Main St', street: 'Main St' }), { name: 'Near Main St', kind: 'other' });
assert.equal(V.classify({ name: 'Trader Joe’s' }).kind, 'grocery'); // curly apostrophe, as phones often write it
assert.equal(V.classify({ name: "Trader Joe's" }).kind, 'grocery');
assert.equal(V.classify({ name: 'Bay Club Fitness' }).kind, 'gym');

// --- two simulated weeks ------------------------------------------------------
const HOME = { lat: 37.3382, lng: -121.8863 };
const WORK = { lat: 37.4023, lng: -122.0322 };
const COSTCO = { lat: 37.3512, lng: -121.9301 };
const SHELL = { lat: 37.3601, lng: -121.9502 };
const d = V.emptyData();
let now = new Date(2026, 9, 5, 18, 0).getTime(); // Monday Oct 5, 6 pm local
const jitter = (p) => ({ lat: p.lat + (Math.random() - 0.5) * 0.0004, lng: p.lng + (Math.random() - 0.5) * 0.0004 });
const fix = (p) => V.addFix(d, jitter(p).lat, jitter(p).lng, 20, now);
const stay = (p, minutes, every = 15) => {
  for (let m = 0; m <= minutes; m += every) {
    fix(p);
    if (m + every <= minutes) now += every * 60_000;
  }
};
const drive = (a, b, minutes) => {
  for (let m = 1; m <= minutes; m++) {
    now += 60_000;
    const f = m / (minutes + 1);
    V.addFix(d, a.lat + (b.lat - a.lat) * f, a.lng + (b.lng - a.lng) * f, 15, now);
  }
};
const until = (h, min = 0) => {
  const t = new Date(now);
  t.setHours(h, min, 0, 0);
  if (t.getTime() <= now) t.setDate(t.getDate() + 1);
  return Math.round((t.getTime() - now) / 60_000);
};

for (let day = 0; day < 14; day++) {
  // Evening and night at home, until 7:30 am.
  drive(WORK, HOME, 0);
  stay(HOME, until(7, 30));
  const dow = new Date(now).getDay();
  if (dow >= 1 && dow <= 5) {
    drive(HOME, WORK, 25);
    stay(WORK, until(17, 0), 30);
    if (day === 2 || day === 9) {
      drive(WORK, SHELL, 15);
      stay(SHELL, 12, 2); // a quick fill-up
      drive(SHELL, HOME, 15);
    } else {
      drive(WORK, HOME, 25);
    }
    stay(HOME, until(19, 0));
  } else if (dow === 6) {
    stay(HOME, until(11, 0));
    drive(HOME, COSTCO, 12);
    stay(COSTCO, 60, 5);
    drive(COSTCO, HOME, 12);
    stay(HOME, until(19, 0));
  } else {
    stay(HOME, until(19, 0));
  }
}

const clusters = V.topClusters(d, now);
// The phone's map lookup would say:
const lookups = new Map([
  [HOME, { name: '12', street: 'S 1st St', city: 'San Jose' }],
  [WORK, { name: 'Acme Corp', street: 'Mathilda Ave' }],
  [COSTCO, { name: 'Costco Wholesale', street: 'Coleman Ave' }],
  [SHELL, { name: 'Shell', street: 'Stevens Creek Blvd' }],
]);
const labels = clusters.map((c) => {
  const [p, geo] = [...lookups].find(([p]) => V.distM(p, c) < 300) || [null, null];
  return { lat: c.lat, lng: c.lng, auto: geo ? V.classify(geo) : undefined };
});
let places = V.nameClusters(clusters, labels);
const byKind = Object.fromEntries(places.map((p) => [p.kind, p]));
console.log(places.map((p) => `${p.kind.padEnd(9)} ${p.name.padEnd(18)} ${String(p.hours).padStart(6)} h  ${p.visits} visits`).join('\n'));

assert.equal(places[0].kind, 'home', 'Home ranks first');
assert.equal(byKind.home.name, 'Home');
assert.equal(byKind.work.name, 'Work'); // "Acme Corp" has no known kind, so it's just Work
assert.equal(byKind.shopping.name, 'Costco Wholesale');
assert.equal(byKind.shopping.visits, 2);
assert.equal(byKind.gas.name, 'Shell');
assert.equal(byKind.gas.visits, 2);
assert.ok(V.distM(byKind.home, HOME) < 60, 'Home center close to the real spot');
assert.ok(!places.some((p) => p.kind === 'other'), 'drives are not places');

// Your own names win; hiding is remembered per place.
const costco = labels.find((l) => V.distM(l, COSTCO) < 300);
costco.name = 'The big store';
costco.hidden = true;
places = V.nameClusters(clusters, labels);
const renamed = places.find((p) => V.distM(p, COSTCO) < 300);
assert.equal(renamed.name, 'The big store');
assert.equal(renamed.named, true);
assert.equal(renamed.hidden, true);

// A school, during weekday hours, is School, not Work.
const schoolLabels = labels.map((l) => (V.distM(l, WORK) < 300 ? { ...l, auto: V.classify({ name: 'Lincoln Elementary School' }) } : l));
const school = V.nameClusters(clusters, schoolLabels).find((p) => V.distM(p, WORK) < 300);
assert.deepEqual([school.kind, school.name], ['school', 'Lincoln Elementary School']);

// Bad fixes are ignored; history older than 30 days drops off.
const before = d.stays.length;
V.addFix(d, 10, 10, 900, now + 60_000);
assert.equal(d.stays.length, before);
V.addFix(d, 0, 0, 10, now + 40 * 86400_000);
assert.equal(d.stays.length, 0);
console.log('all visit checks passed');
