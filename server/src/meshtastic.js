// The home base: a Meshtastic node the server (or a bridge at home) talks to
// through Meshtastic's client API. It listens for HomeCircle tracker packets
// (PRIVATE_APP port, starting "hc") and hands them to the server's
// /mesh/packets, which checks and stores them. It can't read them.
//
// Only the few protobuf fields needed are read and written here, so there is
// nothing to install. Links:
//   tcp://192.168.1.60:4403  a node on Wi-Fi (Meshtastic's TCP API)
//   serial:/dev/ttyUSB0      a node on USB (Linux; sets the port with stty)
import { createConnection } from 'node:net';
import { createReadStream, createWriteStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const PRIVATE_APP = 256;
const START1 = 0x94;
const START2 = 0xc3;
const MAX_FRAME = 512;

// --- protobuf, just enough ---------------------------------------------------

function readVarint(buf, pos) {
  let v = 0n;
  let shift = 0n;
  for (;;) {
    if (pos >= buf.length) throw new Error('protobuf: truncated');
    const b = buf[pos++];
    v |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return [v, pos];
    shift += 7n;
    if (shift > 63n) throw new Error('protobuf: varint too long');
  }
}

/** Fields of one message: [{ no, wt, value }] (value: BigInt, Buffer, or a 32-bit number). */
export function pbFields(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = readVarint(buf, pos);
    const no = Number(key >> 3n);
    const wt = Number(key & 7n);
    if (wt === 0) {
      let v;
      [v, pos] = readVarint(buf, pos);
      out.push({ no, wt, value: v });
    } else if (wt === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      const end = pos + Number(len);
      if (end > buf.length) throw new Error('protobuf: truncated');
      out.push({ no, wt, value: buf.subarray(pos, end) });
      pos = end;
    } else if (wt === 5) {
      if (pos + 4 > buf.length) throw new Error('protobuf: truncated');
      out.push({ no, wt, value: buf.readUInt32LE(pos) });
      pos += 4;
    } else if (wt === 1) {
      pos += 8;
    } else {
      throw new Error(`protobuf: wire type ${wt}`);
    }
  }
  return out;
}

function varint(n) {
  const out = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}
export const pbVarint = (no, v) => Buffer.concat([varint((no << 3) | 0), varint(v)]);
export const pbBytes = (no, b) => Buffer.concat([varint((no << 3) | 2), varint(b.length), b]);
export const pbFixed32 = (no, v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return Buffer.concat([varint((no << 3) | 5), b]);
};

/**
 * From a FromRadio message, the mesh packet it carries, if any:
 * { from, to, id, channel, portnum, payload } (payload only once the node decrypted it).
 */
export function packetOf(fromRadio) {
  const f = pbFields(fromRadio).find((x) => x.no === 2 && x.wt === 2); // FromRadio.packet
  if (!f) return null;
  const p = { from: 0, to: 0, id: 0, channel: 0, portnum: null, payload: null };
  for (const x of pbFields(f.value)) {
    if (x.no === 1 && x.wt === 5) p.from = x.value; // MeshPacket.from
    else if (x.no === 2 && x.wt === 5) p.to = x.value; // MeshPacket.to
    else if (x.no === 3 && x.wt === 0) p.channel = Number(x.value);
    else if (x.no === 6 && x.wt === 5) p.id = x.value; // MeshPacket.id
    else if (x.no === 4 && x.wt === 2) {
      // MeshPacket.decoded: Data
      for (const d of pbFields(x.value)) {
        if (d.no === 1 && d.wt === 0) p.portnum = Number(d.value);
        else if (d.no === 2 && d.wt === 2) p.payload = Buffer.from(d.value);
      }
    }
  }
  return p;
}

/** One framed message for the stream API. */
export const frame = (payload) => Buffer.concat([Buffer.from([START1, START2, payload.length >> 8, payload.length & 0xff]), payload]);

/** Splits the byte stream into messages; anything between frames is the node's debug log. */
export class Deframer {
  constructor(onMessage) {
    this.buf = Buffer.alloc(0);
    this.onMessage = onMessage;
  }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const start = this.buf.indexOf(START1);
      if (start < 0) {
        this.buf = Buffer.alloc(0);
        return;
      }
      if (start > 0) this.buf = this.buf.subarray(start);
      if (this.buf.length < 4) return;
      if (this.buf[1] !== START2) {
        this.buf = this.buf.subarray(1);
        continue;
      }
      const len = (this.buf[2] << 8) | this.buf[3];
      if (len > MAX_FRAME) {
        this.buf = this.buf.subarray(1);
        continue;
      }
      if (this.buf.length < 4 + len) return;
      const msg = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      try {
        this.onMessage(Buffer.from(msg));
      } catch {
        // A message this code can't read: not ours.
      }
    }
  }
}

/** Is this payload a HomeCircle tracker packet? */
export const isHomeCirclePacket = (b) => !!b && b.length > 20 && b[0] === 0x68 && b[1] === 0x63 && b[2] === 1;

// --- the bridge -----------------------------------------------------------------

/**
 * Connect to a Meshtastic node and forward HomeCircle packets to a server.
 * Reconnects by itself. Returns { stop() }.
 */
export function startMeshBridge({ node, server, log = console.log, fetchImpl = fetch }) {
  const endpoint = `${server.replace(/\/+$/, '')}/api/v1/mesh/packets`;
  const queue = [];
  const seen = new Map(); // packet hash -> time, so the same packet heard twice goes once
  let stopped = false;
  let link = null;
  let retry = null;
  let flushing = false;
  let heartbeat = null;

  const remember = (b) => {
    const h = createHash('sha256').update(b).digest('base64url');
    const now = Date.now();
    for (const [k, t] of seen) if (now - t > 10 * 60_000) seen.delete(k);
    if (seen.has(h)) return false;
    seen.set(h, now);
    return true;
  };

  async function flush() {
    if (flushing || !queue.length) return;
    flushing = true;
    try {
      while (queue.length) {
        const batch = queue.slice(0, 20);
        const res = await fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ packets: batch }) });
        if (res.status === 429 || res.status >= 500) throw new Error(`server answered ${res.status}`);
        queue.splice(0, batch.length);
        const { results = [] } = await res.json().catch(() => ({}));
        log(`mesh bridge: forwarded ${batch.length} (${results.join(', ')})`);
      }
    } catch (e) {
      log(`mesh bridge: couldn't reach the server (${e.message}); will retry`);
      setTimeout(flush, 30_000).unref?.();
    } finally {
      flushing = false;
    }
  }

  const onMessage = (msg) => {
    const p = packetOf(msg);
    if (!p || p.portnum !== PRIVATE_APP || !isHomeCirclePacket(p.payload) || !remember(p.payload)) return;
    queue.push(p.payload.toString('base64url'));
    if (queue.length > 200) queue.shift();
    flush();
  };

  // ToRadio.want_config_id starts the node sending what it hears.
  const hello = () => frame(pbVarint(3, (Math.random() * 0xffffffff) >>> 0));
  // ToRadio.heartbeat (an empty message), so the node keeps the link open.
  const ping = () => frame(pbBytes(7, Buffer.alloc(0)));

  function connect() {
    if (stopped) return;
    const deframer = new Deframer(onMessage);
    const again = () => {
      clearInterval(heartbeat);
      if (stopped || retry) return;
      retry = setTimeout(() => {
        retry = null;
        connect();
      }, 10_000);
    };
    if (node.startsWith('tcp://')) {
      const [host, port = '4403'] = node.slice(6).split(':');
      const sock = createConnection({ host, port: Number(port) }, () => {
        log(`mesh bridge: connected to the node at ${host}:${port}`);
        sock.write(hello());
      });
      sock.on('data', (d) => deframer.push(d));
      sock.on('error', (e) => log(`mesh bridge: ${e.message}`));
      sock.on('close', again);
      link = { write: (b) => sock.write(b), close: () => sock.destroy() };
    } else if (node.startsWith('serial:')) {
      const path = node.slice(7);
      try {
        execFileSync('stty', ['-F', path, '115200', 'raw', '-echo']);
      } catch (e) {
        log(`mesh bridge: couldn't set up ${path} (${e.message})`);
      }
      const rx = createReadStream(path);
      const tx = createWriteStream(path);
      rx.on('data', (d) => deframer.push(d));
      rx.on('error', (e) => {
        log(`mesh bridge: ${e.message}`);
        again();
      });
      rx.on('close', again);
      // Wake the node's serial API, then ask for its stream.
      tx.write(Buffer.alloc(32, START2));
      setTimeout(() => tx.write(hello()), 100);
      log(`mesh bridge: listening on ${path}`);
      link = { write: (b) => tx.write(b), close: () => (rx.destroy(), tx.destroy()) };
    } else {
      throw new Error('MESH_NODE must look like tcp://192.168.1.60:4403 or serial:/dev/ttyUSB0');
    }
    heartbeat = setInterval(() => link?.write(ping()), 5 * 60_000);
    heartbeat.unref?.();
  }

  connect();
  return {
    stop() {
      stopped = true;
      clearTimeout(retry);
      clearInterval(heartbeat);
      link?.close();
    },
  };
}
