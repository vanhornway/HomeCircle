// The call engine with fake phones:  node --test --experimental-strip-types src/lib/callEngine.test.ts
// Two engines are joined by an in-memory "server"; the peer connections are
// fakes whose ICE state the tests drive.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceCallEngine, type EndInfo, type IceCandidateInit, type PeerConnectionLike, type Sdp, type SignalBody, type TrackLike } from './callEngine.ts';

const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

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
  hasRemote = false;
  log: string[] = [];
  added: IceCandidateInit[] = [];
  tracks: TrackLike[] = [];
  n = 0;
  async createOffer(o?: { iceRestart?: boolean }): Promise<Sdp> {
    return { type: 'offer', sdp: `v=0\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10\r\nx-offer ${++this.n}${o?.iceRestart ? ' restart' : ''}\r\n` };
  }
  async createAnswer(): Promise<Sdp> {
    return { type: 'answer', sdp: `v=0\r\na=rtpmap:111 opus/48000/2\r\nx-answer ${++this.n}\r\n` };
  }
  async setLocalDescription(d: Sdp) {
    this.log.push(`local:${d.type}`);
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(d: Sdp) {
    this.log.push(`remote:${d.type}`);
    if (d.type === 'offer' && this.signalingState === 'have-local-offer') throw new Error('InvalidStateError: needs a rollback');
    this.hasRemote = true;
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async addIceCandidate(c: IceCandidateInit) {
    if (!this.hasRemote) throw new Error('no remote description yet');
    this.log.push('candidate');
    this.added.push(c);
  }
  addTrack(t: TrackLike) {
    this.tracks.push(t);
  }
  close() {
    this.closed = true;
  }
  fireIce(state: string) {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.();
  }
  localCandidate(candidate: string) {
    this.onicecandidate?.({ candidate: { toJSON: () => ({ candidate, sdpMid: '0', sdpMLineIndex: 0 }) } });
  }
}

type Phone = { id: string; engine: VoiceCallEngine; pcs: FakePc[]; tracks: FakeTrack[]; ended: EndInfo[]; sent: { to: string; body: SignalBody; ring?: boolean }[]; micError?: Error; sendError?: Error };

const everyone: VoiceCallEngine[] = [];

/** A little network: engines, who is reachable, and what was sent. */
function world(ids: string[], timing = {}) {
  const phones = new Map<string, Phone>();
  const dropped: SignalBody[] = [];
  const net = { down: new Set<string>() };
  for (const id of ids) {
    const phone: Phone = { id, engine: null as unknown as VoiceCallEngine, pcs: [], tracks: [], ended: [], sent: [] };
    phone.engine = new VoiceCallEngine({
      selfId: id,
      timing,
      newId: (() => {
        let n = 0;
        return () => `${id}-call-${++n}`;
      })(),
      send: async (to, body, opts) => {
        if (phone.sendError) throw phone.sendError;
        if (net.down.has(id)) throw new Error('offline');
        phone.sent.push({ to, body, ring: opts?.ring });
        const peer = phones.get(to);
        if (peer && !net.down.has(to)) void peer.engine.handleSignal({ ...body, from: id });
        else dropped.push(body);
        return { online: !!peer };
      },
      createPeerConnection: () => {
        const pc = new FakePc();
        phone.pcs.push(pc);
        return pc;
      },
      getLocalAudio: async () => {
        if (phone.micError) throw phone.micError;
        const t = new FakeTrack();
        phone.tracks.push(t);
        return { tracks: [t], stream: {} };
      },
      iceServers: async () => [{ urls: 'stun:stun.example.org:3478' }],
      onEnded: (e) => phone.ended.push(e),
    });
    phones.set(id, phone);
    everyone.push(phone.engine);
  }
  return { phones, net, dropped, get: (id: string) => phones.get(id)! };
}

const connect = (a: Phone, b: Phone) => {
  a.pcs.at(-1)!.fireIce('connected');
  b.pcs.at(-1)!.fireIce('connected');
};

afterEach(async () => {
  mock.timers.reset();
  // Calls left running hold timers that would keep Node waiting.
  for (const e of everyone.splice(0)) await e.hangup();
});

test('a call: rings, is answered, connects, and either side can end it', async () => {
  const w = world(['a', 'b']);
  const [a, b] = [w.get('a'), w.get('b')];
  const callId = await a.engine.start('b');
  await flush();
  assert.equal(a.engine.snapshot.phase, 'outgoing');
  assert.equal(a.sent[0].body.op, 'offer');
  assert.equal(a.sent[0].ring, true); // the first offer rings the other phone
  // B rings and tells A so.
  assert.equal(b.engine.snapshot.phase, 'incoming');
  assert.equal(b.engine.snapshot.peerId, 'a');
  assert.equal(a.engine.snapshot.remoteRinging, true);
  // B has not opened its microphone or made a connection yet.
  assert.equal(b.pcs.length, 0);
  await b.engine.accept();
  await flush();
  assert.equal(a.engine.snapshot.phase, 'connecting');
  assert.equal(b.engine.snapshot.phase, 'connecting');
  assert.equal(b.sent.find((s) => s.body.op === 'answer')!.ring, undefined);
  connect(a, b);
  assert.equal(a.engine.snapshot.phase, 'active');
  assert.equal(b.engine.snapshot.phase, 'active');
  assert.ok(a.engine.snapshot.startedAt && b.engine.snapshot.startedAt);
  assert.equal(a.engine.snapshot.callId, callId);
  await a.engine.hangup();
  await flush();
  assert.equal(a.engine.snapshot.phase, 'idle');
  assert.equal(b.engine.snapshot.phase, 'idle');
  assert.equal(a.ended[0].reason, 'hangup');
  assert.equal(b.ended[0].reason, 'remote_hangup');
  assert.equal(b.ended[0].incoming, true);
  assert.ok(a.pcs[0].closed && b.pcs[0].closed);
  assert.ok(a.tracks[0].stopped && b.tracks[0].stopped); // stopped only now, at the end
});

test('the offer carries the Opus settings for voice', async () => {
  const w = world(['a', 'b']);
  await w.get('a').engine.start('b');
  await flush();
  const sdp = w.get('a').sent[0].body.sdp!;
  assert.match(sdp, /a=fmtp:111 .*maxaveragebitrate=32000/);
  assert.match(sdp, /useinbandfec=1/);
  await w.get('b').engine.accept();
  await flush();
  assert.match(w.get('b').sent.find((s) => s.body.op === 'answer')!.body.sdp!, /maxaveragebitrate=32000/);
});

test('candidates that arrive early wait for the remote description, then go in order', async () => {
  const w = world(['a', 'b']);
  const [a, b] = [w.get('a'), w.get('b')];
  await a.engine.start('b');
  await flush();
  // A's candidates are found and sent while B is still ringing.
  mock.timers.enable({ apis: ['setTimeout'] });
  a.pcs[0].localCandidate('c1');
  a.pcs[0].localCandidate('c2');
  mock.timers.tick(150); // the batch goes out together
  await flush();
  const ice = a.sent.filter((s) => s.body.op === 'ice');
  assert.equal(ice.length, 1);
  assert.deepEqual(ice[0].body.cands!.map((c) => c.candidate), ['c1', 'c2']);
  mock.timers.reset();
  await b.engine.accept();
  await flush();
  assert.deepEqual(b.pcs[0].added.map((c) => c.candidate), ['c1', 'c2']);
  // Remote description first, candidates after.
  assert.ok(b.pcs[0].log.indexOf('remote:offer') < b.pcs[0].log.indexOf('candidate'));
  // One that comes later is added at once.
  await b.engine.handleSignal({ from: 'a', callId: a.engine.snapshot.callId!, op: 'ice', cands: [{ candidate: 'c3' }] });
  assert.equal(b.pcs[0].added.length, 3);
});

test('the caller’s answer arrives and later candidates are added after it', async () => {
  const w = world(['a', 'b']);
  const [a, b] = [w.get('a'), w.get('b')];
  await a.engine.start('b');
  await flush();
  const callId = a.engine.snapshot.callId!;
  // B's candidate beats B's answer (as can happen with two requests).
  await a.engine.handleSignal({ from: 'b', callId, op: 'ice', cands: [{ candidate: 'early' }] });
  assert.equal(a.pcs[0].added.length, 0);
  await b.engine.accept();
  await flush();
  assert.deepEqual(a.pcs[0].added.map((c) => c.candidate), ['early']);
});

test('both call at once: the lower member id keeps its offer, the other answers it', async () => {
  const w = world(['a', 'b']);
  const [a, b] = [w.get('a'), w.get('b')];
  // Neither hears the other's offer until both have started.
  const held: (() => void)[] = [];
  const realA = a.engine.handleSignal.bind(a.engine);
  const realB = b.engine.handleSignal.bind(b.engine);
  a.engine.handleSignal = (s) => (held.push(() => void realA(s)), Promise.resolve());
  b.engine.handleSignal = (s) => (held.push(() => void realB(s)), Promise.resolve());
  const idA = await a.engine.start('b');
  const idB = await b.engine.start('a');
  await flush();
  a.engine.handleSignal = realA;
  b.engine.handleSignal = realB;
  held.forEach((f) => f());
  await flush(12);
  // 'a' < 'b': a's call stands. b gave up its own and answered a's.
  assert.equal(a.engine.snapshot.callId, idA);
  assert.equal(b.engine.snapshot.callId, idA);
  assert.notEqual(idA, idB);
  assert.equal(a.engine.snapshot.phase, 'connecting');
  assert.equal(b.engine.snapshot.phase, 'connecting');
  assert.equal(b.engine.snapshot.incoming, true);
  assert.deepEqual(a.ended, []);
  assert.deepEqual(b.ended, []); // no "call ended" for the one dropped
  assert.equal(b.tracks.length, 1); // one microphone, kept
  assert.equal(b.tracks[0].stopped, false);
  connect(a, b);
  assert.equal(a.engine.snapshot.phase, 'active');
  assert.equal(b.engine.snapshot.phase, 'active');
});

test('in a call, a third person calling hears busy; the call goes on', async () => {
  const w = world(['a', 'b', 'c']);
  const [a, b, c] = [w.get('a'), w.get('b'), w.get('c')];
  await a.engine.start('b');
  await flush();
  await b.engine.accept();
  await flush();
  connect(a, b);
  await c.engine.start('b');
  await flush();
  assert.equal(c.ended[0].reason, 'busy');
  assert.equal(c.engine.snapshot.phase, 'idle');
  assert.equal(b.engine.snapshot.phase, 'active');
  assert.equal(b.engine.snapshot.peerId, 'a');
  // Calling someone who is already calling someone else: busy too.
  await b.engine.hangup();
  await flush();
});

test('declining ends the caller’s call with "declined"', async () => {
  const w = world(['a', 'b']);
  await w.get('a').engine.start('b');
  await flush();
  await w.get('b').engine.decline();
  await flush();
  assert.equal(w.get('a').ended[0].reason, 'declined');
  assert.equal(w.get('b').ended[0].reason, 'declined');
  assert.equal(w.get('a').engine.snapshot.phase, 'idle');
  assert.equal(w.get('b').pcs.length, 0); // never opened anything
  assert.equal(w.get('b').tracks.length, 0);
});

test('nobody answers: the caller gives up after 45 s and the other phone stops ringing', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const w = world(['a', 'b']);
  const [a, b] = [w.get('a'), w.get('b')];
  await a.engine.start('b');
  await flush();
  assert.equal(b.engine.snapshot.phase, 'incoming');
  mock.timers.tick(44_000);
  await flush();
  assert.equal(a.engine.snapshot.phase, 'outgoing');
  mock.timers.tick(1_500);
  await flush();
  assert.equal(a.ended[0].reason, 'no_answer');
  assert.equal(b.ended[0].reason, 'missed'); // it rang on B and B never answered
  assert.equal(b.engine.snapshot.phase, 'idle');
  assert.ok(a.sent.some((s) => s.body.op === 'hangup'));
});

test('a phone that never hears back gives the ring up by itself', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const w = world(['a', 'b']);
  const b = w.get('b');
  await b.engine.handleSignal({ from: 'a', callId: 'x1', op: 'offer', sdp: 'o' });
  assert.equal(b.engine.snapshot.phase, 'incoming');
  mock.timers.tick(46_000);
  await flush();
  assert.equal(b.ended[0].reason, 'missed');
  // And a hang-up arriving for a call that rang is a missed call too.
  await b.engine.handleSignal({ from: 'a', callId: 'x2', op: 'offer', sdp: 'o' });
  await b.engine.handleSignal({ from: 'a', callId: 'x2', op: 'hangup' });
  assert.equal(b.ended[1].reason, 'missed');
});

test('muting switches the track off and back on and never stops it', async () => {
  const w = world(['a', 'b']);
  const [a, b] = [w.get('a'), w.get('b')];
  await a.engine.start('b');
  await flush();
  await b.engine.accept();
  await flush();
  connect(a, b);
  a.engine.setMuted(true);
  assert.equal(a.tracks[0].enabled, false);
  assert.equal(a.tracks[0].stopped, false);
  assert.equal(a.engine.snapshot.muted, true);
  a.engine.setMuted(false);
  assert.equal(a.tracks[0].enabled, true);
  assert.equal(a.tracks[0].stopped, false);
});

test('a dropped connection: 5 s grace, then ICE restarts and the call comes back', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const w = world(['a', 'b']);
  const [a, b] = [w.get('a'), w.get('b')];
  await a.engine.start('b');
  await flush();
  await b.engine.accept();
  await flush();
  connect(a, b);
  const offersBefore = a.sent.filter((s) => s.body.op === 'offer').length;
  a.pcs[0].fireIce('disconnected');
  mock.timers.tick(4_000);
  await flush();
  assert.equal(a.sent.filter((s) => s.body.op === 'offer').length, offersBefore); // a blip may heal itself
  a.pcs[0].fireIce('connected');
  mock.timers.tick(10_000);
  await flush();
  assert.equal(a.sent.filter((s) => s.body.op === 'offer').length, offersBefore);
  assert.equal(a.engine.snapshot.phase, 'active');
  // Now it stays down.
  a.pcs[0].fireIce('disconnected');
  b.pcs[0].fireIce('disconnected');
  mock.timers.tick(5_100);
  await flush();
  assert.equal(a.engine.snapshot.phase, 'reconnecting');
  const restart = a.sent.filter((s) => s.body.op === 'offer').at(-1)!;
  assert.equal(restart.body.restart, true);
  assert.equal(restart.ring, undefined); // a restart doesn't ring again
  assert.match(restart.body.sdp!, /restart/);
  // B answered it (same call id), and the path comes back.
  assert.equal(b.sent.filter((s) => s.body.op === 'answer').length, 2);
  a.pcs[0].fireIce('connected');
  b.pcs[0].fireIce('connected');
  assert.equal(a.engine.snapshot.phase, 'active');
  assert.equal(a.engine.snapshot.callId, restart.body.callId);
  assert.deepEqual(a.ended, []);
  assert.equal(a.pcs.length, 1); // the same peer connection throughout
});

test('"failed" restarts at once; a network change restarts a call that still looks connected', async () => {
  const w = world(['a', 'b']);
  const [a, b] = [w.get('a'), w.get('b')];
  await a.engine.start('b');
  await flush();
  await b.engine.accept();
  await flush();
  connect(a, b);
  a.pcs[0].fireIce('failed');
  await flush();
  assert.equal(a.engine.snapshot.phase, 'reconnecting');
  a.pcs[0].fireIce('connected');
  assert.equal(a.engine.snapshot.phase, 'active');
  // Wi-Fi to mobile data: ICE never says "disconnected", but the path changed.
  a.engine.networkChanged();
  await flush();
  assert.equal(a.sent.filter((s) => s.body.op === 'offer' && s.body.restart).length, 2);
  assert.equal(a.engine.snapshot.phase, 'active'); // healed by the answer, no event needed
});

test('both restart at once: the lower member id keeps its offer, the other rolls back and answers', async () => {
  const w = world(['a', 'b']);
  const [a, b] = [w.get('a'), w.get('b')];
  await a.engine.start('b');
  await flush();
  await b.engine.accept();
  await flush();
  connect(a, b);
  const held: (() => void)[] = [];
  const realA = a.engine.handleSignal.bind(a.engine);
  const realB = b.engine.handleSignal.bind(b.engine);
  a.engine.handleSignal = (s) => (held.push(() => void realA(s)), Promise.resolve());
  b.engine.handleSignal = (s) => (held.push(() => void realB(s)), Promise.resolve());
  a.engine.networkChanged();
  b.engine.networkChanged();
  await flush();
  a.engine.handleSignal = realA;
  b.engine.handleSignal = realB;
  held.forEach((f) => f());
  await flush(12);
  assert.ok(b.pcs[0].log.includes('local:rollback'));
  assert.ok(!a.pcs[0].log.includes('local:rollback'));
  // B answered A's offer; A ignored B's.
  assert.equal(a.pcs[0].signalingState, 'stable');
  assert.equal(b.pcs[0].signalingState, 'stable');
  assert.equal(a.engine.snapshot.phase, 'active');
  assert.equal(b.engine.snapshot.phase, 'active');
});

test('a connection that stays lost for 45 s ends the call; one that never connects ends in 30 s', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const w = world(['a', 'b']);
  const [a, b] = [w.get('a'), w.get('b')];
  await a.engine.start('b');
  await flush();
  await b.engine.accept();
  await flush();
  connect(a, b);
  a.pcs[0].fireIce('failed');
  await flush();
  mock.timers.tick(46_000);
  await flush();
  assert.equal(a.ended[0].reason, 'failed');
  assert.equal(b.ended[0].reason, 'remote_hangup');

  const w2 = world(['a', 'b']);
  await w2.get('a').engine.start('b');
  await flush();
  await w2.get('b').engine.accept();
  await flush();
  mock.timers.tick(31_000); // nobody ever connected
  await flush();
  assert.equal(w2.get('a').ended[0].reason, 'failed');
});

test('no network while restarting: it keeps trying until the network is back', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const w = world(['a', 'b']);
  const [a, b] = [w.get('a'), w.get('b')];
  await a.engine.start('b');
  await flush();
  await b.engine.accept();
  await flush();
  connect(a, b);
  w.net.down.add('a');
  a.pcs[0].fireIce('failed');
  await flush();
  mock.timers.tick(3_100);
  await flush();
  mock.timers.tick(3_100);
  await flush();
  assert.equal(a.engine.snapshot.phase, 'reconnecting');
  w.net.down.delete('a');
  mock.timers.tick(3_100);
  await flush();
  assert.equal(a.sent.filter((s) => s.body.op === 'offer' && s.body.restart).length, 1);
  a.pcs[0].fireIce('connected');
  assert.equal(a.engine.snapshot.phase, 'active');
});

test('no microphone: the call is over before anything is sent', async () => {
  const w = world(['a', 'b']);
  const a = w.get('a');
  a.micError = new Error('Permission denied');
  await assert.rejects(() => a.engine.start('b'), /Permission denied/);
  assert.equal(a.ended[0].reason, 'no_microphone');
  assert.equal(a.sent.length, 0);
  assert.equal(a.engine.snapshot.phase, 'idle');
  // The callee side: answering without a microphone declines for them.
  const b = w.get('b');
  const c = world(['x', 'y']);
  await c.get('x').engine.start('y');
  await flush();
  c.get('y').micError = new Error('Permission denied');
  await c.get('y').engine.accept();
  await flush();
  assert.equal(c.get('y').ended[0].reason, 'no_microphone');
  assert.equal(c.get('x').ended[0].reason, 'declined');
  void b;
});

test('the server refusing the call ends it with "unreachable" and the microphone is released', async () => {
  const w = world(['a', 'b']);
  const a = w.get('a');
  a.sendError = Object.assign(new Error('Voice calls are turned off in this circle'), { status: 403 });
  await assert.rejects(() => a.engine.start('b'), /turned off/);
  assert.equal(a.ended[0].reason, 'unreachable');
  assert.ok(a.tracks[0].stopped);
  assert.ok(a.pcs[0].closed);
  assert.equal(a.engine.snapshot.phase, 'idle');
});

test('hanging up while the microphone is still starting releases it', async () => {
  const w = world(['a', 'b']);
  const a = w.get('a');
  const track = new FakeTrack();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const engine = new VoiceCallEngine({
    selfId: 'a',
    newId: () => 'a-1',
    send: async () => ({}),
    createPeerConnection: () => new FakePc(),
    getLocalAudio: async () => (await gate, { tracks: [track], stream: {} }),
  });
  const started = engine.start('b');
  await flush();
  await engine.hangup();
  release();
  await started;
  await flush();
  assert.equal(track.stopped, true);
  assert.equal(engine.snapshot.phase, 'idle');
  void a;
});

test('signals for another call, from another person, or after the end are ignored', async () => {
  const w = world(['a', 'b', 'c']);
  const [a, b] = [w.get('a'), w.get('b')];
  await a.engine.start('b');
  await flush();
  await b.engine.accept();
  await flush();
  connect(a, b);
  const callId = a.engine.snapshot.callId!;
  await a.engine.handleSignal({ from: 'b', callId: 'someone-elses', op: 'hangup' });
  await a.engine.handleSignal({ from: 'c', callId, op: 'hangup' });
  assert.equal(a.engine.snapshot.phase, 'active');
  await a.engine.handleSignal({ from: 'b', callId, op: 'hangup' });
  assert.equal(a.engine.snapshot.phase, 'idle');
  // Late candidates and a second hang-up for the finished call do nothing.
  await a.engine.handleSignal({ from: 'b', callId, op: 'ice', cands: [{ candidate: 'late' }] });
  await a.engine.handleSignal({ from: 'b', callId, op: 'hangup' });
  assert.equal(a.ended.length, 1);
  // A second call is a clean start.
  await a.engine.start('c');
  assert.equal(a.engine.snapshot.phase, 'outgoing');
  assert.notEqual(a.engine.snapshot.callId, callId);
});

test('answered on another of the person’s phones', async () => {
  const w = world(['a', 'b']);
  const b = w.get('b');
  await b.engine.handleSignal({ from: 'a', callId: 'x', op: 'offer', sdp: 'o' });
  await b.engine.handleSignal({ from: 'a', callId: 'x', op: 'hangup', reason: 'elsewhere' });
  assert.equal(b.ended[0].reason, 'elsewhere');
});

test('one call at a time: starting another while in a call is refused', async () => {
  const w = world(['a', 'b']);
  await w.get('a').engine.start('b');
  await assert.rejects(() => w.get('a').engine.start('b'), /Already in a call/);
});
