// A little protobuf, enough for Meshtastic's phone API: read a message into
// its fields (keeping the raw bytes of each, so ones we don't know survive),
// change a few, and write it back. Field numbers come from Meshtastic's
// .proto files (meshNode.ts names the ones we use).

export type PbField = { n: number; wire: 0 | 1 | 2 | 5; /** varint value (wire 0) */ v?: bigint; /** bytes (wires 1, 2, 5) */ b?: Uint8Array };

function readVarint(buf: Uint8Array, at: number): [bigint, number] {
  let v = 0n;
  let shift = 0n;
  for (;;) {
    if (at >= buf.length) throw new Error('protobuf: truncated varint');
    const byte = buf[at++];
    v |= BigInt(byte & 127) << shift;
    if (!(byte & 128)) return [v, at];
    shift += 7n;
    if (shift > 70n) throw new Error('protobuf: varint too long');
  }
}

function writeVarint(v: bigint | number): number[] {
  let x = BigInt.asUintN(64, BigInt(v));
  const out: number[] = [];
  while (x > 127n) {
    out.push(Number(x & 127n) | 128);
    x >>= 7n;
  }
  out.push(Number(x));
  return out;
}

/** Every field of a message, in order (a repeated field appears once per value). */
export function decode(buf: Uint8Array): PbField[] {
  const out: PbField[] = [];
  let at = 0;
  while (at < buf.length) {
    const [key, next] = readVarint(buf, at);
    at = next;
    const n = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 0) {
      const [v, after] = readVarint(buf, at);
      at = after;
      out.push({ n, wire: 0, v });
    } else if (wire === 2) {
      const [len, after] = readVarint(buf, at);
      const end = after + Number(len);
      if (end > buf.length) throw new Error('protobuf: truncated field');
      out.push({ n, wire: 2, b: buf.slice(after, end) });
      at = end;
    } else if (wire === 5 || wire === 1) {
      const size = wire === 5 ? 4 : 8;
      if (at + size > buf.length) throw new Error('protobuf: truncated field');
      out.push({ n, wire, b: buf.slice(at, at + size) });
      at += size;
    } else {
      throw new Error(`protobuf: wire type ${wire}`);
    }
  }
  return out;
}

export function encode(fields: PbField[]): Uint8Array {
  const out: number[] = [];
  for (const f of fields) {
    out.push(...writeVarint((f.n << 3) | f.wire));
    if (f.wire === 0) out.push(...writeVarint(f.v ?? 0n));
    else if (f.wire === 2) out.push(...writeVarint(f.b!.length), ...f.b!);
    else out.push(...f.b!);
  }
  return Uint8Array.from(out);
}

// --- making fields -----------------------------------------------------------------

export const u = (n: number, v: number | bigint | boolean): PbField => ({ n, wire: 0, v: BigInt(typeof v === 'boolean' ? Number(v) : v) });
export const bytes = (n: number, b: Uint8Array): PbField => ({ n, wire: 2, b });
export const str = (n: number, s: string): PbField => ({ n, wire: 2, b: new TextEncoder().encode(s) });
export const msg = (n: number, fields: PbField[]): PbField => ({ n, wire: 2, b: encode(fields) });
export const fixed32 = (n: number, v: number): PbField => {
  const x = v >>> 0;
  return { n, wire: 5, b: Uint8Array.of(x & 255, (x >>> 8) & 255, (x >>> 16) & 255, (x >>> 24) & 255) };
};

// --- reading fields ----------------------------------------------------------------

export const first = (fields: PbField[], n: number) => fields.find((f) => f.n === n);
export const all = (fields: PbField[], n: number) => fields.filter((f) => f.n === n);
export const num = (fields: PbField[], n: number): number | null => {
  const f = first(fields, n);
  if (!f) return null;
  if (f.wire === 0) return Number(BigInt.asIntN(64, f.v!));
  if (f.wire === 5 && f.b) return new DataView(f.b.buffer, f.b.byteOffset, 4).getUint32(0, true);
  return null;
};
/** sfixed32 (latitude_i, longitude_i). */
export const sfixed32 = (fields: PbField[], n: number): number | null => {
  const f = first(fields, n);
  return f?.wire === 5 && f.b ? new DataView(f.b.buffer, f.b.byteOffset, 4).getInt32(0, true) : null;
};
export const text = (fields: PbField[], n: number): string | null => {
  const f = first(fields, n);
  return f?.wire === 2 && f.b ? new TextDecoder().decode(f.b) : null;
};
export const sub = (fields: PbField[], n: number): PbField[] | null => {
  const f = first(fields, n);
  return f?.wire === 2 && f.b ? decode(f.b) : null;
};

/**
 * A copy of `fields` with these set: each replaces every value of that field
 * number (a repeated field takes them all), keeping the rest as they were.
 */
export function patch(fields: PbField[], set: PbField[]): PbField[] {
  const numbers = new Set(set.map((f) => f.n));
  return [...fields.filter((f) => !numbers.has(f.n)), ...set];
}
