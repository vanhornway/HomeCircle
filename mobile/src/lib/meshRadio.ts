// Sending a sealed HomeCircle message through your Meshtastic tracker over
// Bluetooth, for when the phone has no internet (or you ask for it). The
// tracker puts it on the mesh as a data packet (PRIVATE_APP, so other
// trackers don't beep); the circle's home base hands it to the server.
//
// Meshtastic's Bluetooth API: one service with a ToRadio characteristic that
// takes a ToRadio protobuf. We write one ToRadio { packet: MeshPacket { to:
// broadcast, channel: 0 (the tracker's primary, the HomeCircle channel),
// decoded: Data { portnum: PRIVATE_APP, payload } } } and let go. A tracker
// takes one Bluetooth connection at a time, so the Meshtastic app mustn't be
// connected to it right then; the first time, Android asks to pair (the
// tracker's PIN, 123456 on a T1000-E unless it was changed).
import { PermissionsAndroid, Platform } from 'react-native';
import { BleManager, type Device } from 'react-native-ble-plx';
import { toRadio } from './meshtasticProto';

const SERVICE = '6ba1b218-15a8-461f-9fa8-5dcae273eafd';
const TO_RADIO = 'f75c76d2-129e-4dad-a1dd-7866124401e7';

let manager: BleManager | null = null;
const ble = () => (manager ??= new BleManager());

function base64(bytes: Uint8Array): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += abc[n >> 18] + abc[(n >> 12) & 63] + (i + 1 < bytes.length ? abc[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? abc[n & 63] : '=');
  }
  return out;
}

// --- Bluetooth ------------------------------------------------------------------------

async function permitted(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  if (Platform.Version >= 31) {
    const r = await PermissionsAndroid.requestMultiple([PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]);
    return Object.values(r).every((v) => v === PermissionsAndroid.RESULTS.GRANTED);
  }
  const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
  return r === PermissionsAndroid.RESULTS.GRANTED;
}

/** A tracker's Bluetooth name ends with the last 4 hex digits of its node id: "UT2_f8c9". */
const matches = (d: Device, node: string) => {
  const tail = `_${node.slice(-4).toLowerCase()}`;
  return [d.name, d.localName].some((n) => !!n && n.toLowerCase().endsWith(tail));
};

function findTracker(node: string, timeoutMs: number): Promise<Device> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ble().stopDeviceScan();
      reject(new MeshRadioError('not-found'));
    }, timeoutMs);
    ble().startDeviceScan([SERVICE], null, (error, device) => {
      if (error) {
        clearTimeout(timer);
        ble().stopDeviceScan();
        reject(new MeshRadioError(error.errorCode === 102 || /powered off/i.test(error.message) ? 'bluetooth-off' : 'failed', error.message));
        return;
      }
      if (device && matches(device, node)) {
        clearTimeout(timer);
        ble().stopDeviceScan();
        resolve(device);
      }
    });
  });
}

export type MeshRadioProblem = 'no-permission' | 'bluetooth-off' | 'not-found' | 'failed';

export class MeshRadioError extends Error {
  constructor(
    readonly problem: MeshRadioProblem,
    detail?: string,
  ) {
    super(detail ?? problem);
  }
}

/** What to tell the person when sending through the tracker didn't work. */
export function meshRadioText(e: unknown, trackerName: string): string {
  const p = e instanceof MeshRadioError ? e.problem : 'failed';
  if (p === 'no-permission') return 'HomeCircle needs Nearby devices (Bluetooth) to send through your tracker. Turn it on in the phone’s Settings.';
  if (p === 'bluetooth-off') return 'Bluetooth is off. Turn it on to send through your tracker.';
  if (p === 'not-found') return `${trackerName} isn’t in Bluetooth range, or the Meshtastic app is connected to it. Bring it close, or disconnect it in the Meshtastic app.`;
  return `Couldn’t send through ${trackerName}. Try again, close to it.`;
}

/**
 * Send one sealed message (a HomeCircle mesh packet) through the tracker with
 * this node id ("!9e58f8c9"). Resolves once the tracker has taken it.
 */
export async function sendThroughTracker(node: string, packet: Uint8Array, homeBase: string | null = null): Promise<void> {
  if (!(await permitted())) throw new MeshRadioError('no-permission');
  const state = await ble().state();
  if (state === 'PoweredOff') throw new MeshRadioError('bluetooth-off');
  const found = await findTracker(node, 15_000);
  let device: Device | null = null;
  try {
    device = await found.connect({ timeout: 15_000 });
    if (Platform.OS === 'android') await device.requestMTU(512).catch(() => device!);
    device = await device.discoverAllServicesAndCharacteristics();
    // To the home base, acknowledged, when we know its node id; otherwise to everyone on the channel.
    const to = homeBase ? parseInt(homeBase.slice(1), 16) >>> 0 : undefined;
    await device.writeCharacteristicWithResponseForService(SERVICE, TO_RADIO, base64(toRadio(packet, to ? { to, wantAck: true } : {})));
  } catch (e) {
    throw e instanceof MeshRadioError ? e : new MeshRadioError('failed', e instanceof Error ? e.message : String(e));
  } finally {
    await (device ?? found).cancelConnection().catch(() => {});
  }
}
