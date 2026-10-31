// The real peer connection and microphone for lib/calls.ts, from
// react-native-webrtc. Loaded only when a call starts, so a build without the
// native module still opens (calls just say they're unavailable).
import { PermissionsAndroid, Platform } from 'react-native';
import { diag } from './diagnostics';
import type { IceServer, LocalAudio, PeerConnectionLike } from './callEngine';

/** Used when the server doesn't list any (older servers): public STUN. */
export const FALLBACK_STUN: IceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }];

// eslint-disable-next-line @typescript-eslint/no-require-imports
const webrtc = (): typeof import('react-native-webrtc') => require('react-native-webrtc');

/** Whether this build has WebRTC in it. */
export function rtcAvailable(): boolean {
  try {
    webrtc();
    return true;
  } catch {
    return false;
  }
}

/** Ask for the microphone (Android; iOS asks when it is first used). Throws if refused. */
export async function ensureMicrophone(): Promise<void> {
  if (Platform.OS !== 'android') return;
  if (await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO)) return;
  const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, {
    title: 'Microphone',
    message: 'HomeCircle uses the microphone only while you are on a call.',
    buttonPositive: 'Allow',
    buttonNegative: 'Not now',
  });
  if (r !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('HomeCircle needs the microphone to make calls. You can allow it in the phone’s settings.');
}

/** Bluetooth headsets need this on Android 12 and later; a refusal only means no headset. */
export async function ensureBluetooth(): Promise<boolean> {
  if (Platform.OS !== 'android' || Number(Platform.Version) < 31) return true;
  const p = PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT;
  if (await PermissionsAndroid.check(p)) return true;
  return (await PermissionsAndroid.request(p)) === PermissionsAndroid.RESULTS.GRANTED;
}

export async function getLocalAudio(): Promise<LocalAudio> {
  await ensureMicrophone();
  const { mediaDevices } = webrtc();
  const stream = await mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    video: false,
  } as never);
  return { tracks: stream.getAudioTracks() as never, stream };
}

export function createPeerConnection(iceServers: IceServer[], { relayOnly = false } = {}): PeerConnectionLike {
  const { RTCPeerConnection } = webrtc();
  const pc = new RTCPeerConnection({
    iceServers: (iceServers.length ? iceServers : FALLBACK_STUN) as never,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceCandidatePoolSize: 2,
    // Through the family's own relay only: the phones never learn each other's address.
    ...(relayOnly ? { iceTransportPolicy: 'relay' as const } : {}),
  });
  // Which kind of path the call found (direct or relayed): no addresses, only the kinds.
  let logged = false;
  pc.addEventListener('iceconnectionstatechange', () => {
    if (logged || (pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed')) return;
    logged = true;
    logPath(pc).catch(() => {});
  });
  return pc as unknown as PeerConnectionLike;
}

async function logPath(pc: InstanceType<ReturnType<typeof webrtc>['RTCPeerConnection']>) {
  const report: any = await pc.getStats();
  const byId = new Map<string, any>();
  report.forEach((r: any) => byId.set(r.id, r));
  let pair: any = null;
  report.forEach((r: any) => {
    if (r.type === 'candidate-pair' && (r.selected || (r.nominated && r.state === 'succeeded'))) pair = r;
  });
  if (!pair) return;
  diag('call:path', { local: byId.get(pair.localCandidateId)?.candidateType, remote: byId.get(pair.remoteCandidateId)?.candidateType });
}
