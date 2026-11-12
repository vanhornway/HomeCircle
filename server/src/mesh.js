// Mesh packets from HomeCircle trackers, handed in by a home base (a
// Meshtastic node on the server or a bridge at home, mesh-bridge.js). The
// server can't open them: it reads the clear header to find the sender,
// checks the tag made with that sender's mesh key (registered over HTTPS)
// and that the counter went up, then stores the packet as the sender's
// location or as a message. The apps open and verify it (packages/core
// mesh.js; layout there and in docs/PROTOCOL.md).
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const MESH_LOCATION = 1;
export const MESH_SOS_START = 2;
export const MESH_SOS_SAFE = 3;
const HEADER = 18;
const ID_BYTES = 12;
const TAG = 8;
export const MESH_MAX_BYTES = 240;

/** The 8-byte ref a member's packets carry (base64url): SHA-512("homecircle/mesh-ref" ‖ id)[0..8]. */
export function meshRef(memberId) {
  return createHash('sha512').update('homecircle/mesh-ref').update(memberId, 'utf8').digest().subarray(0, 8).toString('base64url');
}

/** The clear header, or null if this isn't a mesh packet. */
export function meshHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length > MESH_MAX_BYTES || buf.length < HEADER + 16 + 64 + TAG) return null;
  if (buf[0] !== 0x68 || buf[1] !== 0x63 || buf[2] !== 1) return null;
  const type = buf[3];
  if (type !== MESH_LOCATION && type !== MESH_SOS_START && type !== MESH_SOS_SAFE) return null;
  const headerLen = type === MESH_LOCATION ? HEADER : HEADER + ID_BYTES;
  if (buf.length < headerLen + 16 + 64 + TAG) return null;
  return {
    type,
    ref: buf.subarray(4, 12).toString('base64url'),
    counter: buf.readUInt32LE(12),
    epoch: buf.readUInt16LE(16),
    id: type === MESH_LOCATION ? null : buf.subarray(HEADER, HEADER + ID_BYTES).toString('base64url'),
  };
}

/** True if the packet's tag was made with this mesh key. */
export function meshTagOk(key, buf) {
  const want = createHmac('sha512', key).update(buf.subarray(0, buf.length - TAG)).digest().subarray(0, TAG);
  return timingSafeEqual(want, buf.subarray(buf.length - TAG));
}
