// The little of Meshtastic's protobuf API HomeCircle writes: a ToRadio with
// one packet, our sealed message as a PRIVATE_APP broadcast (meshRadio.ts).
// Field numbers from Meshtastic's mesh.proto.

const PRIVATE_APP = 256;
const BROADCAST = 0xffffffff;

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n >>> 0;
  while (v > 127) {
    out.push((v & 127) | 128);
    v >>>= 7;
  }
  out.push(v);
  return out;
}
const tagged = (field: number, wire: number) => varint(field * 8 + wire);
const lengthDelimited = (field: number, bytes: number[] | Uint8Array) => [...tagged(field, 2), ...varint(bytes.length), ...bytes];
const fixed32 = (field: number, n: number) => [...tagged(field, 5), n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const uint = (field: number, n: number) => [...tagged(field, 0), ...varint(n)];

/** ToRadio { packet } with our payload as a PRIVATE_APP broadcast on the primary channel. */
export function toRadio(payload: Uint8Array): Uint8Array {
  const data = [...uint(1, PRIVATE_APP), ...lengthDelimited(2, payload)];
  const id = (Math.random() * 0xfffffffe + 1) >>> 0;
  const packet = [
    ...fixed32(2, BROADCAST), // to
    ...uint(3, 0), // channel 0: the tracker's primary (HomeCircle)
    ...lengthDelimited(4, data), // decoded
    ...fixed32(6, id),
    ...uint(9, 3), // hop limit
    ...uint(11, 70), // priority: reliable
  ];
  return Uint8Array.from(lengthDelimited(1, packet));
}

