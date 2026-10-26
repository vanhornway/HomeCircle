// Chat wake-ups are coalesced: at most one per member in the window, a burst
// ends with one more, and each says which circle in a way only that phone can
// match (and FCM keeps only the latest in transit).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Push, circleHint } from '../src/push.js';

let relay;
let url;
const got = [];

before(async () => {
  // Expo's push service, as far as the server can tell.
  relay = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const batch = JSON.parse(body);
      got.push(...batch);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: batch.map(() => ({ status: 'ok' })) }));
    });
  });
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${relay.address().port}/push`;
});

after(() => new Promise((r) => relay.close(r)));

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const member = (id, platform = 'android') => ({ id, pushToken: `ExponentPushToken[${id}]`, pushPlatform: platform });

test('a burst of messages wakes each phone once, then once more at the end of the window', async () => {
  const push = new Push({ push: 'expo', expoPushUrl: url, pushCoalesceMs: 300 }, { clearPushToken() {} }, () => {});
  const maya = member('maya-in-family');
  const sam = member('sam-in-family', 'ios');
  for (let i = 0; i < 5; i++) await push.activity([maya, sam]);
  await settle(50);
  assert.equal(got.length, 2);
  await settle(400);
  // The trailing one: the last message of the burst isn't missed.
  assert.equal(got.length, 4);
  // Quiet afterwards: nothing more.
  await settle(400);
  assert.equal(got.length, 4);
  const toMaya = got.filter((m) => m.to === maya.pushToken);
  assert.deepEqual(toMaya[0].data, { t: 'msg', c: circleHint('maya-in-family') });
  assert.equal(toMaya[0].collapseId, `msg-${circleHint('maya-in-family')}`);
  // What FCM sees besides the token: no member or circle ids.
  assert.doesNotMatch(JSON.stringify(got.map(({ to, ...rest }) => rest)), /maya-in-family|sam-in-family/);
  push.close();
});

test('the hint is per member (so per circle), the same each time, and short', () => {
  assert.equal(circleHint('a'), circleHint('a'));
  assert.notEqual(circleHint('a'), circleHint('b'));
  assert.equal(circleHint('a').length, 12);
});
