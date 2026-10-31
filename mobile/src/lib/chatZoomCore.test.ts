// Pinch zoom for the chat's text: limits, steps, and how far apart the fingers are.
//   node --experimental-strip-types --test src/lib/chatZoomCore.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CHAT_SCALE, MIN_CHAT_SCALE, clampScale, percentLabel, pinchedScale, scaled, touchDistance } from './chatZoomCore.ts';

test('zoom stays within the limits and snaps to 5% steps', () => {
  assert.equal(clampScale(0.2), MIN_CHAT_SCALE);
  assert.equal(clampScale(9), MAX_CHAT_SCALE);
  assert.equal(clampScale(1.23), 1.25);
  assert.equal(clampScale(NaN), 1);
});

test('spreading the fingers zooms in, pinching zooms out, from where it started', () => {
  assert.equal(pinchedScale(1, 100, 150), 1.5);
  assert.equal(pinchedScale(1.5, 100, 50), 0.85);
  assert.equal(pinchedScale(1.25, 100, 100), 1.25);
  assert.equal(pinchedScale(1, 100, 1000), MAX_CHAT_SCALE);
  // A touch that never had two fingers apart changes nothing.
  assert.equal(pinchedScale(1.25, 0, 80), 1.25);
});

test('distance between two touches', () => {
  assert.equal(touchDistance([{ pageX: 0, pageY: 0 }, { pageX: 3, pageY: 4 }]), 5);
  assert.equal(touchDistance([{ pageX: 0, pageY: 0 }]), 0);
});

test('sizes scale and read as percentages', () => {
  assert.equal(scaled(17, 1.5), 26);
  assert.equal(scaled(14, 1), 14);
  assert.equal(percentLabel(1.25), '125%');
});
