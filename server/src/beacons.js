// Public beacons: a HomeCircle tracker can send a rounded position on the
// public Meshtastic channel now and then (off unless an admin turns it on for
// it). Meshtastic gateways all over pass that channel to the public MQTT
// server. While any home base has asked for its trackers' beacons, this
// server listens there for those node ids only, reads their positions (the
// public channel's key is the published default, so these positions are
// public anyway), and hands each to the tracker's home base, which posts it,
// sealed, "via public mesh".
//
// A minimal MQTT 3.1.1 client (connect, subscribe, receive at QoS 0, ping):
// no dependency for a feature most servers never turn on.
import net from 'node:net';
import { createDecipheriv } from 'node:crypto';

// Meshtastic's default channel key ("AQ==" expands to this), as published.
const DEFAULT_KEY = Buffer.from('1PG7OiApB1nwvP+rz05pAQ==', 'base64');
const POSITION_APP = 3;

// --- protobuf, just enough ---------------------------------------------------------

function fields(buf) {
  const out = [];
  let at = 0;
  const varint = () => {
    let v = 0n;
    let shift = 0n;
    for (;;) {
      if (at >= buf.length) throw new Error('truncated');
      const b = buf[at++];
      v |= BigInt(b & 127) << shift;
      if (!(b & 128)) return v;
      shift += 7n;
    }
  };
  while (at < buf.length) {
    const key = Number(varint());
    const n = key >> 3;
    const wire = key & 7;
    if (wire === 0) out.push({ n, v: varint() });
    else if (wire === 2) {
      const len = Number(varint());
      out.push({ n, b: buf.subarray(at, at + len) });
      at += len;
    } else if (wire === 5) {
      out.push({ n, b: buf.subarray(at, at + 4) });
      at += 4;
    } else if (wire === 1) {
      out.push({ n, b: buf.subarray(at, at + 8) });
      at += 8;
    } else throw new Error(`wire ${wire}`);
  }
  return out;
}
const get = (fs, n) => fs.find((f) => f.n === n);
const u32 = (f) => (f?.b ? f.b.readUInt32LE(0) : f?.v != null ? Number(BigInt.asUintN(32, f.v)) : null);
const i32 = (f) => (f?.b ? f.b.readInt32LE(0) : null);

/**
 * A ServiceEnvelope from the public MQTT server: the position in it, if it's
 * from one of `watch` (node numbers) and is a position. Encrypted packets are
 * opened with the default key; others' channels simply don't open.
 */
export function decodeBeacon(payload, watch) {
  let env;
  try {
    env = fields(payload);
  } catch {
    return null;
  }
  const pktF = get(env, 1);
  if (!pktF?.b) return null;
  let pkt;
  try {
    pkt = fields(pktF.b);
  } catch {
    return null;
  }
  const from = u32(get(pkt, 1));
  if (from == null || !watch.has(from)) return null;
  const id = u32(get(pkt, 6)) ?? 0;
  let data = get(pkt, 4)?.b ?? null;
  const enc = get(pkt, 5)?.b;
  if (!data && enc) {
    const iv = Buffer.alloc(16);
    iv.writeUInt32LE(id, 0);
    iv.writeUInt32LE(from, 8);
    const d = createDecipheriv('aes-128-ctr', DEFAULT_KEY, iv);
    data = Buffer.concat([d.update(enc), d.final()]);
  }
  if (!data) return null;
  let decoded;
  try {
    decoded = fields(data);
  } catch {
    return null;
  }
  if (Number(get(decoded, 1)?.v ?? -1) !== POSITION_APP) return null;
  const payloadF = get(decoded, 2);
  if (!payloadF?.b) return null;
  let pos;
  try {
    pos = fields(payloadF.b);
  } catch {
    return null;
  }
  const lat = i32(get(pos, 1));
  const lng = i32(get(pos, 2));
  if (lat == null || lng == null || (!lat && !lng)) return null;
  const time = u32(get(pos, 4));
  const gw = get(env, 3)?.b?.toString('utf8') ?? null;
  return { from, lat: lat / 1e7, lng: lng / 1e7, at: time ? time * 1000 : Date.now(), gateway: gw && /^![0-9a-f]{8}$/.test(gw) ? gw : null };
}

// --- MQTT ------------------------------------------------------------------------

const str = (s) => {
  const b = Buffer.from(s, 'utf8');
  const l = Buffer.alloc(2);
  l.writeUInt16BE(b.length);
  return Buffer.concat([l, b]);
};
const remaining = (n) => {
  const out = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 128;
    out.push(byte);
  } while (n > 0);
  return Buffer.from(out);
};
const packet = (type, body) => Buffer.concat([Buffer.from([type]), remaining(body.length), body]);

/**
 * Listens to the public broker while there's something to watch. `onBeacon(node,
 * beacon)` for each position from a watched node. `url`: mqtt://user:pass@host:port;
 * `topic`: e.g. msh/US/#. Off when url is 'off' or empty.
 */
export class PublicBeacons {
  constructor({ url, topic, log = () => {}, onBeacon }) {
    this.url = url && url !== 'off' ? new URL(url) : null;
    this.topic = topic || 'msh/US/#';
    this.log = log;
    this.onBeacon = onBeacon;
    this.watch = new Map(); // node number -> Set of keys (who asked)
    this.sock = null;
    this.retry = 0;
    this.timer = null;
    this.ping = null;
    this.closed = false;
    this.received = 0; // messages seen on the topic (for logs and checks)
  }

  /** Who (a home base) wants which node numbers: replaces what it wanted before. */
  set(key, nodes) {
    for (const [n, who] of this.watch) {
      who.delete(key);
      if (!who.size) this.watch.delete(n);
    }
    for (const n of nodes) {
      if (!this.watch.has(n)) this.watch.set(n, new Set());
      this.watch.get(n).add(key);
    }
    this._sync();
  }

  get watching() {
    return this.watch.size;
  }

  _sync() {
    if (!this.url || this.closed) return;
    if (this.watch.size && !this.sock && !this.timer) this._connect();
    if (!this.watch.size && this.sock) this._disconnect();
  }

  _connect() {
    const u = this.url;
    const sock = net.connect({ host: u.hostname, port: Number(u.port) || 1883 });
    this.sock = sock;
    let buf = Buffer.alloc(0);
    sock.setTimeout(120_000, () => sock.destroy());
    sock.on('connect', () => {
      const body = Buffer.concat([
        str('MQTT'),
        Buffer.from([4, 0xc2, 0, 60]), // level 4; user, password, clean session; keep alive 60 s
        str(`homecircle-${Math.random().toString(36).slice(2, 10)}`),
        str(decodeURIComponent(u.username || '')),
        str(decodeURIComponent(u.password || '')),
      ]);
      sock.write(packet(0x10, body));
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        let len = 0;
        let mult = 1;
        let i = 1;
        for (; i < 5; i++) {
          if (i >= buf.length) return;
          len += (buf[i] & 127) * mult;
          mult *= 128;
          if (!(buf[i] & 128)) break;
        }
        const start = i + 1;
        if (buf.length < start + len) return;
        const type = buf[0] >> 4;
        const qos = (buf[0] >> 1) & 3;
        const body = buf.subarray(start, start + len);
        buf = buf.subarray(start + len);
        if (type === 2) {
          // CONNACK
          if (body[1] !== 0) {
            this.log(`public beacons: the broker refused us (${body[1]})`);
            sock.destroy();
            return;
          }
          this.retry = 0;
          sock.write(packet(0x82, Buffer.concat([Buffer.from([0, 1]), str(this.topic), Buffer.from([0])])));
          this.ping = setInterval(() => sock.write(Buffer.from([0xc0, 0])), 50_000);
          this.ping.unref?.();
          this.log(`public beacons: listening on ${this.topic} for ${this.watch.size} tracker(s)`);
        } else if (type === 3) {
          // PUBLISH
          const tlen = body.readUInt16BE(0);
          const payload = body.subarray(2 + tlen + (qos ? 2 : 0));
          this.received++;
          const beacon = decodeBeacon(payload, this.watch);
          if (beacon) this.onBeacon(beacon.from, beacon);
        }
      }
    });
    const gone = () => {
      clearInterval(this.ping);
      this.ping = null;
      if (this.sock === sock) this.sock = null;
      if (this.closed || !this.watch.size) return;
      const wait = Math.min(300_000, 5_000 * 2 ** this.retry++);
      this.timer = setTimeout(() => {
        this.timer = null;
        this._sync();
      }, wait);
      this.timer.unref?.();
    };
    sock.on('close', gone);
    sock.on('error', (e) => this.log(`public beacons: ${e.message}`));
  }

  _disconnect() {
    const s = this.sock;
    this.sock = null;
    clearInterval(this.ping);
    if (s) {
      s.write(Buffer.from([0xe0, 0]));
      s.end();
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this._disconnect();
  }
}
