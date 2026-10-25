// Runs each circle's agent next to the server (AGENT=true). The agent is a
// member like any phone: it talks to this server over HTTP and the live
// connection, holds its own keys, and never the circle key.
//
// Getting it into a circle: an admin's phone makes an agent invite and seals
// the link to this host's public key (POST /agent-host/setup); the host opens
// it, joins, and from then on the admin sets the AI provider, key and budget
// with messages sealed to the agent itself. Its data lives in
// DATA_DIR/agent/<circle>/: the agent's keys, and its memory, encrypted.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import { AgentClient } from '../../../packages/core/src/agent.js';
import { Memory } from './memory.js';
import { Brain } from './brain.js';

const b64 = (u8) => Buffer.from(u8).toString('base64url');
const unb64 = (s) => new Uint8Array(Buffer.from(String(s), 'base64url'));

/** The agent's own storage: one JSON file. */
class FileStorage {
  constructor(file) {
    this.file = file;
    this.data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  }
  async getItem(k) {
    return this.data[k] ?? null;
  }
  async setItem(k, v) {
    this.data[k] = v;
    writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 });
  }
  async removeItem(k) {
    delete this.data[k];
    writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 });
  }
}

export class AgentHost {
  constructor({ dataDir, log = () => {}, brainOptions = {}, refreshEveryMs = 30 * 60_000 }) {
    this.dir = join(dataDir, 'agent');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.log = log;
    this.brainOptions = brainOptions;
    this.refreshEveryMs = refreshEveryMs;
    // The host's keys: its box key receives setup links; its secret is where
    // each circle's memory key comes from.
    const keyFile = join(this.dir, 'host.json');
    if (!existsSync(keyFile)) {
      const box = nacl.box.keyPair();
      writeFileSync(keyFile, JSON.stringify({ boxPub: b64(box.publicKey), boxSecret: b64(box.secretKey), secret: b64(randomBytes(32)) }), { mode: 0o600 });
    }
    this.keys = JSON.parse(readFileSync(keyFile, 'utf8'));
    this.circles = new Map(); // circleId -> { agent, memory, brain }
    this.url = null;
    this.timer = null;
  }

  get boxPub() {
    return this.keys.boxPub;
  }

  /** Start every circle's agent (after the server is listening at `url`). */
  async start(url) {
    this.url = url;
    for (const id of readdirSync(this.dir)) {
      if (existsSync(join(this.dir, id, 'agent.json'))) await this._run(id).catch((e) => this.log(`agent: couldn’t start for a circle: ${e.message}`));
    }
    this.timer = setInterval(() => this.refresh().catch(() => {}), this.refreshEveryMs);
  }

  async stop() {
    clearInterval(this.timer);
    for (const c of this.circles.values()) {
      c.agent.disconnect();
      await c.brain.queue.catch(() => {});
      c.memory.close();
    }
    this.circles.clear();
  }

  /** Re-read due calendars in every circle. */
  async refresh() {
    for (const c of this.circles.values()) {
      await c.brain.refreshSources().catch((e) => this.log('agent: refresh failed', e.message));
      await c.brain.enqueue(() => c.brain.checkReminders());
    }
  }

  hasAgent(circleId) {
    return this.circles.has(circleId);
  }

  _memoryKey(circleId) {
    return new Uint8Array(createHmac('sha256', unb64(this.keys.secret)).update(`memory:${circleId}`).digest());
  }

  /**
   * An admin's phone sent the agent invite, sealed to this host's key.
   * `fromBoxPub` is that admin's key (the server checked it's theirs).
   */
  async setup({ circleId, fromBoxPub, box }) {
    if (this.circles.has(circleId)) throw Object.assign(new Error('This circle already has an agent'), { code: 'agent_exists' });
    const plain = nacl.box.open(unb64(box.ct), unb64(box.nonce), unb64(fromBoxPub), unb64(this.keys.boxSecret));
    if (!plain) throw Object.assign(new Error('Couldn’t open the setup'), { code: 'invalid' });
    const { link } = JSON.parse(Buffer.from(plain).toString('utf8'));
    const dir = join(this.dir, circleId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const agent = new AgentClient({ storage: new FileStorage(join(dir, 'agent.json')), onError: (e) => this.log('agent:', e.message) });
    // Join through this server, whatever address the link names.
    const local = String(link).replace(/^https?:\/\/[^/#]+/, this.url);
    try {
      await agent.join(local);
      if (agent.circleId !== circleId) throw Object.assign(new Error('That invite is for another circle'), { code: 'invalid' });
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    await this._run(circleId, agent);
    this.log('agent joined a circle');
    return { memberId: agent.memberId };
  }

  async _run(circleId, existing = null) {
    const dir = join(this.dir, circleId);
    const agent = existing ?? new AgentClient({ storage: new FileStorage(join(dir, 'agent.json')), onError: (e) => this.log('agent:', e.message) });
    if (!existing) {
      await agent.load();
      // Talk to this server locally, whatever address it had when it joined.
      agent.account.server = this.url;
      agent.api = agent._api(this.url, agent.account.token);
      try {
        await agent.refresh();
      } catch (e) {
        if (e?.status === 401) return this._forget(circleId);
        throw e;
      }
    }
    const memory = new Memory(join(dir, 'memory.db'), this._memoryKey(circleId));
    const brain = new Brain({ agent, memory, log: this.log, ...this.brainOptions });
    agent.on('message', (m) => brain.handle(m));
    agent.on('removed', () => this._forget(circleId));
    this.circles.set(circleId, { agent, memory, brain });
    agent.connect();
    await agent.fetchMessages();
  }

  /** Removed from its circle: its keys and memory go too. */
  async _forget(circleId) {
    const c = this.circles.get(circleId);
    if (c) {
      c.agent.disconnect();
      await c.brain.queue.catch(() => {});
      c.memory.close();
      this.circles.delete(circleId);
    }
    rmSync(join(this.dir, circleId), { recursive: true, force: true });
    this.log('agent removed from a circle; its memory was deleted');
  }
}
