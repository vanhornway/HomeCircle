// The logic of a one-to-one voice call, with no React Native in it: the peer
// connection, the microphone, the signal sender and the clock are all handed
// in, so it is tested with plain Node (callEngine.test.ts). lib/calls.ts
// connects it to the real things. See docs/CALLS-PLAN.md.
import { fingerprintsOf, tuneOpusSdp } from './callSdp.ts';

// --- what the engine needs from the outside ----------------------------------

export interface Sdp {
  type: 'offer' | 'answer' | 'rollback' | 'pranswer';
  sdp?: string;
}
export interface IceCandidateInit {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}
export interface TrackLike {
  enabled: boolean;
  stop(): void;
}
export interface LocalAudio {
  tracks: TrackLike[];
  /** Passed to addTrack as the stream the tracks belong to. */
  stream: unknown;
}
/** The part of RTCPeerConnection the engine uses. */
export interface PeerConnectionLike {
  signalingState: string;
  iceConnectionState: string;
  createOffer(options?: { iceRestart?: boolean; offerToReceiveAudio?: boolean }): Promise<Sdp>;
  createAnswer(): Promise<Sdp>;
  setLocalDescription(d: Sdp): Promise<void>;
  setRemoteDescription(d: Sdp): Promise<void>;
  addIceCandidate(c: IceCandidateInit): Promise<void>;
  addTrack(track: TrackLike, stream: unknown): unknown;
  close(): void;
  onicecandidate: ((e: { candidate: { toJSON(): IceCandidateInit } | IceCandidateInit | null }) => void) | null;
  oniceconnectionstatechange: (() => void) | null;
}
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** What goes inside a sealed call signal (the core adds the sender and time). */
export interface SignalBody {
  callId: string;
  op: 'offer' | 'answer' | 'ice' | 'ringing' | 'hangup' | 'busy' | 'decline';
  sdp?: string;
  restart?: boolean;
  cands?: IceCandidateInit[];
  reason?: string;
}
/** A signal received from a member (CircleClient's 'callSignal'). */
export type IncomingSignal = SignalBody & { from: string };

export interface EngineDeps {
  /** This member's id (the lower id keeps its offer when both call at once). */
  selfId: string;
  send(to: string, body: SignalBody, opts?: { ring?: boolean }): Promise<unknown>;
  createPeerConnection(iceServers: IceServer[]): PeerConnectionLike;
  getLocalAudio(): Promise<LocalAudio>;
  /** Servers to find a path with; the engine falls back to none if this fails. */
  iceServers?(): Promise<IceServer[]>;
  newId(): string;
  onEnded?(info: EndInfo): void;
  log?(...a: unknown[]): void;
  timing?: Partial<Timing>;
}

export interface Timing {
  /** The caller gives up when nobody answers. */
  ringMs: number;
  /** After an answer: connected within this, or the call failed. */
  connectMs: number;
  /** "Disconnected" this long, then restart ICE. */
  disconnectedGraceMs: number;
  /** Total time to get a dropped call back before ending it. */
  reconnectMs: number;
  /** Between attempts to send a restart offer that didn't go out. */
  retryMs: number;
  /** Local candidates are sent together, this long after the first. */
  candidateBatchMs: number;
  /** The microphone has this long to start, or the call ends (it never hangs). */
  micMs: number;
  /**
   * An answered call not yet connected after this long sends a restart
   * offer: fresh candidates both ways, now that both phones are awake.
   * Candidates sent while the answering phone was asleep (its connection
   * dead, the server not knowing yet) are otherwise lost.
   */
  earlyRestartMs: number;
}
export const DEFAULT_TIMING: Timing = { ringMs: 45_000, connectMs: 30_000, disconnectedGraceMs: 5_000, reconnectMs: 45_000, retryMs: 3_000, candidateBatchMs: 100, micMs: 10_000, earlyRestartMs: 6_000 };
/** Early restarts per call, before the connect deadline ends it. */
const EARLY_RESTARTS = 3;

// --- state -----------------------------------------------------------------

export type CallPhase = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'active' | 'reconnecting';
export type EndReason =
  | 'hangup' // this phone ended it
  | 'remote_hangup'
  | 'declined' // the other person said no
  | 'busy' // the other person is in a call
  | 'no_answer'
  | 'missed' // it rang here and nobody answered
  | 'failed' // couldn't connect, or the connection was lost
  | 'unreachable' // the server wouldn't take the call
  | 'no_microphone';

export interface EndInfo {
  reason: EndReason;
  callId: string;
  peerId: string;
  /** Who started it. */
  incoming: boolean;
  /** How long it was connected, 0 if it never was. */
  durationMs: number;
  error?: string;
}

export interface CallSnapshot {
  phase: CallPhase;
  callId: string | null;
  peerId: string | null;
  incoming: boolean;
  /** Outgoing: the other phone has told us it is ringing. */
  remoteRinging: boolean;
  muted: boolean;
  /** When the call connected (ms since epoch), for the timer. */
  startedAt: number | null;
}

const IDLE: CallSnapshot = { phase: 'idle', callId: null, peerId: null, incoming: false, remoteRinging: false, muted: false, startedAt: null };

type Timer = ReturnType<typeof setTimeout>;

export class VoiceCallEngine {
  private deps: EngineDeps;
  private timing: Timing;
  private snap: CallSnapshot = IDLE;
  private subs = new Set<(s: CallSnapshot) => void>();
  // Signals are handled one at a time, in the order they arrived.
  private queue: Promise<unknown> = Promise.resolve();

  private pc: PeerConnectionLike | null = null;
  private audio: LocalAudio | null = null;
  private remoteSet = false;
  private pendingRemote: IceCandidateInit[] = [];
  private pendingOffer: string | null = null;
  private localReady = false;
  private localBatch: IceCandidateInit[] = [];
  // Every local candidate sent for this connection, to send again once the
  // other phone has answered (and is surely listening).
  private localSent: IceCandidateInit[] = [];
  // Remote candidates already taken for this call.
  private remoteSeen = new Set<string>();
  private batchTimer: Timer | null = null;
  private ringTimer: Timer | null = null;
  private connectTimer: Timer | null = null;
  private disconnectTimer: Timer | null = null;
  private reconnectTimer: Timer | null = null;
  private retryTimer: Timer | null = null;
  private earlyTimer: Timer | null = null;
  private earlyRestarts = 0;
  private restarting = false;
  private everConnected = false;
  // The DTLS fingerprints each side offered for this call (for the four words).
  private localFp: string[] = [];
  private remoteFp: string[] = [];

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
  }

  get snapshot(): CallSnapshot {
    return this.snap;
  }

  subscribe(fn: (s: CallSnapshot) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  // --- what the person does -------------------------------------------------

  /** Call a member. Rejects (and the call is over) if the microphone or the server says no. */
  async start(peerId: string): Promise<string> {
    if (this.snap.phase !== 'idle') throw new Error('Already in a call');
    const callId = this.deps.newId();
    this.set({ ...IDLE, phase: 'outgoing', callId, peerId, incoming: false });
    try {
      if (!(await this.ensureAudio(callId))) return callId; // hung up while the microphone was starting
      const pc = await this.newPeerConnection(callId);
      if (!pc) return callId;
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      offer.sdp = tuneOpusSdp(offer.sdp ?? '');
      await pc.setLocalDescription(offer);
      this.localFp = fingerprintsOf(offer.sdp ?? '');
      this.armRing(callId, 'no_answer');
      await this.deps.send(peerId, { callId, op: 'offer', sdp: offer.sdp }, { ring: true });
      this.localReady = true;
      this.flushCandidates();
    } catch (e) {
      if (this.snap.callId === callId) this.finish(this.failure(e), { error: errorText(e), notify: false });
      throw e;
    }
    return callId;
  }

  /** Answer the call that is ringing. */
  async accept(): Promise<void> {
    const { phase, callId, peerId } = this.snap;
    if (phase !== 'incoming' || !callId || !peerId || this.pendingOffer == null) return;
    this.set({ phase: 'connecting' });
    this.clearTimer('ringTimer');
    // From the moment it's answered: connected within connectMs, or over.
    this.armConnect(callId);
    await this.answerPending(callId);
  }

  /** Open the microphone, build the connection and answer the offer held for this call. */
  private async answerPending(callId: string) {
    try {
      if (!(await this.ensureAudio(callId))) return;
      const pc = await this.newPeerConnection(callId);
      if (!pc || this.pendingOffer == null) return;
      await this.answerOffer(pc, this.pendingOffer);
      this.pendingOffer = null;
      this.armConnect(callId);
      this.earlyRestarts = 0;
      this.armEarlyRestart(callId);
    } catch (e) {
      if (this.snap.callId === callId) this.finish(this.failure(e), { error: errorText(e), notify: true, op: 'decline' });
    }
  }

  /** Say no to the call that is ringing. */
  async decline(): Promise<void> {
    if (this.snap.phase !== 'incoming') return;
    this.finish('declined', { notify: true, op: 'decline' });
  }

  /** End the call (or cancel one that hasn't been answered). */
  async hangup(): Promise<void> {
    if (this.snap.phase === 'idle') return;
    if (this.snap.phase === 'incoming') return this.decline();
    this.finish('hangup', { notify: true, op: 'hangup' });
  }

  /** The two sides' DTLS fingerprints once both are known (for the four words), else null. */
  get fingerprints(): { local: string[]; remote: string[] } | null {
    return this.localFp.length && this.remoteFp.length ? { local: this.localFp, remote: this.remoteFp } : null;
  }

  /** Mute by switching the microphone track off. It is never stopped: the connection keeps sending. */
  setMuted(muted: boolean) {
    for (const t of this.audio?.tracks ?? []) t.enabled = !muted;
    this.set({ muted });
  }

  /** The phone changed network (Wi-Fi to mobile data): find a new path now. */
  networkChanged() {
    if (this.snap.phase === 'active' || this.snap.phase === 'reconnecting') this.restartIce();
  }

  // --- what arrives -----------------------------------------------------------

  /** A call signal from a member. Handled in order, one at a time; never rejects. */
  handleSignal(sig: IncomingSignal): Promise<void> {
    this.queue = this.queue.then(() => this.onSignal(sig)).catch((e) => this.deps.log?.('call signal failed', sig.op, errorText(e)));
    return this.queue as Promise<void>;
  }

  private async onSignal(sig: IncomingSignal) {
    const { phase, callId, peerId } = this.snap;
    if (sig.op === 'offer') return this.onOffer(sig);
    // Everything else belongs to the call going on, with the person in it.
    if (phase === 'idle' || sig.callId !== callId || sig.from !== peerId) return;
    switch (sig.op) {
      case 'ringing':
        if (phase === 'outgoing') this.set({ remoteRinging: true });
        break;
      case 'answer':
        if (!this.pc || sig.sdp == null) return;
        if (this.pc.signalingState !== 'have-local-offer') return;
        await this.pc.setRemoteDescription({ type: 'answer', sdp: sig.sdp });
        if (!this.remoteFp.length) this.remoteFp = fingerprintsOf(sig.sdp);
        this.remoteSet = true;
        await this.drainRemote();
        if (phase === 'outgoing') {
          this.clearTimer('ringTimer');
          this.set({ phase: 'connecting', remoteRinging: false });
          this.armConnect(callId!);
          // Candidates sent while their phone was asleep may never have
          // reached it (a dead connection the server still trusted): again.
          if (this.localSent.length) this.deps.send(peerId!, { callId: callId!, op: 'ice', cands: [...this.localSent] }).catch(() => {});
        }
        this.restarting = false;
        this.healIfConnected();
        break;
      case 'ice':
        for (const c of sig.cands ?? []) await this.addRemote(c);
        break;
      case 'hangup':
        this.finish(phase === 'incoming' ? 'missed' : 'remote_hangup', { notify: false });
        break;
      case 'decline':
        this.finish('declined', { notify: false });
        break;
      case 'busy':
        this.finish('busy', { notify: false });
        break;
    }
  }

  private async onOffer(sig: IncomingSignal) {
    const { phase, callId, peerId } = this.snap;
    const sdp = sig.sdp;
    if (sdp == null) return;
    // A new offer for the call we are in: the other side restarting ICE.
    if (phase !== 'idle' && sig.callId === callId && sig.from === peerId) {
      if (phase === 'active' || phase === 'reconnecting' || phase === 'connecting') return this.onRestartOffer(sdp);
      return;
    }
    // Both called at once: the lower member id keeps its offer, the higher
    // one drops its own and answers (no ringing; both wanted to talk).
    if (phase === 'outgoing' && sig.from === peerId) {
      if (this.deps.selfId < sig.from) return; // ours stands; their phone will answer it
      this.dropOutgoingForGlare();
      this.set({ ...IDLE, phase: 'connecting', callId: sig.callId, peerId: sig.from, incoming: true });
      this.pendingOffer = sdp;
      this.pendingRemote = [];
      this.remoteSeen.clear();
      await this.answerPending(sig.callId);
      return;
    }
    // In a call already, or calling someone else.
    if (phase !== 'idle') {
      await this.deps.send(sig.from, { callId: sig.callId, op: 'busy' }).catch(() => {});
      return;
    }
    this.set({ ...IDLE, phase: 'incoming', callId: sig.callId, peerId: sig.from, incoming: true });
    this.pendingOffer = sdp;
    this.pendingRemote = [];
    this.remoteSeen.clear();
    this.armRing(sig.callId, 'missed');
    this.deps.send(sig.from, { callId: sig.callId, op: 'ringing' }).catch(() => {});
  }

  /** The other side restarted ICE (their network changed): answer with a new answer. */
  private async onRestartOffer(sdp: string) {
    const pc = this.pc;
    if (!pc) return;
    // Both restarted at once: the lower member id keeps its offer (it is the
    // "impolite" side), the other rolls its own back and answers.
    if (pc.signalingState === 'have-local-offer') {
      if (this.deps.selfId < (this.snap.peerId ?? '')) return;
      await pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
    }
    this.restarting = false;
    await this.answerOffer(pc, sdp);
    this.healIfConnected();
  }

  /**
   * After a restart both sides agreed on: if the path is up (a network change
   * can leave ICE "connected" throughout, so no event says so), the call is back.
   */
  private healIfConnected() {
    const state = this.pc?.iceConnectionState;
    if (this.snap.phase !== 'reconnecting' || (state !== 'connected' && state !== 'completed')) return;
    for (const n of ['disconnectTimer', 'reconnectTimer', 'retryTimer'] as const) this.clearTimer(n);
    this.set({ phase: 'active' });
  }

  private async answerOffer(pc: PeerConnectionLike, offerSdp: string) {
    const peerId = this.snap.peerId!;
    const callId = this.snap.callId!;
    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    if (!this.remoteFp.length) this.remoteFp = fingerprintsOf(offerSdp);
    this.remoteSet = true;
    await this.drainRemote();
    const answer = await pc.createAnswer();
    answer.sdp = tuneOpusSdp(answer.sdp ?? '');
    await pc.setLocalDescription(answer);
    if (!this.localFp.length) this.localFp = fingerprintsOf(answer.sdp ?? '');
    await this.deps.send(peerId, { callId, op: 'answer', sdp: answer.sdp });
    this.localReady = true;
    this.flushCandidates();
  }

  // --- the connection ----------------------------------------------------------

  /**
   * The microphone for this call (kept if one is already open, as after a
   * glare). False if the call ended while it was starting; the stream is
   * then released.
   */
  private async ensureAudio(callId: string): Promise<boolean> {
    if (this.audio) return true;
    let a: LocalAudio;
    try {
      a = await withTimeout(this.deps.getLocalAudio(), this.timing.micMs, 'The microphone didn’t start. Open HomeCircle and try again.');
    } catch (e) {
      const err = new Error(errorText(e)) as Error & { micDenied?: boolean };
      err.micDenied = true;
      throw err;
    }
    if (this.snap.callId !== callId) {
      for (const t of a.tracks) t.stop();
      return false;
    }
    if (this.snap.muted) for (const t of a.tracks) t.enabled = false;
    this.audio = a;
    return true;
  }

  /** The peer connection for this call, or null if the call ended while it was being made. */
  private async newPeerConnection(callId: string): Promise<PeerConnectionLike | null> {
    let servers: IceServer[] = [];
    try {
      servers = (await this.deps.iceServers?.()) ?? [];
    } catch {
      // The built-in servers are the caller's job; a call without them still works on one network.
    }
    if (this.snap.callId !== callId) return null;
    const pc = this.deps.createPeerConnection(servers);
    this.pc = pc;
    this.remoteSet = false;
    this.localReady = false;
    this.localBatch = [];
    this.localSent = [];
    for (const t of this.audio?.tracks ?? []) pc.addTrack(t, this.audio!.stream);
    pc.onicecandidate = (e) => {
      const c = e.candidate;
      if (!c) return;
      this.localBatch.push('toJSON' in c ? c.toJSON() : c);
      if (this.localReady) this.scheduleFlush();
    };
    pc.oniceconnectionstatechange = () => this.onIceState(pc);
    return pc;
  }

  private onIceState(pc: PeerConnectionLike) {
    if (pc !== this.pc) return;
    const state = pc.iceConnectionState;
    this.deps.log?.('ice', state);
    if (state === 'connected' || state === 'completed') {
      this.clearTimer('connectTimer');
      this.clearTimer('disconnectTimer');
      this.clearTimer('reconnectTimer');
      this.clearTimer('retryTimer');
      this.restarting = false;
      if (!this.everConnected) {
        this.everConnected = true;
        this.set({ phase: 'active', startedAt: Date.now() });
      } else if (this.snap.phase === 'reconnecting') this.set({ phase: 'active' });
    } else if (state === 'disconnected') {
      if (this.disconnectTimer || !this.everConnected) return;
      // A blip often heals itself; after the grace period, restart ICE.
      this.disconnectTimer = setTimeout(() => {
        this.disconnectTimer = null;
        this.restartIce();
      }, this.timing.disconnectedGraceMs);
    } else if (state === 'failed') {
      this.clearTimer('disconnectTimer');
      if (this.everConnected) this.restartIce();
      else this.finish('failed', { notify: true, op: 'hangup' });
    }
  }

  /** New offer with fresh candidates, for when the path broke (network change, a long drop). */
  private restartIce() {
    const { phase, callId, peerId } = this.snap;
    if (!this.pc || !callId || !peerId || (phase !== 'active' && phase !== 'reconnecting')) return;
    if (phase === 'active') this.set({ phase: 'reconnecting' });
    this.clearTimer('disconnectTimer');
    if (!this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.finish('failed', { notify: true, op: 'hangup' });
      }, this.timing.reconnectMs);
    }
    if (this.restarting) return;
    this.restarting = true;
    this.sendRestartOffer(this.pc, callId, peerId);
  }

  private async sendRestartOffer(pc: PeerConnectionLike, callId: string, peerId: string) {
    try {
      const offer = await pc.createOffer({ iceRestart: true });
      offer.sdp = tuneOpusSdp(offer.sdp ?? '');
      await pc.setLocalDescription(offer);
      await this.deps.send(peerId, { callId, op: 'offer', sdp: offer.sdp, restart: true });
    } catch (e) {
      this.deps.log?.('ice restart failed', errorText(e));
      if (pc !== this.pc || this.snap.phase !== 'reconnecting') return;
      // No network yet: try again until the deadline.
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.restarting = false;
        if (pc === this.pc) {
          this.rollbackThenRestart(pc);
        }
      }, this.timing.retryMs);
    }
  }

  private async rollbackThenRestart(pc: PeerConnectionLike) {
    if (pc.signalingState === 'have-local-offer') await pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
    this.restartIce();
  }

  private scheduleFlush() {
    if (this.batchTimer) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      this.flushCandidates();
    }, this.timing.candidateBatchMs);
  }

  private flushCandidates() {
    const { callId, peerId } = this.snap;
    if (!callId || !peerId || !this.localBatch.length || !this.localReady) return;
    const cands = this.localBatch;
    this.localBatch = [];
    this.localSent.push(...cands);
    // A candidate that doesn't get through is lost: a restart makes new ones.
    this.deps.send(peerId, { callId, op: 'ice', cands }).catch(() => {});
  }

  /** Candidates that arrive before the remote description is set wait here. */
  private async addRemote(c: IceCandidateInit, { seen = false } = {}) {
    // The caller sends its candidates again once answered: each one once.
    const key = `${c.sdpMid ?? ''}|${c.candidate ?? ''}`;
    if (!seen) {
      if (this.remoteSeen.has(key)) return;
      this.remoteSeen.add(key);
    }
    if (!this.pc || !this.remoteSet) {
      this.pendingRemote.push(c);
      return;
    }
    try {
      await this.pc.addIceCandidate(c);
    } catch (e) {
      this.deps.log?.('candidate refused', errorText(e));
    }
  }

  private async drainRemote() {
    const list = this.pendingRemote;
    this.pendingRemote = [];
    for (const c of list) await this.addRemote(c, { seen: true });
  }

  // --- timers and the end ------------------------------------------------------

  private armRing(callId: string, reason: 'no_answer' | 'missed') {
    this.clearTimer('ringTimer');
    this.ringTimer = setTimeout(() => {
      this.ringTimer = null;
      if (this.snap.callId !== callId) return;
      this.finish(reason, { notify: reason === 'no_answer', op: 'hangup' });
    }, this.timing.ringMs);
  }

  /** Not connected yet after earlyRestartMs: a restart offer, up to EARLY_RESTARTS times. */
  private armEarlyRestart(callId: string) {
    this.clearTimer('earlyTimer');
    this.earlyTimer = setTimeout(() => {
      this.earlyTimer = null;
      const pc = this.pc;
      const { phase, peerId } = this.snap;
      if (this.snap.callId !== callId || !pc || !peerId || this.everConnected || phase !== 'connecting') return;
      if (this.earlyRestarts >= EARLY_RESTARTS) return;
      this.earlyRestarts++;
      this.deps.log?.('not connected yet: restarting ICE', this.earlyRestarts);
      if (!this.restarting) {
        this.restarting = true;
        void this.sendRestartOffer(pc, callId, peerId).finally(() => {
          // The answer to it (or nothing) arrives later; allow the next try.
          this.restarting = false;
        });
      }
      this.armEarlyRestart(callId);
    }, this.timing.earlyRestartMs);
  }

  private armConnect(callId: string) {
    this.clearTimer('connectTimer');
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this.snap.callId === callId && !this.everConnected) this.finish('failed', { notify: true, op: 'hangup' });
    }, this.timing.connectMs);
  }

  private dropOutgoingForGlare() {
    this.clearTimers();
    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.oniceconnectionstatechange = null;
      this.pc.close();
    }
    this.pc = null;
    // The microphone stays: the call is about to be answered with it.
  }

  private failure(e: unknown): EndReason {
    if ((e as { micDenied?: boolean })?.micDenied) return 'no_microphone';
    return 'unreachable';
  }

  /** The call is over: tell the other side if asked, release everything, report once. */
  private finish(reason: EndReason, { notify, op = 'hangup', error }: { notify: boolean; op?: 'hangup' | 'decline'; error?: string }) {
    const { callId, peerId, incoming, startedAt } = this.snap;
    if (!callId || !peerId) return;
    this.clearTimers();
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = null;
    if (notify && reason !== 'unreachable') this.deps.send(peerId, { callId, op, ...(reason === 'failed' ? { reason: 'failed' } : {}) }).catch(() => {});
    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.oniceconnectionstatechange = null;
      try {
        this.pc.close();
      } catch {
        // already closed
      }
    }
    // Only now are the microphone tracks stopped: at the end of the call.
    for (const t of this.audio?.tracks ?? []) {
      try {
        t.stop();
      } catch {
        // already stopped
      }
    }
    this.pc = null;
    this.audio = null;
    this.remoteSet = false;
    this.pendingRemote = [];
    this.remoteSeen.clear();
    this.pendingOffer = null;
    this.localBatch = [];
    this.localSent = [];
    this.localReady = false;
    this.restarting = false;
    const durationMs = startedAt ? Date.now() - startedAt : 0;
    this.everConnected = false;
    this.localFp = [];
    this.remoteFp = [];
    this.set(IDLE);
    this.deps.onEnded?.({ reason, callId, peerId, incoming, durationMs, ...(error ? { error } : {}) });
  }

  private clearTimer(name: 'ringTimer' | 'connectTimer' | 'disconnectTimer' | 'reconnectTimer' | 'retryTimer' | 'earlyTimer') {
    if (this[name]) clearTimeout(this[name]!);
    this[name] = null;
  }

  private clearTimers() {
    for (const n of ['ringTimer', 'connectTimer', 'disconnectTimer', 'reconnectTimer', 'retryTimer', 'earlyTimer'] as const) this.clearTimer(n);
  }

  private set(patch: Partial<CallSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.subs) fn(this.snap);
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A promise that rejects with `message` if it hasn't settled within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([p, late]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
