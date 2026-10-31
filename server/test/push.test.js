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

test('an urgent message wakes the phone at once, even inside the window, with the same push as any other', async () => {
  got.length = 0;
  const push = new Push({ push: 'expo', expoPushUrl: url, pushCoalesceMs: 300 }, { clearPushToken() {} }, () => {});
  const ammi = member('ammi-in-care');
  await push.activity([ammi]);
  await push.activity([ammi]); // waits for the end of the window
  await push.activity([ammi], { urgent: true }); // goes now, and stands in for the waiting one
  await settle(50);
  assert.equal(got.length, 2);
  await settle(400);
  assert.equal(got.length, 2, 'no trailing wake-up after the urgent one');
  assert.deepEqual(got[1], got[0], 'an urgent push looks exactly like a normal one');
  push.close();
});

// Backup alerts: a phone that opted in gets one generic visible push when it
// hasn't fetched the message shortly after its wake-up.
const fallbackPush = (delivered, extra = {}) =>
  new Push(
    { push: 'expo', expoPushUrl: url, pushCoalesceMs: 5_000, pushFallbackMs: 120, pushFallbackUrgentMs: 40, ...extra },
    { clearPushToken() {}, deliveredSeqOf: (id) => delivered[id] ?? 0 },
    () => {},
  );
const optedIn = (id) => ({ ...member(id), pushFallback: true });

test('an opted-in phone that has not fetched gets one generic visible alert after the wake-up', async () => {
  got.length = 0;
  const delivered = {};
  const push = fallbackPush(delivered);
  const maya = optedIn('maya-fallback');
  await push.activity([maya], { seq: 7 });
  await push.activity([maya], { seq: 8 }); // held back by the window; the check still covers seq 8
  await settle(60);
  assert.equal(got.length, 1, 'just the wake-up so far');
  assert.deepEqual(got[0].data, { t: 'msg', c: circleHint('maya-fallback') });
  await settle(120);
  assert.equal(got.length, 2);
  const alert = got[1];
  assert.equal(alert.title, 'HomeCircle');
  assert.equal(alert.body, 'New message in your circle');
  assert.equal(alert.priority, 'high');
  assert.equal(alert.channelId, 'messages');
  assert.equal(alert.data.fb, 1);
  assert.notEqual(alert.collapseId, got[0].collapseId, 'the alert and the wake-up never replace each other');
  // Content-free: no ids, names or seq.
  assert.doesNotMatch(JSON.stringify(got.map(({ to, ...rest }) => rest)), /maya-fallback|"seq"|\b7\b|\b8\b/);
  await settle(200);
  assert.equal(got.length, 2, 'only one alert for the burst');
  push.close();
});

test('no backup alert when the phone fetched in time, or has not opted in, or is not Android', async () => {
  got.length = 0;
  const delivered = { 'sam-fetched': 5 };
  const push = fallbackPush(delivered);
  await push.activity([optedIn('sam-fetched')], { seq: 5 });
  await push.activity([member('lee-optout')], { seq: 5 });
  await push.activity([{ ...member('ios-user', 'ios'), pushFallback: true }], { seq: 5 });
  // A phone that fetches between the wake-up and the check.
  await push.activity([optedIn('ann-fetches')], { seq: 3 });
  delivered['ann-fetches'] = 3;
  await settle(250);
  assert.equal(got.length, 4, 'only the four wake-ups');
  assert.ok(got.every((m) => !m.data.fb));
  push.close();
});

test('an urgent message is checked sooner and its alert uses the urgent channel', async () => {
  got.length = 0;
  const push = fallbackPush({});
  const ammi = optedIn('ammi-fallback');
  await push.activity([ammi], { seq: 2 });
  await push.activity([ammi], { urgent: true, seq: 3 });
  await settle(90);
  const alerts = got.filter((m) => m.data.fb);
  assert.equal(alerts.length, 1, 'the urgent check ran well before the normal delay');
  assert.equal(alerts[0].channelId, 'urgent');
  await settle(120);
  assert.equal(got.filter((m) => m.data.fb).length, 1, 'and the normal check does not add another');
  push.close();
});
