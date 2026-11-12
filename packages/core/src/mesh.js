// Mesh packets: a compact form of a sealed location or SOS, small enough for
// one LoRa packet over Meshtastic (~233 bytes), from a HomeCircle tracker.
// A home base node hands them to the server (server/src/mesh.js), which
// can't read them; it stores them as { epoch, mesh } envelopes and the apps
// open them here. See docs/PROTOCOL.md, "Mesh packets".
//
//   0   2  "hc"
//   2   1  version (1)
//   3   1  type: 1 location, 2 SOS start, 3 SOS safe
//   4   8  sender ref: SHA-512("homecircle/mesh-ref" ‖ member id)[0..8]
//   12  4  counter (little-endian; only ever goes up, per sender)
//   16  2  epoch (little-endian)
//   18  12 message id (SOS only; the same id as the same SOS sent over the internet)
//   …      secretbox(content ‖ Ed25519 signature, nonce, CK_epoch),
//          nonce = SHA-512("homecircle/mesh-nonce" ‖ header)[0..24]
//   -8  8  tag: HMAC-SHA-512(sender's mesh key, everything before)[0..8],
//          checked by the server so nobody else can fill a sender's slot
//
// The signature covers "homecircle/mesh-v1\0" ‖ circle ‖ "\0" ‖ member ‖ "\0"
// ‖ header ‖ content, so a packet can't be moved to another circle, member,
// type or epoch.
import nacl from 'tweetnacl';
import { fromB64, toB64, utf8Encode, concat } from './encoding.js';

export const MESH_LOCATION = 1;
export const MESH_SOS_START = 2;
export const MESH_SOS_SAFE = 3;
const HEADER = 18;
const ID_BYTES = 12;
const TAG = 8;

const sha512 = (...parts) => nacl.hash(concat(...parts));

/** The 8-byte ref a member's mesh packets carry (base64url). */
export function meshRef(memberId) {
  return toB64(sha512(utf8Encode('homecircle/mesh-ref'), utf8Encode(memberId)).slice(0, 8));
}

/** The clear header of a mesh packet, or null if it isn't one. */
export function meshHeader(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < HEADER + 16 + 64 + TAG) return null;
  if (bytes[0] !== 0x68 || bytes[1] !== 0x63 || bytes[2] !== 1) return null;
  const type = bytes[3];
  if (type < 1 || type > 3) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = type === MESH_LOCATION ? HEADER : HEADER + ID_BYTES;
  if (bytes.length < headerLen + 16 + 64 + TAG) return null;
  return {
    type,
    ref: toB64(bytes.slice(4, 12)),
    counter: dv.getUint32(12, true),
    epoch: dv.getUint16(16, true),
    id: type === MESH_LOCATION ? null : toB64(bytes.slice(HEADER, HEADER + ID_BYTES)),
    headerLen,
  };
}

/**
 * Open a mesh packet (base64) into the same shape as open() returns:
 * { v, kind, from, circle, epoch, ts, body, id? }. Throws on anything wrong.
 */
export function openMesh(b64, { key, signPub, from, circle }) {
  const bytes = fromB64(b64);
  const h = meshHeader(bytes);
  if (!h) throw new Error('not a mesh packet');
  const header = bytes.slice(0, h.headerLen);
  const box = bytes.slice(h.headerLen, bytes.length - TAG);
  const nonce = sha512(utf8Encode('homecircle/mesh-nonce'), header).slice(0, 24);
  const inner = nacl.secretbox.open(box, nonce, fromB64(key));
  if (!inner || inner.length < 64) throw new Error('mesh: decrypt');
  const content = inner.slice(0, inner.length - 64);
  const sig = inner.slice(inner.length - 64);
  const z = new Uint8Array([0]);
  const signed = concat(utf8Encode('homecircle/mesh-v1'), z, utf8Encode(circle), z, utf8Encode(from), z, header, content);
  if (!nacl.sign.detached.verify(signed, sig, fromB64(signPub))) throw new Error('mesh: signature');
  const dv = new DataView(content.buffer, content.byteOffset, content.byteLength);
  const base = { v: 1, from, circle, epoch: h.epoch };

  if (h.type === MESH_LOCATION) {
    if (content.length < 18) throw new Error('mesh: short');
    const acc = dv.getUint16(12, true);
    const speed = dv.getUint16(14, true);
    const battery = content[16];
    const flags = content[17];
    return {
      ...base,
      kind: 'location',
      ts: dv.getUint32(0, true) * 1000,
      body: {
        lat: dv.getInt32(4, true) / 1e7,
        lng: dv.getInt32(8, true) / 1e7,
        accuracy: acc === 0xffff ? null : acc,
        battery: battery === 0xff ? null : battery / 100,
        charging: (flags & 1) === 1,
        speed: speed === 0xffff ? null : speed / 100,
        trigger: flags & 2 ? 'sos' : 'update',
        placeId: null,
        app: 'tracker',
        via: 'radio',
      },
    };
  }
  if (h.type === MESH_SOS_START) {
    if (content.length < 4) throw new Error('mesh: short');
    return {
      ...base,
      kind: 'chat',
      id: h.id,
      ts: dv.getUint32(0, true) * 1000,
      body: { text: '🆘 sent an SOS over radio. Open HomeCircle to see where they are.', sos: { state: 'start' }, via: 'radio' },
    };
  }
  if (content.length < 4 + ID_BYTES) throw new Error('mesh: short');
  return {
    ...base,
    kind: 'chat',
    id: h.id,
    ts: dv.getUint32(0, true) * 1000,
    body: { text: '✅ is safe now (sent over radio).', sos: { state: 'safe', of: toB64(content.slice(4, 4 + ID_BYTES)) }, via: 'radio' },
  };
}
