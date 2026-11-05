// Group calls with fake phones:  node --test --experimental-strip-types src/lib/meshCall.test.ts
// Phones are joined by an in-memory "server"; the peer connections are fakes
// whose ICE state the tests drive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MeshCall, MESH_MAX, type MeshBody } from './meshCall.ts';
import type { IceCandidateInit, PeerConnectionLike, Sdp, TrackLike } from './callEngine.ts';

const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeTrack implements TrackLike {
  enabled = true;
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakePc implements PeerConnectionLike {
  signalingState = 'stable';
  iceConnectionState = 'new';
  onicecandidate: PeerConnectionLike['onicecandidate'] = null;
  oniceconnectionstatechange: (() => void) | null = null;
  closed = false;
  added: IceCandidateInit[] = [];
  tracks: TrackLike[] = [];
  restarts = 0;
  async createOffer(o?: { iceRestart?: boolean }): Promise<Sdp> {
    if (o?.iceRestart) this.restarts++;
    return { type: 'offer', sdp: 'v=0\r\na=rtpmap:111 opus/48000/2\r\n' };
  }
  async createAnswer(): Promise<Sdp> {
    return { type: 'answer', sdp: 'v=0\r\na=rtpmap:111 opus/48000/2\r\n' };
  }
  async setLocalDescription(d: Sdp) {
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(d: Sdp) {
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async addIceCandidate(c: IceCandidateInit) {
    this.added.push(c);
  }
  addTrack(t: TrackLike) {
    this.tracks.push(t);
  }
  close() {
    this.closed = true;
  }
  ice(state: string) {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.();
  }
}

/** A family of phones on one in-memory server. */
function family(ids: string[], timing = {}) {
  const phones = new Map<string, { call: MeshCall; pcs: FakePc[]; track: FakeTrack }>();
  for (const id of ids) {
    const pcs: FakePc[] = [];
    const track = new FakeTrack();
    const call = new MeshCall({
      selfId: id,
      timing,
      send: async (to, body: MeshBody) => {
        void phones.get(to)?.call.handleSignal({ ...body, from: id });
      },
      createPeerConnection: () => {
        const pc = new FakePc();
        pcs.push(pc);
        return pc;
      },
      getLocalAudio: async () => ({ tracks: [track], stream: {} }),
    });
    phones.set(id, { call, pcs, track });
  }
  return phones;
}
const connectAll = (phones: ReturnType<typeof family>) => {
  for (const p of phones.values()) for (const pc of p.pcs) if (pc.iceConnectionState === 'new') pc.ice('connected');
};

test('three people: whoever joins calls those already on it, and all end up connected', async () => {
  const f = family(['a', 'b', 'c']);
  await f.get('a')!.call.join('room', []);
  await f.get('b')!.call.join('room', ['a']);
  await flush();
  await f.get('c')!.call.join('room', ['a', 'b']);
  await flush();
  connectAll(f);
  for (const id of ['a', 'b', 'c']) {
    const s = f.get(id)!.call.snapshot;
    assert.equal(s.phase, 'active', id);
    assert.equal(s.peers.length, 2, id);
    assert.ok(s.peers.every((p) => p.state === 'connected'));
    assert.ok(s.startedAt);
    // One microphone, sent on every connection.
    assert.ok(f.get(id)!.pcs.every((pc) => pc.tracks[0] === f.get(id)!.track));
  }
});

test('no more than six on a call', async () => {
  const ids = Array.from({ length: 9 }, (_, i) => `p${i}`);
  const f = family(ids);
  await f.get('p0')!.call.join('room', ids.slice(1));
  assert.equal(f.get('p0')!.pcs.length, MESH_MAX - 1);
});

test('ICE candidates that arrive early wait for the answer', async () => {
  // Nobody on the other end of this server: the signals are delivered by hand.
  const f = family(['b']);
  const b = f.get('b')!;
  await b.call.join('room', ['a']);
  await b.call.handleSignal({ callId: 'room', op: 'm-ice', cands: [{ candidate: 'x' }], from: 'a' });
  assert.equal(b.pcs[0].added.length, 0);
  await b.call.handleSignal({ callId: 'room', op: 'm-answer', sdp: 'v=0', from: 'a' });
  assert.equal(b.pcs[0].added.length, 1);
});

test('both call at once: the lower id’s call stands', async () => {
  const f = family(['a', 'b']);
  await f.get('a')!.call.join('room', ['b']);
  await f.get('b')!.call.join('room', ['a']);
  await flush();
  connectAll(f);
  assert.equal(f.get('a')!.call.snapshot.peers.length, 1);
  assert.equal(f.get('b')!.call.snapshot.peers.length, 1);
  assert.equal(f.get('b')!.pcs.filter((p) => !p.closed).length, 1);
});

test('someone who joined but never called is called, by the lower id only', async () => {
  const f = family(['a', 'b'], { meetMs: 5 });
  await f.get('a')!.call.join('room', []);
  await f.get('b')!.call.join('room', []);
  f.get('a')!.call.peerJoined('b');
  f.get('b')!.call.peerJoined('a');
  await wait(20);
  await flush();
  assert.equal(f.get('a')!.pcs.length, 1);
  assert.equal(f.get('b')!.pcs.length, 1);
});

test('leaving: the others stay on, and the microphone stops', async () => {
  const f = family(['a', 'b', 'c']);
  await f.get('a')!.call.join('room', []);
  await f.get('b')!.call.join('room', ['a']);
  await f.get('c')!.call.join('room', ['a', 'b']);
  await flush();
  connectAll(f);
  f.get('c')!.call.leave();
  await flush();
  assert.equal(f.get('c')!.call.snapshot.phase, 'idle');
  assert.ok(f.get('c')!.track.stopped);
  assert.deepEqual(f.get('a')!.call.snapshot.peers.map((p) => p.id), ['b']);
  assert.deepEqual(f.get('b')!.call.snapshot.peers.map((p) => p.id), ['a']);
  assert.equal(f.get('a')!.call.snapshot.phase, 'active');
});

test('a dropped connection: the caller restarts it, and it comes back', async () => {
  const f = family(['a', 'b'], { graceMs: 5, giveUpMs: 200 });
  await f.get('a')!.call.join('room', []);
  await f.get('b')!.call.join('room', ['a']);
  await flush();
  connectAll(f);
  const caller = f.get('b')!.pcs[0];
  caller.ice('disconnected');
  assert.equal(f.get('b')!.call.snapshot.peers[0].state, 'reconnecting');
  await wait(20);
  await flush();
  assert.equal(caller.restarts, 1);
  caller.ice('connected');
  assert.equal(f.get('b')!.call.snapshot.peers[0].state, 'connected');
});

test('someone who never comes back is off the call', async () => {
  const f = family(['a', 'b'], { graceMs: 2, giveUpMs: 10 });
  await f.get('a')!.call.join('room', []);
  await f.get('b')!.call.join('room', ['a']);
  await flush();
  await wait(30);
  assert.deepEqual(f.get('b')!.call.snapshot.peers, []);
  assert.ok(f.get('b')!.pcs[0].closed);
});

test('mute switches the track off, and speaking is shown per person', async () => {
  const f = family(['a', 'b']);
  await f.get('a')!.call.join('room', []);
  await f.get('b')!.call.join('room', ['a']);
  await flush();
  const a = f.get('a')!;
  a.call.setMuted(true);
  assert.equal(a.track.enabled, false);
  assert.equal(a.call.snapshot.muted, true);
  a.call.setSpeaking(new Set(['b']));
  assert.equal(a.call.snapshot.peers[0].speaking, true);
});

test('a signal for another room is ignored', async () => {
  const f = family(['a', 'b']);
  await f.get('a')!.call.join('room', []);
  await f.get('a')!.call.handleSignal({ callId: 'other', op: 'm-offer', sdp: 'x', from: 'b' });
  assert.equal(f.get('a')!.pcs.length, 0);
});
