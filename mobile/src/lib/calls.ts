// Voice calls on this phone: connects the call engine (lib/callEngine.ts) to
// the circles' clients, the microphone and WebRTC (lib/rtc.ts), Android's call
// audio, service and ringing (modules/hc-calls) and the call screen
// (components/CallHost.tsx). One call at a time, in any circle. See
// docs/CALLS-PLAN.md.
import { useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';
import * as Network from 'expo-network';
import { randomId, type CircleClient, type CallSignal } from '@homecircle/core';
import { VoiceCallEngine, type CallSnapshot, type EndInfo, type IceServer } from './callEngine';
import { MESH_MAX, MeshCall, type MeshSnapshot } from './meshCall';
import { FALLBACK_STUN, createPeerConnection, ensureBluetooth, ensureMicrophone, getLocalAudio, rtcAvailable } from './rtc';
import { allClients, clientForCircle, errorText } from './circle';
import { sasWords } from './callSas';
import { diag } from './diagnostics';
import {
  buzz,
  cancelIncomingCall,
  consumeLaunchAction,
  getAudioRoutes,
  onCallAction,
  onRoutesChanged,
  playEndTone,
  setAudioRoute,
  setCallAudio,
  showIncomingCall,
  showMissedCall,
  showOverLockScreen,
  startCallService,
  startRingback,
  startRinging,
  stopCallService,
  stopRingback,
  stopRinging,
  type AudioRoute,
  type LaunchAction,
  type Routes,
} from '../../modules/hc-calls/src/HcCallsModule';
import { showSheet } from './sheet';

/** What the call screen shows. */
export interface CallUi {
  snap: CallSnapshot;
  circleId: string | null;
  /** How the last call ended, for a few seconds. */
  ended: (EndInfo & { text: string }) | null;
  routes: Routes;
  /** Four words both people can compare, once the call is connected. */
  words: string[] | null;
}

const IDLE_ROUTES: Routes = { available: ['earpiece', 'speaker'], current: 'earpiece' };
let ui: CallUi = { snap: { phase: 'idle', callId: null, peerId: null, incoming: false, remoteRinging: false, muted: false, startedAt: null }, circleId: null, ended: null, routes: IDLE_ROUTES, words: null };
const subs = new Set<() => void>();
const publish = (patch: Partial<CallUi>) => {
  ui = { ...ui, ...patch };
  subs.forEach((fn) => fn());
};

/** The circle the current call is in. */
let active: CircleClient | null = null;
// A press on the incoming-call notification that arrived before the call did (a cold start).
let pendingAction: { action: LaunchAction['action']; callId: string; at: number } | null = null;
let endedTimer: ReturnType<typeof setTimeout> | null = null;
let stopNetwork: (() => void) | null = null;
let stopRoutes: (() => void) | null = null;

// The server asked for the relay only (CALLS_RELAY_ONLY), for the call being set up.
let relayOnly = false;

const iceServers = async (): Promise<IceServer[]> => {
  try {
    const cfg = await active!.callsConfig();
    relayOnly = !!cfg.relayOnly;
    return cfg.iceServers?.length ? cfg.iceServers : FALLBACK_STUN;
  } catch {
    relayOnly = false;
    return FALLBACK_STUN; // an older server, or no answer: the public ones
  }
};

const engine = new VoiceCallEngine({
  get selfId() {
    return active?.account?.memberId ?? '';
  },
  send: (to, body, opts) => active!.sendCallSignal(to, body as never, opts),
  createPeerConnection: (servers) => createPeerConnection(servers, { relayOnly }),
  getLocalAudio,
  iceServers,
  newId: () => randomId(12),
  onEnded: (info) => ended(info),
  log: (...a) => {
    if (__DEV__) console.log('[homecircle:call]', ...a);
    // How the connection went, for Diagnostics: each ICE state, and early restarts.
    if (a[0] === 'ice' || String(a[0]).startsWith('not connected')) diag('call:ice', { at: a.map(String).join(' ').slice(0, 60) });
  },
});

let lastPhase = engine.snapshot.phase;
engine.subscribe((snap) => {
  const prev = lastPhase;
  lastPhase = snap.phase;
  // The other phone is ringing now: the soft ring becomes the full one.
  if (snap.phase === 'outgoing' && prev === 'outgoing' && snap.remoteRinging && !ui.snap.remoteRinging) startRingback(true);
  publish({ snap, circleId: active?.circleId ?? ui.circleId });
  if (snap.phase === 'active' && !ui.words) {
    const fp = engine.fingerprints;
    if (fp) publish({ words: sasWords(fp.local, fp.remote) });
  }
  if (prev !== snap.phase) applyPhase(prev, snap);
});

/** What the phone does at each step of a call: ring, audio mode, the service that keeps it alive. */
function applyPhase(prev: CallSnapshot['phase'], snap: CallSnapshot) {
  const { phase } = snap;
  if (prev === 'outgoing') stopRingback();
  if (phase === 'incoming') {
    if (endedTimer) clearTimeout(endedTimer);
    publish({ ended: null });
    const name = nameOf(active, snap.peerId);
    diag('call:incoming', { circle: !!active });
    showOverLockScreen(true);
    if (AppState.currentState === 'active') startRinging();
    else showIncomingCall(snap.callId!, name, active?.circleId ?? '', snap.peerId!);
    // The notification's Answer button was pressed before the offer was opened.
    if (pendingAction && pendingAction.callId === snap.callId && Date.now() - pendingAction.at < 30_000) {
      const a = pendingAction.action;
      pendingAction = null;
      if (a === 'answer') void answerCall();
      if (a === 'decline') void declineCall();
    }
    return;
  }
  if (phase === 'outgoing') {
    if (endedTimer) clearTimeout(endedTimer);
    publish({ ended: null });
    beginAudio(snap);
    startRingback(snap.remoteRinging);
    return;
  }
  if (phase === 'connecting' && prev === 'incoming') {
    stopRinging();
    cancelIncomingCall();
    beginAudio(snap);
    return;
  }
  if (phase === 'idle') {
    stopRinging();
    cancelIncomingCall();
    stopCallService();
    setCallAudio(false);
    showOverLockScreen(false);
    stopNetwork?.();
    stopNetwork = null;
    stopRoutes?.();
    stopRoutes = null;
    publish({ routes: IDLE_ROUTES, words: null });
  }
}

/** The microphone is about to be used: call audio mode, the service that keeps it going, route changes, network changes. */
function beginAudio(snap: CallSnapshot) {
  setCallAudio(true);
  startCallService('HomeCircle call', `With ${nameOf(active, snap.peerId)}. Tap to return to the call.`);
  publish({ routes: getAudioRoutes() });
  stopRoutes?.();
  stopRoutes = onRoutesChanged((routes) => {
    publish({ routes });
    // The headset went away: back to the earpiece, not a silent route.
    if (ui.routes.current === 'bluetooth' && !routes.available.includes('bluetooth')) setAudioRoute('earpiece');
    // A Bluetooth headset connected during the call: use it.
    if (routes.available.includes('bluetooth') && routes.current !== 'bluetooth' && !ui.routes.available.includes('bluetooth')) setAudioRoute('bluetooth');
  });
  ensureBluetooth().catch(() => {});
  // Wi-Fi to mobile data (or back): ICE restarts on the new network at once.
  let last: string | null = null;
  const sub = Network.addNetworkStateListener((state) => {
    const key = `${state.type}|${state.isConnected}`;
    if (last !== null && key !== last && state.isConnected) engine.networkChanged();
    last = key;
  });
  stopNetwork?.();
  stopNetwork = () => sub.remove();
}

function ended(info: EndInfo) {
  diag('call:end', { reason: info.reason, incoming: info.incoming, sec: Math.round(info.durationMs / 1000) });
  if (info.reason === 'missed' && active) showMissedCall(nameOf(active, info.peerId));
  if (!info.incoming && !info.durationMs) {
    if (info.reason === 'busy') playEndTone('busy');
    else if (info.reason === 'declined') playEndTone('declined');
    else if (info.reason === 'failed' || info.reason === 'unreachable') playEndTone('failed');
  }
  const text = endText(info);
  // The caller leaves a line in the chat: missed (the push tells them), or how long it lasted (no push).
  if (active && !info.incoming && active.feature('directMessages') && (info.reason === 'no_answer' || info.durationMs > 0)) {
    active.logCall(info.peerId, { missed: info.reason === 'no_answer', seconds: info.durationMs / 1000 }).catch(() => {});
  }
  active = null;
  publish({ ended: { ...info, text } });
  if (endedTimer) clearTimeout(endedTimer);
  // Ending it yourself, or saying no, needs no "call ended" screen.
  const quiet = info.reason === 'missed' || info.reason === 'hangup' || (info.reason === 'declined' && info.incoming);
  endedTimer = setTimeout(() => publish({ ended: null }), quiet ? 0 : 3500);
}

export function endText(info: Pick<EndInfo, 'reason' | 'error' | 'durationMs'>): string {
  switch (info.reason) {
    case 'declined':
      return 'They can’t talk right now';
    case 'busy':
      return 'They’re on another call';
    case 'no_answer':
      return 'No answer';
    case 'failed':
      // Never connected: the two phones' networks couldn't find a path (a relay would, see docs/CALLS-NOTES.md).
      return info.durationMs > 0 ? 'The connection was lost' : 'Couldn’t connect. Try Wi-Fi on both phones.';
    case 'unreachable':
      return info.error || 'Couldn’t reach them';
    case 'no_microphone':
      return info.error || 'HomeCircle needs the microphone to make calls';
    case 'hangup':
    case 'remote_hangup':
      return 'Call ended';
    default:
      return '';
  }
}

function nameOf(client: CircleClient | null, id: string | null): string {
  if (!client || !id) return 'Someone';
  return client.members.get(id)?.name || client.account?.known[id]?.name || 'Someone';
}

// --- what the app does --------------------------------------------------------

const attached = new WeakSet<CircleClient>();

/** Listen for call signals in this circle. Safe to call again. */
export function attachCalls(client: CircleClient) {
  if (attached.has(client)) return;
  attached.add(client);
  client.on('callSignal', (s: CallSignal) => onSignal(client, s));
}

function onSignal(client: CircleClient, s: CallSignal) {
  // For the group call.
  if (String(s.op).startsWith('m-')) {
    if (client === meshClient) void mesh.handleSignal(s as never);
    return;
  }
  if (s.op === 'offer' && mesh.snapshot.phase !== 'idle') {
    client.sendCallSignal(s.from, { callId: s.callId, op: 'busy' }).catch(() => {});
    return;
  }
  const busy = engine.snapshot.phase !== 'idle';
  if (busy && active !== client) {
    // On a call in another circle: the other phone is told, nothing else happens.
    if (s.op === 'offer') client.sendCallSignal(s.from, { callId: s.callId, op: 'busy' }).catch(() => {});
    return;
  }
  if (!busy) {
    if (s.op !== 'offer') return;
    if (!rtcAvailable()) {
      client.sendCallSignal(s.from, { callId: s.callId, op: 'decline', reason: 'unsupported' }).catch(() => {});
      return;
    }
    active = client;
  }
  void engine.handleSignal(s as never);
}

/** Whether you can call this person from the person sheet: calls on, a real person (elders too: their phone rings with a screen made for them). */
export function canCall(client: CircleClient, memberId: string): boolean {
  if (Platform.OS !== 'android') return false; // iOS needs CallKit first (docs/CALLS-PLAN.md)
  const m = client.members.get(memberId);
  if (!client.feature('calls') || !m || m.isMe || m.removed || m.kind === 'agent') return false;
  return !!client.account?.known[memberId];
}

/** Call a person. Throws a readable message if it can't start. */
export async function startCall(client: CircleClient, peerId: string): Promise<void> {
  buzz();
  if (!rtcAvailable()) throw new Error('Calls need the latest version of the app.');
  const snap = engine.snapshot;
  // Calling the person who is calling you: that is answering.
  if (snap.phase === 'incoming' && snap.peerId === peerId && active === client) return answerCall();
  if (snap.phase !== 'idle' || mesh.snapshot.phase !== 'idle') throw new Error('You’re already on a call.');
  // The microphone first: the service that keeps a call going (started as the
  // call begins) is a microphone service, and Android stops the app if it
  // starts without the permission.
  await ensureMicrophone();
  attachCalls(client);
  active = client;
  publish({ circleId: client.circleId });
  diag('call:start', {});
  // A call that can't start ends with its reason on the call screen (see ended()).
  await engine.start(peerId).catch(() => {});
}

/**
 * Android lets an app use the microphone only while it's on screen. Answered
 * from the notification or the lock screen, the app may still be coming
 * forward (or waiting for the PIN): wait for that, up to 20 s.
 */
function whenOnScreen(maxMs = 20_000): Promise<void> {
  if (AppState.currentState === 'active') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      sub.remove();
      clearTimeout(timer);
      resolve();
    };
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') done();
    });
    const timer = setTimeout(done, maxMs);
  });
}

export async function answerCall() {
  await whenOnScreen();
  diag('call:answer', { onScreen: AppState.currentState === 'active' });
  // As for calling: the microphone before the call (and its service) starts.
  try {
    await ensureMicrophone();
  } catch (e) {
    await engine.decline();
    showSheet('Couldn’t answer', errorText(e));
    return;
  }
  await engine.accept();
}
export async function declineCall() {
  await engine.decline();
}
export async function hangUp() {
  await engine.hangup();
}
export function setMuted(muted: boolean) {
  engine.setMuted(muted);
}
export function chooseRoute(route: AudioRoute) {
  if (setAudioRoute(route)) publish({ routes: { ...getAudioRoutes(), current: route } });
}

// --- group calls -------------------------------------------------------------

/** The circle the group call is in. */
let meshClient: CircleClient | null = null;
let meshOff: (() => void) | null = null;
// On your own for this long: the call ends for you, so a phone left on a call doesn't sit there recording.
const ALONE_MS = 10 * 60_000;

const mesh = new MeshCall({
  get selfId() {
    return meshClient?.account?.memberId ?? '';
  },
  send: (to, body) => meshClient!.sendCallSignal(to, body as never),
  createPeerConnection: (ice) => createPeerConnection(ice, { relayOnly }),
  getLocalAudio,
  iceServers: async () => {
    try {
      const cfg = await meshClient!.callsConfig();
      relayOnly = !!cfg.relayOnly;
      return cfg.iceServers?.length ? cfg.iceServers : FALLBACK_STUN;
    } catch {
      relayOnly = false;
      return FALLBACK_STUN;
    }
  },
  log: (...a) => diag('mesh', { what: a.join(' ').slice(0, 120) }),
});

type MeshUi = { snap: MeshSnapshot; circleId: string | null; route: AudioRoute };
let meshUi: MeshUi = { snap: mesh.snapshot, circleId: null, route: 'speaker' };
const meshSubs = new Set<() => void>();
const publishMesh = (patch: Partial<MeshUi>) => {
  meshUi = { ...meshUi, ...patch };
  meshSubs.forEach((fn) => fn());
};
mesh.subscribe((snap) => publishMesh({ snap }));

/** What the group call screen shows. */
export const useMesh = () =>
  useSyncExternalStore(
    (fn) => {
      meshSubs.add(fn);
      return () => meshSubs.delete(fn);
    },
    () => meshUi,
  );

/** Whether this phone can be on a group call in HomeCircle in this circle. */
export function meshAvailable(client: CircleClient): boolean {
  return Platform.OS === 'android' && client.feature('calls') && rtcAvailable();
}

/** Who's talking, from each connection's audio level. */
async function readSpeaking() {
  const talking = new Set<string>();
  await Promise.all(
    mesh.connections.map(async ({ id, pc }) => {
      const report: any = await (pc as any).getStats?.().catch(() => null);
      report?.forEach?.((r: any) => {
        if (r.type === 'inbound-rtp' && r.kind !== 'video' && (r.audioLevel ?? 0) > 0.03) talking.add(id);
      });
    }),
  );
  mesh.setSpeaking(talking);
}

function endMeshAudio() {
  meshOff?.();
  meshOff = null;
  stopCallService();
  setCallAudio(false);
  showOverLockScreen(false);
  meshClient = null;
  publishMesh({ circleId: null });
}

/** Join the group call (or start one: `callId` null). Throws a readable message if it can't. */
export async function joinMesh(client: CircleClient, callId: string | null): Promise<void> {
  if (mesh.snapshot.phase !== 'idle') {
    if (client === meshClient) return; // already on it: the screen is showing
    throw new Error('You’re already on a call.');
  }
  if (engine.snapshot.phase !== 'idle') throw new Error('You’re already on a call.');
  const on = callId ? client.groupCallState(callId) : client.activeGroupCall();
  if (on && on.present.length >= MESH_MAX) throw new Error(`This call is full: ${MESH_MAX} people at most.`);
  buzz();
  await whenOnScreen();
  await ensureMicrophone();
  attachCalls(client);
  const id = on?.id ?? (await client.startMeshCall());
  const me = client.account?.memberId;
  const others = (client.groupCallState(id)?.present ?? []).filter((x) => x !== me);
  meshClient = client;
  publishMesh({ circleId: client.circleId, route: 'speaker' });
  setCallAudio(true);
  startCallService('HomeCircle group call', `${client.circle.name}. Tap to return to the call.`);
  setAudioRoute('speaker');
  showOverLockScreen(true);
  ensureBluetooth().catch(() => {});

  // Who comes and goes, from the chat. Network changes find new paths.
  const offMessages = client.on('newMessage', (m) => {
    const g = m.body?.groupCall;
    if (g?.of !== id || m.from === me) return;
    if (g.state === 'join') mesh.peerJoined(m.from);
    if (g.state === 'leave') mesh.peerLeft(m.from);
  });
  let lastNet: string | null = null;
  const net = Network.addNetworkStateListener((state) => {
    const key = `${state.type}|${state.isConnected}`;
    if (lastNet !== null && key !== lastNet && state.isConnected) mesh.networkChanged();
    lastNet = key;
  });
  const talk = setInterval(() => void readSpeaking(), 800);
  let alone: ReturnType<typeof setTimeout> | null = null;
  const offAlone = mesh.subscribe((s) => {
    if (s.phase === 'idle') return;
    if (s.peers.length) {
      if (alone) clearTimeout(alone);
      alone = null;
    } else alone ??= setTimeout(() => void leaveMesh(), ALONE_MS);
  });
  meshOff = () => {
    offMessages();
    net.remove();
    clearInterval(talk);
    offAlone();
    if (alone) clearTimeout(alone);
  };
  try {
    await client.joinGroupCall(id);
    await mesh.join(id, others);
    diag('mesh:join', { others: others.length });
  } catch (e) {
    mesh.leave({ notify: false });
    client.leaveGroupCall(id).catch(() => {});
    endMeshAudio();
    throw e;
  }
}

/** Leave the group call. It goes on for everyone else. */
export async function leaveMesh() {
  const client = meshClient;
  const id = mesh.snapshot.callId;
  mesh.leave();
  endMeshAudio();
  if (client && id) await client.leaveGroupCall(id).catch(() => {});
}
export const setMeshMuted = (muted: boolean) => mesh.setMuted(muted);
export function chooseGroupRoute(route: AudioRoute) {
  if (setAudioRoute(route)) publishMesh({ route });
}

/** Handle the answer / decline button of the incoming-call notification. */
export function handleLaunchAction(a: LaunchAction | null) {
  if (!a || (a.action !== 'answer' && a.action !== 'decline')) return;
  const snap = engine.snapshot;
  if (snap.phase === 'incoming' && (!a.callId || a.callId === snap.callId)) {
    if (a.action === 'answer') void answerCall();
    else void declineCall();
  } else if (snap.phase === 'idle') {
    // The phone is still opening: the call arrives in a moment.
    pendingAction = { action: a.action, callId: a.callId, at: Date.now() };
  }
}

/**
 * The app opened or came forward: pick up a button pressed on the incoming
 * call notification, and collect any call that waited for this phone while it
 * was asleep. Returns what to undo.
 */
export function startCallHost(): () => void {
  pickUpCalls();
  return onCallAction((a) => handleLaunchAction(a));
}

/** Listen in every circle, handle a notification button pressed while the app was closed, collect what waited. */
export function pickUpCalls() {
  for (const c of allClients()) attachCalls(c);
  handleLaunchAction(consumeLaunchAction());
  collectWaiting().catch(() => {});
}

async function collectWaiting() {
  for (const c of allClients()) if (c.account && c.feature('calls')) await c.collectCallSignals().catch(() => 0);
}

/**
 * A call push woke the app (in the background, maybe a cold start): fetch the
 * sealed signals that waited, which makes the engine ring.
 */
export async function handleCallPush(clients: CircleClient[]) {
  for (const c of clients) attachCalls(c);
  diag('call:push', {});
  await Promise.all(clients.filter((c) => c.account).map((c) => c.collectCallSignals().catch(() => 0)));
}

export function circleOf(ui0: CallUi): CircleClient | undefined {
  return clientForCircle(ui0.circleId);
}

// --- for the call screen ----------------------------------------------------------

export function useCall(): CallUi {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => ui,
  );
}
