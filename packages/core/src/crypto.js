// End-to-end encryption for HomeCircle. See docs/PROTOCOL.md.
import nacl from 'tweetnacl';
import { toB64, fromB64, utf8Encode, utf8Decode, concat } from './encoding.js';

export const PROTOCOL_VERSION = 1;
export const KINDS = ['profile', 'location', 'chat', 'event', 'reaction', 'place', 'circle', 'frequent'];

export class CryptoError extends Error {
  constructor(reason) {
    super(`Could not open encrypted data (${reason})`);
    this.reason = reason;
  }
}

export const randomBytes = (n) => nacl.randomBytes(n);
export const randomId = (bytes = 16) => toB64(nacl.randomBytes(bytes));

/** Domain-separated key derivation for uniformly random secrets. */
export function kdf(label, secret) {
  return nacl.hash(concat(utf8Encode(label), secret)).slice(0, 32);
}

export function generateIdentity() {
  const box = nacl.box.keyPair();
  const sign = nacl.sign.keyPair();
  return {
    boxPub: toB64(box.publicKey),
    boxSecret: toB64(box.secretKey),
    signPub: toB64(sign.publicKey),
    signSecret: toB64(sign.secretKey),
  };
}

export const newCircleKey = () => toB64(nacl.randomBytes(nacl.secretbox.keyLength));

/**
 * The key for direct messages between two members: X25519 between their
 * identity keys, so only those two phones can derive it (not the server, not
 * the rest of the circle). Both sides get the same key.
 */
export function directKey(myBoxSecret, peerBoxPub) {
  return toB64(kdf('homecircle/direct-v1', nacl.box.before(fromB64(peerBoxPub), fromB64(myBoxSecret))));
}

/**
 * Sign-then-encrypt a payload with the circle key (or, for a direct message,
 * the pair's direct key and the recipient in `to`). The server only ever sees
 * { epoch, nonce, ct }.
 */
export function seal({ kind, from, to, circle, epoch, key, signSecret, body, ts = Date.now() }) {
  if (!KINDS.includes(kind)) throw new Error(`unknown kind ${kind}`);
  const inner = { v: PROTOCOL_VERSION, kind, from, circle, epoch, ts, body };
  if (to) inner.to = to;
  const plaintext = utf8Encode(JSON.stringify(inner));
  const signed = nacl.sign(plaintext, fromB64(signSecret));
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ct = nacl.secretbox(signed, nonce, fromB64(key));
  return { epoch, nonce: toB64(nonce), ct: toB64(ct) };
}

/**
 * Decrypt and verify an envelope. Checks that the sender, kind, circle and
 * epoch inside the ciphertext match what we expected from the outer metadata.
 */
export function open(envelope, { key, signPub, kind, from, to, circle }) {
  let signed;
  try {
    signed = nacl.secretbox.open(fromB64(envelope.ct), fromB64(envelope.nonce), fromB64(key));
  } catch {
    throw new CryptoError('malformed');
  }
  if (!signed) throw new CryptoError('decrypt');
  const plaintext = nacl.sign.open(signed, fromB64(signPub));
  if (!plaintext) throw new CryptoError('signature');
  let msg;
  try {
    msg = JSON.parse(utf8Decode(plaintext));
  } catch {
    throw new CryptoError('json');
  }
  if (msg.v !== PROTOCOL_VERSION) throw new CryptoError('version');
  if (kind && msg.kind !== kind) throw new CryptoError('kind');
  if (from && msg.from !== from) throw new CryptoError('sender');
  if (circle && msg.circle !== circle) throw new CryptoError('circle');
  // A direct message can't be passed off as a group one, or redirected.
  if ((msg.to ?? null) !== (to ?? null)) throw new CryptoError('recipient');
  if (msg.epoch !== envelope.epoch) throw new CryptoError('epoch');
  return msg;
}

/** Profiles are self-signed and must contain the same public keys the server lists. */
export function openProfile(envelope, { key, circle, memberId, boxPub, signPub }) {
  const msg = open(envelope, { key, signPub, kind: 'profile', from: memberId, circle });
  if (msg.body.signPub !== signPub || msg.body.boxPub !== boxPub) throw new CryptoError('key-mismatch');
  return msg;
}

// --- Invites -------------------------------------------------------------

export function newInviteSecret() {
  return toB64(nacl.randomBytes(32));
}

export function deriveInvite(secret) {
  const s = fromB64(secret);
  if (s.length !== 32) throw new Error('invalid invite secret');
  return {
    inviteAuth: toB64(kdf('homecircle/invite-auth', s)),
    wrapKey: kdf('homecircle/invite-wrap', s),
  };
}

/** What the server stores to check invite auth: first 32 bytes of SHA-512. */
export function inviteAuthHash(inviteAuth) {
  return toB64(nacl.hash(fromB64(inviteAuth)).slice(0, 32));
}

export function wrapInvite(wrapKey, payload) {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ct = nacl.secretbox(utf8Encode(JSON.stringify(payload)), nonce, wrapKey);
  return { nonce: toB64(nonce), ct: toB64(ct) };
}

export function unwrapInvite(wrapKey, wrapped) {
  const pt = nacl.secretbox.open(fromB64(wrapped.ct), fromB64(wrapped.nonce), wrapKey);
  if (!pt) throw new CryptoError('invite');
  return JSON.parse(utf8Decode(pt));
}

// --- Key rotation --------------------------------------------------------

/** Encrypt a circle key to one member (authenticated by the sender's box key). */
export function boxCircleKey({ circleKey, epoch, circle, toBoxPub, fromBoxSecret }) {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const pt = utf8Encode(JSON.stringify({ key: circleKey, epoch, circle }));
  const ct = nacl.box(pt, nonce, fromB64(toBoxPub), fromB64(fromBoxSecret));
  return { nonce: toB64(nonce), ct: toB64(ct) };
}

export function openCircleKeyBox(envelope, { fromBoxPub, myBoxSecret, epoch, circle }) {
  const pt = nacl.box.open(fromB64(envelope.ct), fromB64(envelope.nonce), fromB64(fromBoxPub), fromB64(myBoxSecret));
  if (!pt) throw new CryptoError('key-envelope');
  const msg = JSON.parse(utf8Decode(pt));
  if (msg.epoch !== epoch || msg.circle !== circle) throw new CryptoError('key-envelope-context');
  if (fromB64(msg.key).length !== 32) throw new CryptoError('key-envelope-key');
  return msg.key;
}

/**
 * For someone rejoining with the server's setup code: the circle key and name,
 * encrypted by the approving member's phone to the requester's key.
 */
export function boxRejoin({ circleKey, epoch, circle, circleName, approvedByName, toBoxPub, fromBoxSecret }) {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const pt = utf8Encode(JSON.stringify({ kind: 'rejoin', key: circleKey, epoch, circle, circleName, approvedByName }));
  const ct = nacl.box(pt, nonce, fromB64(toBoxPub), fromB64(fromBoxSecret));
  return { nonce: toB64(nonce), ct: toB64(ct) };
}

export function openRejoinBox(envelope, { fromBoxPub, myBoxSecret, epoch, circle }) {
  const pt = nacl.box.open(fromB64(envelope.ct), fromB64(envelope.nonce), fromB64(fromBoxPub), fromB64(myBoxSecret));
  if (!pt) throw new CryptoError('rejoin');
  const msg = JSON.parse(utf8Decode(pt));
  if (msg.kind !== 'rejoin' || msg.epoch !== epoch || msg.circle !== circle) throw new CryptoError('rejoin-context');
  if (fromB64(msg.key).length !== 32) throw new CryptoError('rejoin-key');
  return msg;
}

// --- Safety numbers ------------------------------------------------------

/** 30-digit fingerprint of a member's public keys, for in-person verification. */
export function safetyNumber(signPub, boxPub) {
  const h = nacl.hash(concat(utf8Encode('homecircle/safety-number'), fromB64(signPub), fromB64(boxPub)));
  const groups = [];
  for (let g = 0; g < 6; g++) {
    let n = 0;
    for (let i = 0; i < 5; i++) n = n * 256 + h[g * 5 + i];
    groups.push(String(n % 100000).padStart(5, '0'));
  }
  return groups.join(' ');
}

// --- Links ---------------------------------------------------------------

export function normalizeServerUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Enter your server address');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  // Regex instead of URL(): React Native's URL implementation is incomplete.
  const m = s.match(/^(https?):\/\/([^/?#:]+|\[[0-9a-fA-F:]+\])(:\d+)?(?:[/?#].*)?$/i);
  if (!m) throw new Error("That doesn't look like a server address");
  const protocol = m[1].toLowerCase();
  const host = m[2].toLowerCase();
  if (protocol !== 'https' && !isLocalHost(host)) {
    throw new Error('Use an https:// address (plain http is only allowed for local testing)');
  }
  return `${protocol}://${host}${m[3] || ''}`;
}

function isLocalHost(host) {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host.endsWith('.local') ||
    /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

export function inviteLink(serverUrl, inviteId, secret) {
  return `${serverUrl}/join#${inviteId}.${secret}`;
}

export function appInviteLink(serverUrl, inviteId, secret) {
  return `homecircle://join?server=${encodeURIComponent(serverUrl)}&i=${inviteId}&s=${secret}`;
}

/** Accepts https://server/join#id.secret or homecircle://join?server=…&i=…&s=… */
export function parseInviteLink(link) {
  const s = String(link || '').trim();
  const app = s.match(/^homecircle:\/\/join\?(.*)$/i);
  if (app) {
    const params = Object.fromEntries(
      app[1].split('&').map((kv) => kv.split('=').map((x) => decodeURIComponent(x || ''))),
    );
    if (!params.server || !params.i || !params.s) throw new Error('This invite link is incomplete');
    return { serverUrl: normalizeServerUrl(params.server), inviteId: params.i, secret: params.s };
  }
  const web = s.match(/^(https?:\/\/[^/#?]+)\/join\/?#([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  if (web) return { serverUrl: normalizeServerUrl(web[1]), inviteId: web[2], secret: web[3] };
  throw new Error("That doesn't look like a HomeCircle invite link");
}
