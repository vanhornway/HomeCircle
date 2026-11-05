// The logic of a group voice call, with no React Native in it, like
// callEngine.ts: every phone connects directly to every other phone, up to six
// people, using the same microphone for all of them. Whoever joins later calls
// those already there. lib/calls.ts connects it to the real things.
import { tuneOpusSdp } from './callSdp.ts';
import type { IceCandidateInit, IceServer, LocalAudio, PeerConnectionLike, Sdp } from './callEngine.ts';

export const MESH_MAX = 6;

export interface MeshBody {
  callId: string;
  op: 'm-offer' | 'm-answer' | 'm-ice' | 'm-bye';
  sdp?: string;
  cands?: IceCandidateInit[];
}
export type MeshSignal = MeshBody & { from: string };

export interface MeshDeps {
  /** This member's id (the lower id calls first when two phones meet at once). */
  selfId: string;
  send(to: string, body: MeshBody): Promise<unknown>;
  createPeerConnection(iceServers: IceServer[]): PeerConnectionLike;
  getLocalAudio(): Promise<LocalAudio>;
  iceServers?(): Promise<IceServer[]>;
  log?(...a: unknown[]): void;
  timing?: Partial<MeshTiming>;
}

export interface MeshTiming {
  /** A connection that drops gets this long to come back before ICE restarts. */
  graceMs: number;
  /** How long someone can stay unreachable before they're off the call here. */
  giveUpMs: number;
  batchMs: number;
  /** After hearing someone joined, how long to wait for their call before calling them. */
  meetMs: number;
}
export const MESH_TIMING: MeshTiming = { graceMs: 4_000, giveUpMs: 45_000, batchMs: 100, meetMs: 3_000 };

export type PeerState = 'connecting' | 'connected' | 'reconnecting';
export interface MeshSnapshot {
  phase: 'idle' | 'joining' | 'active';
  callId: string | null;
  peers: { id: string; state: PeerState; speaking: boolean }[];
  muted: boolean;
  startedAt: number | null;
}
const IDLE: MeshSnapshot = { phase: 'idle', callId: null, peers: [], muted: false, startedAt: null };

type Timer = ReturnType<typeof setTimeout>;
type Link = {
  id: string;
  pc: PeerConnectionLike;
  state: PeerState;
  speaking: boolean;
  /** This phone made the offer, so it's the one to restart. */
  caller: boolean;
  remoteSet: boolean;
  pending: IceCandidateInit[];
  batch: IceCandidateInit[];
  batchTimer: Timer | null;
  graceTimer: Timer | null;
  giveUpTimer: Timer | null;
};

export class MeshCall {
  private deps: MeshDeps;
  private timing: MeshTiming;
  private snap: MeshSnapshot = IDLE;
  private subs = new Set<(s: MeshSnapshot) => void>();
  private links = new Map<string, Link>();
  private audio: LocalAudio | null = null;
  private ice: IceServer[] = [];
  private meetTimers = new Map<string, Timer>();
  // Signals are handled one at a time, in the order they arrived.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: MeshDeps) {
    this.deps = deps;
    this.timing = { ...MESH_TIMING, ...deps.timing };
  }

  get snapshot() {
    return this.snap;
  }
  /** The connections, to read audio levels from. */
  get connections() {
    return [...this.links.values()].map((l) => ({ id: l.id, pc: l.pc }));
  }

  subscribe(fn: (s: MeshSnapshot) => void) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  private publish(patch: Partial<MeshSnapshot> = {}) {
    const connected = [...this.links.values()].some((l) => l.state === 'connected');
    this.snap = {
      ...this.snap,
      ...patch,
      peers: [...this.links.values()].map((l) => ({ id: l.id, state: l.state, speaking: l.speaking })),
    };
    if (connected && !this.snap.startedAt && this.snap.phase !== 'idle') this.snap = { ...this.snap, startedAt: Date.now(), phase: 'active' };
    for (const fn of this.subs) fn(this.snap);
  }

  /** Join the call: the microphone opens, then this phone calls everyone already on it. */
  async join(callId: string, others: string[]) {
    if (this.snap.phase !== 'idle') throw new Error('You’re already on a call.');
    this.snap = { ...IDLE, phase: 'joining', callId };
    this.publish();
    try {
      this.audio = await this.deps.getLocalAudio();
      this.ice = (await this.deps.iceServers?.().catch(() => [])) ?? [];
    } catch (e) {
      this.leave({ notify: false });
      throw e;
    }
    if (this.snap.callId !== callId) return; // left while the microphone was starting
    await Promise.all(others.filter((id) => id !== this.deps.selfId).slice(0, MESH_MAX - 1).map((id) => this.call(id)));
  }

  private async call(id: string) {
    const callId = this.snap.callId!;
    const link = this.open(id, true);
    const offer = await link.pc.createOffer({ offerToReceiveAudio: true });
    offer.sdp = tuneOpusSdp(offer.sdp ?? '');
    await link.pc.setLocalDescription(offer);
    await this.deps.send(id, { callId, op: 'm-offer', sdp: offer.sdp }).catch((e) => this.deps.log?.('mesh offer failed', String(e)));
  }

  private open(id: string, caller: boolean): Link {
    const pc = this.deps.createPeerConnection(this.ice);
    const link: Link = { id, pc, state: 'connecting', speaking: false, caller, remoteSet: false, pending: [], batch: [], batchTimer: null, graceTimer: null, giveUpTimer: null };
    this.links.set(id, link);
    for (const t of this.audio?.tracks ?? []) pc.addTrack(t, this.audio!.stream);
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const c = e.candidate as { toJSON?: () => IceCandidateInit };
      link.batch.push(c.toJSON ? c.toJSON() : (e.candidate as IceCandidateInit));
      link.batchTimer ??= setTimeout(() => this.flushIce(link), this.timing.batchMs);
    };
    pc.oniceconnectionstatechange = () => this.onIce(link);
    link.giveUpTimer = setTimeout(() => this.drop(id), this.timing.giveUpMs);
    this.publish();
    return link;
  }

  private flushIce(link: Link) {
    link.batchTimer = null;
    const cands = link.batch.splice(0);
    if (cands.length && this.snap.callId) this.deps.send(link.id, { callId: this.snap.callId, op: 'm-ice', cands }).catch(() => {});
  }

  private onIce(link: Link) {
    if (this.links.get(link.id) !== link) return;
    const s = link.pc.iceConnectionState;
    if (s === 'connected' || s === 'completed') {
      for (const k of ['graceTimer', 'giveUpTimer'] as const) {
        if (link[k]) clearTimeout(link[k]!);
        link[k] = null;
      }
      link.state = 'connected';
      this.publish();
    } else if (s === 'disconnected' || s === 'failed') {
      if (link.state === 'connected') link.state = 'reconnecting';
      link.giveUpTimer ??= setTimeout(() => this.drop(link.id), this.timing.giveUpMs);
      link.graceTimer ??= setTimeout(() => {
        link.graceTimer = null;
        if (this.links.get(link.id) === link && link.state !== 'connected') void this.restart(link);
      }, this.timing.graceMs);
      this.publish();
    }
  }

  /** Only the phone that called restarts, so the two don't restart over each other. */
  private async restart(link: Link) {
    if (!link.caller || link.pc.signalingState !== 'stable') return;
    try {
      const offer = await link.pc.createOffer({ iceRestart: true });
      offer.sdp = tuneOpusSdp(offer.sdp ?? '');
      await link.pc.setLocalDescription(offer);
      await this.deps.send(link.id, { callId: this.snap.callId!, op: 'm-offer', sdp: offer.sdp });
    } catch (e) {
      this.deps.log?.('mesh restart failed', String(e));
    }
  }

  /** The phone changed network: every connection this phone made looks for a new path. */
  networkChanged() {
    for (const l of this.links.values()) void this.restart(l);
  }

  private close(link: Link) {
    for (const k of ['batchTimer', 'graceTimer', 'giveUpTimer'] as const) if (link[k]) clearTimeout(link[k]!);
    link.pc.onicecandidate = null;
    link.pc.oniceconnectionstatechange = null;
    try {
      link.pc.close();
    } catch {
      // already closed
    }
  }

  private drop(id: string) {
    const link = this.links.get(id);
    if (!link) return;
    this.close(link);
    this.links.delete(id);
    this.publish();
  }

  /** The chat says someone joined. They call us; if they haven't soon, and our id is the lower one, we call them. */
  peerJoined(id: string) {
    if (this.snap.phase === 'idle' || id === this.deps.selfId || this.links.has(id) || this.meetTimers.has(id) || this.deps.selfId > id) return;
    this.meetTimers.set(
      id,
      setTimeout(() => {
        this.meetTimers.delete(id);
        if (this.snap.phase !== 'idle' && !this.links.has(id)) void this.call(id);
      }, this.timing.meetMs),
    );
  }

  /** The chat says someone left. */
  peerLeft(id: string) {
    this.drop(id);
  }

  handleSignal(sig: MeshSignal): Promise<void> {
    this.queue = this.queue.then(() => this.onSignal(sig)).catch((e) => this.deps.log?.('mesh signal failed', sig.op, String(e)));
    return this.queue as Promise<void>;
  }

  private async onSignal(sig: MeshSignal) {
    if (sig.callId !== this.snap.callId || this.snap.phase === 'idle') return;
    if (sig.op === 'm-bye') return this.drop(sig.from);
    if (sig.op === 'm-offer') return this.onOffer(sig);
    const link = this.links.get(sig.from);
    if (!link) return;
    if (sig.op === 'm-answer' && sig.sdp != null) {
      if (link.pc.signalingState !== 'have-local-offer') return;
      await link.pc.setRemoteDescription({ type: 'answer', sdp: sig.sdp });
      link.remoteSet = true;
      await this.drain(link);
    } else if (sig.op === 'm-ice') {
      link.pending.push(...(sig.cands ?? []));
      if (link.remoteSet) await this.drain(link);
    }
  }

  private async onOffer(sig: MeshSignal) {
    let link = this.links.get(sig.from);
    // Both called at once: the lower id's call stands.
    if (link?.pc.signalingState === 'have-local-offer') {
      if (this.deps.selfId < sig.from) return;
      this.close(link);
      this.links.delete(sig.from);
      link = undefined;
    }
    link ??= this.open(sig.from, false);
    await link.pc.setRemoteDescription({ type: 'offer', sdp: sig.sdp ?? '' } as Sdp);
    link.remoteSet = true;
    const answer = await link.pc.createAnswer();
    answer.sdp = tuneOpusSdp(answer.sdp ?? '');
    await link.pc.setLocalDescription(answer);
    await this.deps.send(sig.from, { callId: sig.callId, op: 'm-answer', sdp: answer.sdp });
    await this.drain(link);
  }

  private async drain(link: Link) {
    for (const c of link.pending.splice(0)) await link.pc.addIceCandidate(c).catch(() => {});
  }

  /** Mark who's talking (from the connections' audio levels). */
  setSpeaking(speaking: Set<string>) {
    let changed = false;
    for (const l of this.links.values()) {
      if (l.speaking !== speaking.has(l.id)) {
        l.speaking = speaking.has(l.id);
        changed = true;
      }
    }
    if (changed) this.publish();
  }

  setMuted(muted: boolean) {
    for (const t of this.audio?.tracks ?? []) t.enabled = !muted;
    this.publish({ muted });
  }

  /** Leave the call. It goes on for everyone else. */
  leave({ notify = true } = {}) {
    const callId = this.snap.callId;
    for (const t of this.meetTimers.values()) clearTimeout(t);
    this.meetTimers.clear();
    for (const l of this.links.values()) {
      if (notify && callId) this.deps.send(l.id, { callId, op: 'm-bye' }).catch(() => {});
      this.close(l);
    }
    this.links.clear();
    for (const t of this.audio?.tracks ?? []) t.stop();
    this.audio = null;
    this.snap = IDLE;
    this.publish();
  }
}
