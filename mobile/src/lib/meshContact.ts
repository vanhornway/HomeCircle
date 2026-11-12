// A Meshtastic "Share contact" link: meshtastic.org/v/#<base64url SharedContact>.
// The Meshtastic app shows it as a QR code (a node → Share contact). Adding a
// tracker from it fills in its node id and name; the home base reads the same
// link (its `add` command) and takes the tracker's key from it.
//
// SharedContact: node_num (1, varint), user (2): id (1), long_name (2),
// short_name (3), hw_model (5, varint), public_key (8). A small protobuf
// reader is enough: varints and length-delimited fields.

export type MeshContact = { node: string; longName: string; shortName: string; model: string | null; link: string };

/** A few trackers by Meshtastic's hardware model number, for "SenseCAP T1000-E" rather than a number. */
const MODELS: Record<number, string> = {
  4: 'LilyGO T-Beam',
  7: 'LilyGO T-Echo',
  9: 'RAK WisBlock',
  12: 'LilyGO T-Beam S3',
  21: 'Seeed Wio WM1110',
  43: 'Heltec V3',
  48: 'Heltec Wireless Tracker',
  58: 'Heltec Wireless Tracker',
  71: 'SenseCAP T1000-E',
  89: 'ThinkNode M1',
  94: 'Heltec MeshPocket',
  99: 'Seeed Wio Tracker L1',
  110: 'Heltec V4',
  115: 'ThinkNode M3',
};

function fromBase64(s: string): Uint8Array | null {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const clean = s.replace(/=+$/, '').trim();
  const out: number[] = [];
  let value = 0;
  let bits = 0;
  for (const c of clean) {
    const v = c === '-' || c === '+' ? 62 : c === '_' || c === '/' ? 63 : abc.indexOf(c);
    if (v < 0) return null;
    value = ((value << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

type Field = { field: number; wire: number; value: number; start: number; length: number };

function fields(b: Uint8Array, from: number, to: number): Field[] | null {
  const out: Field[] = [];
  let at = from;
  const varint = (): number | null => {
    let v = 0;
    let mult = 1;
    while (at < to) {
      const c = b[at++];
      v += (c & 0x7f) * mult;
      if (!(c & 0x80)) return v;
      mult *= 128;
      if (mult > 2 ** 56) return null;
    }
    return null;
  };
  while (at < to) {
    const key = varint();
    if (key == null) return null;
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) {
      const v = varint();
      if (v == null) return null;
      out.push({ field, wire, value: v, start: at, length: 0 });
    } else if (wire === 2) {
      const len = varint();
      if (len == null || at + len > to) return null;
      out.push({ field, wire, value: 0, start: at, length: len });
      at += len;
    } else if (wire === 5) {
      at += 4;
    } else if (wire === 1) {
      at += 8;
    } else {
      return null;
    }
    if (at > to) return null;
  }
  return out;
}

/** UTF-8 to a string (by hand: not every phone's JavaScript has TextDecoder). */
const text = (b: Uint8Array, f: Field) => {
  const bytes = b.subarray(f.start, f.start + f.length);
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const c = bytes[i++];
    let cp = c;
    if (c >= 0xf0) cp = ((c & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    else if (c >= 0xe0) cp = ((c & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    else if (c >= 0xc0) cp = ((c & 31) << 6) | (bytes[i++] & 63);
    out += String.fromCodePoint(cp);
  }
  return out;
};

/** What a Share contact link (or a QR code's text) says, or null if it isn't one. */
export function parseContactLink(raw: string): MeshContact | null {
  const s = raw.trim();
  const at = s.indexOf('/v/#');
  if (at < 0) return null;
  const b = fromBase64(s.slice(at + 4));
  if (!b) return null;
  const top = fields(b, 0, b.length);
  if (!top) return null;
  const num = top.find((f) => f.field === 1 && f.wire === 0)?.value ?? 0;
  if (!num || num > 0xffffffff) return null;
  const userField = top.find((f) => f.field === 2 && f.wire === 2);
  const user = userField ? fields(b, userField.start, userField.start + userField.length) : [];
  if (!user) return null;
  const longName = user.find((f) => f.field === 2 && f.wire === 2);
  const shortName = user.find((f) => f.field === 3 && f.wire === 2);
  const model = user.find((f) => f.field === 5 && f.wire === 0)?.value;
  return {
    node: `!${num.toString(16).padStart(8, '0')}`,
    longName: longName ? text(b, longName).slice(0, 40) : '',
    shortName: shortName ? text(b, shortName).slice(0, 8) : '',
    model: model != null ? (MODELS[model] ?? null) : null,
    link: s.split(/\s/)[0],
  };
}
