// Mesh packets: a compact form of a sealed location or SOS, small enough for
// one LoRa packet over Meshtastic (~233 bytes), from a HomeCircle tracker.
// A home base node hands them to the server (server/src/mesh.js), which
// can't read them; it stores them as { epoch, mesh } envelopes and the apps
// open them here. See docs/PROTOCOL.md, "Mesh packets".
//
//   0   2  "hc"
//   2   1  version (1)
//   3   1  type: 1 location, 2 SOS start, 3 SOS safe, 4 group message,
//          5 direct message
//   4   8  sender ref: SHA-512("homecircle/mesh-ref" ‖ member id)[0..8]
//   12  4  counter (little-endian; only ever goes up, per sender)
//   16  2  epoch (little-endian)
//   18  12 message id (all but locations; the same id as the same message sent over the internet)
//   30  8  recipient ref (direct messages only): their meshRef, so the server can deliver it
//   …      secretbox(content ‖ Ed25519 signature, nonce, CK_epoch),
//          nonce = SHA-512("homecircle/mesh-nonce" ‖ header)[0..24]
//   -8  8  tag: HMAC-SHA-512(sender's mesh key, everything before)[0..8],
//          checked by the server so nobody else can fill a sender's slot
//
// The signature covers "homecircle/mesh-v1\0" ‖ circle ‖ "\0" ‖ member ‖ "\0"
// ‖ header ‖ content, so a packet can't be moved to another circle, member,
// type or epoch.
//
// Messages come from a phone through the tracker its person carries (over
// Bluetooth, then the mesh), when the phone has no internet. Content: a
// u32 time, then the text (UTF-8). A direct message's text is sealed again
// with the two members' direct key (nonce from the header), so the rest of
// the circle can't read it.
import nacl from 'tweetnacl';
import { fromB64, toB64, utf8Encode, utf8Decode, concat } from './encoding.js';

export const MESH_LOCATION = 1;
export const MESH_SOS_START = 2;
export const MESH_SOS_SAFE = 3;
export const MESH_CHAT = 4;
export const MESH_DIRECT = 5;
const HEADER = 18;
const ID_BYTES = 12;
const TO_BYTES = 8;
const TAG = 8;
/**
 * The most one packet carries when it's addressed to the home base: Meshtastic
 * encrypts a packet to one node with both nodes' keys, which takes 12 more
 * bytes of the 255 a LoRa packet holds (233 for a broadcast).
 */
const LORA_MAX = 221;
/** The most text (UTF-8 bytes) one mesh message carries: a group message, and a direct one (sealed twice). */
export const MESH_TEXT_MAX = {
  chat: LORA_MAX - (HEADER + ID_BYTES) - 16 - 4 - 64 - TAG,
  direct: LORA_MAX - (HEADER + ID_BYTES + TO_BYTES) - 16 - 4 - 16 - 64 - TAG,
};

const headerLength = (type) => (type === MESH_LOCATION ? HEADER : type === MESH_DIRECT ? HEADER + ID_BYTES + TO_BYTES : HEADER + ID_BYTES);

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
  if (type < 1 || type > 5) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = headerLength(type);
  if (bytes.length < headerLen + 16 + 64 + TAG) return null;
  return {
    type,
    ref: toB64(bytes.slice(4, 12)),
    counter: dv.getUint32(12, true),
    epoch: dv.getUint16(16, true),
    id: type === MESH_LOCATION ? null : toB64(bytes.slice(HEADER, HEADER + ID_BYTES)),
    to: type === MESH_DIRECT ? toB64(bytes.slice(HEADER + ID_BYTES, HEADER + ID_BYTES + TO_BYTES)) : null,
    headerLen,
  };
}

/** HMAC-SHA-512 (the server's tag check), with nacl's hash. */
function hmac512(key, msg) {
  const block = new Uint8Array(128);
  block.set(key.length > 128 ? nacl.hash(key) : key);
  const ipad = block.map((b) => b ^ 0x36);
  const opad = block.map((b) => b ^ 0x5c);
  return nacl.hash(concat(opad, nacl.hash(concat(ipad, msg))));
}

const directNonce = (header) => sha512(utf8Encode('homecircle/mesh-direct'), header).slice(0, 24);

/**
 * Seal a message for the mesh, as a tracker would its location: one packet
 * (Uint8Array) for the tracker to send. `text` must fit MESH_TEXT_MAX.
 * { from, circle, epoch, key (circle key), meshKey, signSecret, counter, id, text, ts, to?, toId?, directKey? }
 */
export function sealMeshMessage({ from, circle, epoch, key, meshKey, signSecret, counter, id, text, ts = Date.now(), toId = null, directKey = null }) {
  const type = toId ? MESH_DIRECT : MESH_CHAT;
  const header = new Uint8Array(headerLength(type));
  const dv = new DataView(header.buffer);
  header.set([0x68, 0x63, 1, type]);
  header.set(fromB64(meshRef(from)), 4);
  dv.setUint32(12, counter >>> 0, true);
  dv.setUint16(16, epoch, true);
  const idBytes = fromB64(id);
  if (idBytes.length !== ID_BYTES) throw new Error('mesh: id must be 12 bytes');
  header.set(idBytes, HEADER);
  if (toId) header.set(fromB64(meshRef(toId)), HEADER + ID_BYTES);
  let body = utf8Encode(text);
  if (body.length > (toId ? MESH_TEXT_MAX.direct : MESH_TEXT_MAX.chat)) throw new Error('mesh: too long for one packet');
  if (toId) body = nacl.secretbox(body, directNonce(header), fromB64(directKey));
  const content = new Uint8Array(4 + body.length);
  new DataView(content.buffer).setUint32(0, Math.floor(ts / 1000), true);
  content.set(body, 4);
  const z = new Uint8Array([0]);
  const signed = concat(utf8Encode('homecircle/mesh-v1'), z, utf8Encode(circle), z, utf8Encode(from), z, header, content);
  const sig = nacl.sign.detached(signed, fromB64(signSecret));
  const nonce = sha512(utf8Encode('homecircle/mesh-nonce'), header).slice(0, 24);
  const box = nacl.secretbox(concat(content, sig), nonce, fromB64(key));
  const unsigned = concat(header, box);
  return concat(unsigned, hmac512(fromB64(meshKey), unsigned).slice(0, TAG));
}

/**
 * Open a mesh packet (base64) into the same shape as open() returns:
 * { v, kind, from, circle, epoch, ts, body, id? }. Throws on anything wrong.
 */
export function openMesh(b64, { key, signPub, from, circle, directKey = null }) {
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
  if (h.type === MESH_CHAT || h.type === MESH_DIRECT) {
    if (content.length < 5) throw new Error('mesh: short');
    let text = content.slice(4);
    if (h.type === MESH_DIRECT) {
      if (!directKey) throw new Error('mesh: direct key');
      text = nacl.secretbox.open(text, directNonce(header), fromB64(directKey));
      if (!text) throw new Error('mesh: decrypt');
    }
    return { ...base, kind: 'chat', id: h.id, ts: dv.getUint32(0, true) * 1000, body: { text: utf8Decode(text), via: 'radio' } };
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
