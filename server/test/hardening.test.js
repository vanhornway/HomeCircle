// Hardening: the client address behind proxies, request timeouts, write and
// storage limits, and connection caps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientIp } from '../src/http.js';

const req = (xff, remote = '10.0.0.9') => ({ headers: xff == null ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: remote } });

test('behind one proxy, the client is the address the proxy appended', () => {
  // A client can put anything at the front; only the last entry is the proxy's.
  assert.equal(clientIp(req('6.6.6.6, 203.0.113.7'), 1), '203.0.113.7');
  assert.equal(clientIp(req('203.0.113.7'), 1), '203.0.113.7');
  assert.equal(clientIp(req('1.1.1.1, 2.2.2.2, 203.0.113.7, 10.1.1.1'), 2), '203.0.113.7');
  // Fewer entries than proxies: the first one.
  assert.equal(clientIp(req('203.0.113.7'), 3), '203.0.113.7');
});

test('without a trusted proxy, forwarded headers are ignored', () => {
  assert.equal(clientIp(req('6.6.6.6'), 0), '10.0.0.9');
  assert.equal(clientIp(req(null), 1), '10.0.0.9');
});
