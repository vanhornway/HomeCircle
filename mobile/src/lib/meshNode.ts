// A Meshtastic node over Bluetooth, the way its own phone app talks to it:
// ask for its configuration (want_config), read what it sends back (its node
// number, the nodes it knows with their positions, its settings and
// channels), and change settings with admin messages to itself. The node
// trusts admin messages from the phone connected to it (no passkey), once
// Android has paired with it (its PIN; 123456 on a T1000-E unless changed).
//
// Used to set up a gateway (Trackers → Gateways), set up a tracker (Trackers
// → Add), and read the tracker you carry (the phone bridge).
import { PermissionsAndroid, Platform } from 'react-native';
import { BleManager, type Device } from 'react-native-ble-plx';
import { all, bytes, decode, encode, fixed32, first, msg, num, sfixed32, sub, text, u, type PbField } from './pb';

const SERVICE = '6ba1b218-15a8-461f-9fa8-5dcae273eafd';
const TO_RADIO = 'f75c76d2-129e-4dad-a1dd-7866124401e7';
const FROM_RADIO = '2c55e69e-4993-11ed-b878-0242ac120002';
const ADMIN_APP = 6;

// Field numbers (Meshtastic's .proto files).
export const F = {
  fromRadio: { packet: 2, myInfo: 3, nodeInfo: 4, config: 5, configComplete: 7, moduleConfig: 9, channel: 10 },
  config: { device: 1, position: 2, power: 3, network: 4, lora: 6, bluetooth: 7, security: 8 },
  module: { mqtt: 1 },
  admin: { setOwner: 32, setChannel: 33, setConfig: 34, setModuleConfig: 35, setFavorite: 39, beginEdit: 64, commitEdit: 65, reboot: 97 },
  user: { id: 1, longName: 2, shortName: 3 },
  channel: { index: 1, settings: 2, role: 3 },
  channelSettings: { psk: 2, name: 3, uplink: 5, downlink: 6, moduleSettings: 7 },
  position: { broadcastSecs: 1, smart: 2, smartMinInterval: 11, gpsMode: 13 },
  lora: { region: 7, hopLimit: 8, channelNum: 11, okToMqtt: 105 },
  network: { wifiEnabled: 1, ssid: 3, psk: 4 },
  security: { adminKey: 3 },
  mqtt: { enabled: 1, address: 2, username: 3, password: 4, encryption: 5, tls: 7, root: 8, proxy: 9, mapReport: 10 },
} as const;

export const ROLE = { disabled: 0, primary: 1, secondary: 2 } as const;

let manager: BleManager | null = null;
const ble = () => (manager ??= new BleManager());

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function toB64(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < b.length ? B64[n & 63] : '=');
  }
  return out;
}
export function fromB64(s: string): Uint8Array {
  const clean = s.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
  const out: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const c of clean) {
    acc = (acc << 6) | B64.indexOf(c);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 255);
    }
  }
  return Uint8Array.from(out);
}

export async function blePermitted(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  if (Platform.Version >= 31) {
    const r = await PermissionsAndroid.requestMultiple([PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]);
    return Object.values(r).every((v) => v === PermissionsAndroid.RESULTS.GRANTED);
  }
  return (await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION)) === PermissionsAndroid.RESULTS.GRANTED;
}

/** A Meshtastic node's Bluetooth name ends with the last 4 hex digits of its node id: "UT2_f8c9". */
export const nameMatches = (name: string | null | undefined, node: string) => !!name && name.toLowerCase().endsWith(`_${node.slice(-4).toLowerCase()}`);

export type FoundNode = { id: string; name: string; device: Device };

/** Meshtastic nodes around (and ones already connected to this phone), for "pick the node". */
export async function scanNodes(ms = 8000, onFound?: (n: FoundNode) => void): Promise<FoundNode[]> {
  const found = new Map<string, FoundNode>();
  const add = (d: Device) => {
    const name = d.name || d.localName;
    if (!name || found.has(d.id)) return;
    const n = { id: d.id, name, device: d };
    found.set(d.id, n);
    onFound?.(n);
  };
  for (const d of await ble().connectedDevices([SERVICE]).catch(() => [] as Device[])) add(d);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      ble().stopDeviceScan();
      resolve();
    }, ms);
    ble().startDeviceScan(null, null, (error, d) => {
      if (error) {
        clearTimeout(timer);
        ble().stopDeviceScan();
        resolve();
        return;
      }
      // Meshtastic nodes name themselves "Name_abcd"; the service id may only be in the scan response.
      if (d && (d.serviceUUIDs?.includes(SERVICE) || /_[0-9a-f]{4}$/i.test(d.name || d.localName || ''))) add(d);
    });
  });
  return [...found.values()];
}

/** A device this phone has seen before, by its Bluetooth address (a paired tracker): no scan needed. */
export async function knownDevice(id: string): Promise<Device | null> {
  const list = await ble().devices([id]).catch(() => [] as Device[]);
  return list[0] ?? null;
}

/** A tracker by its node id ("!9e58f8c9"): already connected to this phone, or nearby. */
export async function findNode(node: string, ms = 15000): Promise<Device | null> {
  const held = (await ble().connectedDevices([SERVICE]).catch(() => [] as Device[])).find((d) => nameMatches(d.name || d.localName, node));
  if (held) return held;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ble().stopDeviceScan();
      resolve(null);
    }, ms);
    ble().startDeviceScan(null, null, (error, d) => {
      if (error) {
        clearTimeout(timer);
        ble().stopDeviceScan();
        resolve(null);
        return;
      }
      if (d && nameMatches(d.name || d.localName, node)) {
        clearTimeout(timer);
        ble().stopDeviceScan();
        resolve(d);
      }
    });
  });
}

export type NodeSnapshot = {
  myNode: number;
  /** The nodes it knows: name, and position if it has one (its own included). */
  nodes: Map<number, { longName: string | null; shortName: string | null; lat: number | null; lng: number | null; time: number | null; battery: number | null }>;
  /** Its settings, by Config field (F.config): each the sub-message's fields. */
  config: Map<number, PbField[]>;
  module: Map<number, PbField[]>;
  channels: { index: number; role: number; settings: PbField[] }[];
};

export const nodeId = (num: number) => `!${(num >>> 0).toString(16).padStart(8, '0')}`;

/** A Bluetooth session with one node. */
export class MeshNode {
  private constructor(private device: Device) {}

  static async open(device: Device): Promise<MeshNode> {
    let d = (await device.isConnected().catch(() => false)) ? device : await device.connect({ timeout: 15_000 });
    if (Platform.OS === 'android') d = await d.requestMTU(512).catch(() => d);
    d = await d.discoverAllServicesAndCharacteristics();
    return new MeshNode(d);
  }

  private async write(toRadio: PbField[]) {
    await this.device.writeCharacteristicWithResponseForService(SERVICE, TO_RADIO, toB64(encode(toRadio)));
  }

  private async read(): Promise<Uint8Array | null> {
    const c = await this.device.readCharacteristicForService(SERVICE, FROM_RADIO);
    if (!c.value) return null;
    const b = fromB64(c.value);
    return b.length ? b : null;
  }

  /** Everything it knows and its settings (a few seconds). */
  async download(timeoutMs = 20_000): Promise<NodeSnapshot> {
    const want = (Math.random() * 0xfffffff0 + 1) >>> 0;
    await this.write([u(3, want)]); // want_config_id
    const snap: NodeSnapshot = { myNode: 0, nodes: new Map(), config: new Map(), module: new Map(), channels: [] };
    const end = Date.now() + timeoutMs;
    let empty = 0;
    while (Date.now() < end) {
      const b = await this.read();
      if (!b) {
        // Between pieces the node may not have the next one ready yet.
        if (++empty > 20) break;
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      empty = 0;
      const f = decode(b);
      const my = sub(f, F.fromRadio.myInfo);
      if (my) snap.myNode = num(my, 1) ?? 0;
      const ni = sub(f, F.fromRadio.nodeInfo);
      if (ni) {
        const user = sub(ni, 2) ?? [];
        const pos = sub(ni, 3);
        const lat = pos ? sfixed32(pos, 1) : null;
        const lng = pos ? sfixed32(pos, 2) : null;
        const metrics = sub(ni, 6);
        snap.nodes.set(num(ni, 1) ?? 0, {
          longName: text(user, F.user.longName),
          shortName: text(user, F.user.shortName),
          lat: lat != null && (lat || lng) ? lat / 1e7 : null,
          lng: lng != null && (lat || lng) ? lng / 1e7 : null,
          time: pos ? num(pos, 4) : null,
          battery: metrics ? num(metrics, 1) : null,
        });
      }
      const cfg = sub(f, F.fromRadio.config);
      if (cfg?.[0]?.b) snap.config.set(cfg[0].n, decode(cfg[0].b));
      const mod = sub(f, F.fromRadio.moduleConfig);
      if (mod?.[0]?.b) snap.module.set(mod[0].n, decode(mod[0].b));
      const ch = sub(f, F.fromRadio.channel);
      if (ch) snap.channels.push({ index: num(ch, F.channel.index) ?? 0, role: num(ch, F.channel.role) ?? 0, settings: sub(ch, F.channel.settings) ?? [] });
      if (num(f, F.fromRadio.configComplete) === want) break;
    }
    if (!snap.myNode) throw new Error('The node didn’t send its settings. Try again, close to it.');
    this.myNode = snap.myNode;
    return snap;
  }

  myNode = 0;

  /** An admin message to the node itself (trusted: it comes from its own phone connection). */
  async admin(fields: PbField[]) {
    if (!this.myNode) throw new Error('download() first');
    const id = (Math.random() * 0xfffffffe + 1) >>> 0;
    const data = [u(1, ADMIN_APP), bytes(2, encode(fields))];
    await this.write([msg(1, [fixed32(2, this.myNode), u(3, 0), msg(4, data), fixed32(6, id), u(9, 0)])]);
    await new Promise((r) => setTimeout(r, 300)); // let it take each one in
  }

  /**
   * Change settings in one go (the node saves once, and restarts if a change
   * needs it): its name, channels, settings sections and modules.
   */
  async configure(c: {
    owner?: { longName: string; shortName: string };
    channels?: { index: number; role: number; settings: PbField[] }[];
    config?: [number, PbField[]][];
    module?: [number, PbField[]][];
  }) {
    await this.admin([u(F.admin.beginEdit, true)]);
    if (c.owner) await this.admin([msg(F.admin.setOwner, [{ n: F.user.longName, wire: 2, b: new TextEncoder().encode(c.owner.longName) }, { n: F.user.shortName, wire: 2, b: new TextEncoder().encode(c.owner.shortName) }])]);
    for (const ch of c.channels ?? []) await this.admin([msg(F.admin.setChannel, [u(F.channel.index, ch.index), msg(F.channel.settings, ch.settings), u(F.channel.role, ch.role)])]);
    for (const [n, fields] of c.config ?? []) await this.admin([msg(F.admin.setConfig, [msg(n, fields)])]);
    for (const [n, fields] of c.module ?? []) await this.admin([msg(F.admin.setModuleConfig, [msg(n, fields)])]);
    await this.admin([u(F.admin.commitEdit, true)]);
  }

  async close() {
    await this.device.cancelConnection().catch(() => {});
  }
}

/** The channel by this name, if the node has it. */
export const channelNamed = (snap: NodeSnapshot, name: string) =>
  snap.channels.find((c) => c.role !== ROLE.disabled && (text(c.settings, F.channelSettings.name) ?? '') === name) ?? null;

/** The first free channel slot (1–7), for adding one as secondary. */
export const freeChannel = (snap: NodeSnapshot) => {
  for (let i = 1; i < 8; i++) if (!snap.channels.some((c) => c.index === i && c.role !== ROLE.disabled)) return i;
  return -1;
};

/**
 * A channel link (meshtastic.org/e/#…): its channels' settings and its LoRa
 * settings (region, preset, frequency slot), as the home base's status has it.
 */
export function parseChannelLink(link: string): { channels: PbField[][]; lora: PbField[] | null } | null {
  const m = link.match(/meshtastic\.org\/e\/#([A-Za-z0-9_-]+)/);
  if (!m) return null;
  try {
    const set = decode(fromB64(m[1]));
    return { channels: all(set, 1).map((f) => decode(f.b!)), lora: sub(set, 2) };
  } catch {
    return null;
  }
}

export { first };
