// The swarm does every simulated phone's signing and checking on one
// computer. tweetnacl's pure-JS Ed25519 takes ~5 ms to sign and ~7 ms to
// verify, so a few dozen busy people max out a core and the swarm, not the
// server, becomes the bottleneck. Node's native Ed25519 is far faster and
// produces the same signatures (RFC 8032), so this swaps it in for the swarm
// process only. The apps and the server are unchanged.
import { createRequire } from 'node:module';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

const require = createRequire(new URL('../../../packages/core/src/crypto.js', import.meta.url));
const nacl = require('tweetnacl');

const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const privCache = new Map();
const pubCache = new Map();
const cached = (cache, key, make) => {
  let v = cache.get(key);
  if (!v) {
    if (cache.size > 20000) cache.clear();
    cache.set(key, (v = make()));
  }
  return v;
};
const privKey = (sk) => {
  const seed = Buffer.from(sk.buffer, sk.byteOffset, 32);
  return cached(privCache, seed.toString('base64'), () => createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: 'der', type: 'pkcs8' }));
};
const pubKey = (pk) => {
  const raw = Buffer.from(pk.buffer, pk.byteOffset, 32);
  return cached(pubCache, raw.toString('base64'), () => createPublicKey({ key: Buffer.concat([SPKI, raw]), format: 'der', type: 'spki' }));
};

const slow = nacl.sign;
function fastSign(msg, secretKey) {
  const sig = sign(null, msg, privKey(secretKey));
  const out = new Uint8Array(64 + msg.length);
  out.set(sig, 0);
  out.set(msg, 64);
  return out;
}
Object.assign(fastSign, slow);
fastSign.open = (signed, publicKey) => {
  if (signed.length < 64) return null;
  const msg = signed.subarray(64);
  return verify(null, msg, pubKey(publicKey), signed.subarray(0, 64)) ? new Uint8Array(msg) : null;
};
fastSign.detached = Object.assign((msg, secretKey) => new Uint8Array(sign(null, msg, privKey(secretKey))), slow.detached);
fastSign.detached.verify = (msg, sig, publicKey) => verify(null, msg, pubKey(publicKey), sig);

/** Check the native path signs and verifies exactly like tweetnacl before using it. */
function selfTest() {
  const kp = slow.keyPair();
  const msg = nacl.randomBytes(100);
  const a = slow(msg, kp.secretKey);
  const b = fastSign(msg, kp.secretKey);
  if (Buffer.compare(Buffer.from(a), Buffer.from(b)) !== 0) throw new Error('native Ed25519 differs from tweetnacl');
  if (!slow.open(b, kp.publicKey) || !fastSign.open(a, kp.publicKey)) throw new Error('native Ed25519 verify failed');
  const bad = b.slice();
  bad[70] ^= 1;
  if (fastSign.open(bad, kp.publicKey) !== null) throw new Error('native Ed25519 accepted a tampered message');
}

let native = false;
try {
  selfTest();
  nacl.sign = fastSign;
  native = true;
} catch (e) {
  console.warn(`Using slower pure-JS signatures (${e.message}).`);
}
export const nativeSignatures = native;
