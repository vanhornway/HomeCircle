// Opus tuning and fingerprints in an SDP:  node --test --experimental-strip-types src/lib/callSdp.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintsOf, tuneOpusSdp } from './callSdp.ts';

const sdp = (opusPt: string, fmtp: string | null) =>
  [
    'v=0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0',
    `a=rtpmap:${opusPt} opus/48000/2`,
    ...(fmtp ? [`a=fmtp:${opusPt} ${fmtp}`] : []),
    'a=rtpmap:9 G722/8000',
    'a=fmtp:9 something=else',
    'a=fingerprint:sha-256 ab:cd:ef',
    '',
  ].join('\r\n');

test('Opus gets about 32 kbit/s, in-band FEC, mono and DTX off, keeping what was there', () => {
  const out = tuneOpusSdp(sdp('111', 'minptime=10;useinbandfec=0;usedtx=1;x-custom=1'));
  const line = out.split('\r\n').find((l) => l.startsWith('a=fmtp:111'))!;
  const kv = Object.fromEntries(line.slice('a=fmtp:111 '.length).split(';').map((p) => p.split('=')));
  assert.equal(kv.maxaveragebitrate, '32000');
  assert.equal(kv.useinbandfec, '1');
  assert.equal(kv.usedtx, '0');
  assert.equal(kv.stereo, '0');
  assert.equal(kv.minptime, '20');
  assert.equal(kv['x-custom'], '1');
  // Other codecs are left alone.
  assert.ok(out.includes('a=fmtp:9 something=else'));
  assert.ok(out.endsWith('\r\n'));
});

test('the Opus payload type comes from the SDP, not a fixed 111', () => {
  const out = tuneOpusSdp(sdp('109', 'minptime=10'));
  assert.ok(out.includes('a=fmtp:109 '));
  assert.ok(out.split('\r\n').find((l) => l.startsWith('a=fmtp:109'))!.includes('maxaveragebitrate=32000'));
});

test('Opus with no fmtp line gets one, right after its rtpmap', () => {
  const out = tuneOpusSdp(sdp('111', null)).split('\r\n');
  const i = out.indexOf('a=rtpmap:111 opus/48000/2');
  assert.ok(out[i + 1].startsWith('a=fmtp:111 ') && out[i + 1].includes('useinbandfec=1'));
});

test('an SDP without Opus, or with plain newlines, survives', () => {
  const noOpus = 'v=0\r\nm=audio 9 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n';
  assert.equal(tuneOpusSdp(noOpus), noOpus);
  const lf = tuneOpusSdp('v=0\na=rtpmap:111 opus/48000/2\n');
  assert.ok(!lf.includes('\r') && lf.includes('a=fmtp:111 '));
});

test('fingerprints are normalised, sorted and unique', () => {
  const s = 'a=fingerprint:SHA-256 ab:cd\r\nm=audio\r\na=fingerprint:sha-256 AB:CD\r\na=fingerprint:sha-256 00:11\r\n';
  assert.deepEqual(fingerprintsOf(s), ['sha-256 00:11', 'sha-256 AB:CD']);
  assert.deepEqual(fingerprintsOf('v=0'), []);
});
