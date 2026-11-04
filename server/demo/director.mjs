// The demo director: keeps a few copies of the demo family ready, and runs
// every copy a visitor is in. It holds each copy's keys in memory only, so
// when it starts it clears whatever a previous run left on the server.
//
//   DEMO_MODE=1 DEMO_TOKEN=… node server/src/index.js     starts it too
//   DEMO_SERVER=http://127.0.0.1:8080 DEMO_TOKEN=… node server/demo/director.mjs
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Copy } from './copy.mjs';

const num = (v, def) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? def : Number(v));
const LOOP_MS = 2000;
// A copy waits this long for a visitor, then is rebuilt: its chat should read like yesterday.
const READY_FOR_MS = 24 * 3_600_000;

export class Director {
  constructor({ server, token, pool = 3, pace = 1, ai = null, budgetUsd = 0.25, log = () => {} }) {
    this.server = server.replace(/\/+$/, '');
    this.token = token;
    this.pool = pool;
    this.pace = pace;
    this.ai = ai;
    this.budgetUsd = budgetUsd;
    this.log = log;
    this.copies = new Map(); // circleId -> { copy, builtAt }
    this.building = null;
    this.timer = null;
    this.stopped = false;
  }

  async _api(method, path, body) {
    const res = await fetch(`${this.server}/api/v1${path}`, {
      method,
      headers: { 'x-demo-token': this.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${path}: ${data.error ?? res.status}`);
    return data;
  }

  async start() {
    const { demo } = await this._api('GET', '/info');
    if (!demo) throw new Error('That server isn’t in demo mode');
    this.minutes = demo.minutes;
    const { copies } = await this._api('GET', '/demo/copies');
    for (const c of copies) await this._api('DELETE', `/demo/copies/${c.circleId}`);
    if (copies.length) this.log(`demo: cleared ${copies.length} copies left by an earlier run`);
    this.timer = setInterval(() => this._loop().catch((e) => this.log(`demo: ${e.message}`)), LOOP_MS);
    return this._loop();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.building?.catch(() => {});
    for (const { copy } of this.copies.values()) copy.stop();
  }

  async _loop() {
    if (this.looping) return;
    this.looping = true;
    try {
      const { copies, ready } = await this._api('GET', '/demo/copies');
      const live = new Map(copies.map((c) => [c.circleId, c]));
      // Ended on the server: the hour, an early leave, or a quiet visitor.
      for (const [id, { copy }] of this.copies) {
        if (!live.has(id)) {
          copy.stop();
          this.copies.delete(id);
        }
      }
      for (const c of copies) {
        const mine = this.copies.get(c.circleId);
        if (!mine) await this._api('DELETE', `/demo/copies/${c.circleId}`);
        else if (c.visitorId && !mine.copy.running) await mine.copy.run(c.visitorId);
        else if (!c.claimedAt && Date.now() - mine.builtAt > READY_FOR_MS) await this._api('DELETE', `/demo/copies/${c.circleId}`);
      }
      if (ready < this.pool && !this.building && !this.stopped) {
        this.building = this._build().finally(() => (this.building = null));
      }
    } finally {
      this.looping = false;
    }
  }

  async _build() {
    const t0 = Date.now();
    const copy = new Copy({ server: this.server, token: this.token, minutes: this.minutes, pace: this.pace, ai: this.ai, budgetUsd: this.budgetUsd, log: this.log });
    try {
      const link = await copy.build();
      this.copies.set(copy.circleId, { copy, builtAt: Date.now() });
      await this._api('POST', '/demo/copies', { circleId: copy.circleId, link });
      this.log(`demo: a copy is ready (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    } catch (e) {
      this.log(`demo: building a copy failed: ${e.message}`);
      this.copies.delete(copy.circleId);
      if (copy.circleId) await copy.remove();
    }
  }
}

function aiFromEnv(env) {
  if (!env.DEMO_AI_KEY) return null;
  return { provider: env.DEMO_AI_PROVIDER || 'anthropic', model: env.DEMO_AI_MODEL || 'claude-haiku-5-5', apiKey: env.DEMO_AI_KEY, baseUrl: env.DEMO_AI_BASE_URL, inUsd: env.DEMO_AI_IN_USD, outUsd: env.DEMO_AI_OUT_USD };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { env } = process;
  if (!env.DEMO_TOKEN) throw new Error('DEMO_TOKEN is required');
  const server = env.DEMO_SERVER || `http://127.0.0.1:${env.PORT || 8080}`;
  const log = (...args) => console.log(new Date().toISOString(), ...args);
  const director = new Director({ server, token: env.DEMO_TOKEN, pool: num(env.DEMO_POOL, 3), pace: num(env.DEMO_PACE, 1), ai: aiFromEnv(env), budgetUsd: num(env.DEMO_AI_BUDGET_USD, 0.25), log });
  // The server may still be starting.
  for (let i = 0; ; i++) {
    try {
      await director.start();
      break;
    } catch (e) {
      if (i >= 30) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  log(`demo director running against ${server}`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => director.stop().finally(() => process.exit(0)));
}
