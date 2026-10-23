// What the swarm measures: every API call's latency and outcome, how long a
// chat message takes to reach the others, and (optionally) Home Assistant's
// CPU and memory sensors. Sampled every 10 s into a timeline and a CSV file.
import { appendFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const SAMPLE_MS = 10_000;
const WINDOW_MS = 60_000; // "per minute" figures use the last minute
const KEEP_SAMPLES = 6 * 360; // 6 hours of 10 s samples

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);
const round = (v, d = 0) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

/** "/api/v1/places/x7Hk2pQ9a" → "PUT /places/:id" */
export function opName(method, url) {
  const path = new URL(url).pathname.replace(/^\/api\/v1/, '');
  // Random ids have capitals, digits, - or _; route words are lowercase.
  return `${method} ${path.replace(/\/(?=[A-Za-z0-9_-]*[A-Z0-9_-])[A-Za-z0-9_-]{8,}(?=\/|$)/g, '/:id')}`;
}

export class Metrics {
  constructor({ csvPath }) {
    this.csvPath = csvPath;
    this.events = []; // { t, op, ms, status }
    this.fanout = []; // { t, ms }
    this.totals = { requests: 0, errors: 0, rateLimited: 0, network: 0, messages: 0, locations: 0, placeEvents: 0, reactions: 0, dms: 0, locates: 0, checkins: 0, joins: 0, appOpens: 0 };
    this.timeline = [];
    this.ha = { url: null, status: 'off', entities: {}, values: {}, hint: null };
    this.counts = () => ({});
    this.lastCpu = process.cpuUsage();
    this.lastCpuAt = Date.now();
    this.started = Date.now();
    this.csvStarted = false;
    this.lag = monitorEventLoopDelay({ resolution: 20 });
    this.lag.enable();
    this.recentErrors = [];
    // Whole-run totals per API call, for the findings report.
    this.ops = new Map(); // op -> { n, statuses: {code: n}, ms: [last 2000] }
    this.fanoutAll = []; // last 5000 chat delivery times
    // What changed when (mix, speed), so the report can compare load steps.
    this.markers = [{ t: Date.now(), label: 'start' }];
  }

  /** A fetch that records every call. `ip` becomes X-Forwarded-For. */
  fetchFor(ip) {
    return async (url, opts = {}) => {
      const op = opName(opts.method || 'GET', url);
      const headers = { ...(opts.headers || {}), 'X-Forwarded-For': ip };
      const t0 = performance.now();
      try {
        let res;
        try {
          res = await fetch(url, { ...opts, headers });
        } catch (e) {
          // A kept-alive connection the server had just closed: phones' HTTP
          // stacks retry these once without the user noticing, so do the same.
          if (!['UND_ERR_SOCKET', 'ECONNRESET'].includes(e.cause?.code)) throw e;
          this.count('retries');
          res = await fetch(url, { ...opts, headers });
        }
        this.record(op, performance.now() - t0, res.status);
        return res;
      } catch (e) {
        this.record(op, performance.now() - t0, 0);
        this.noteError(`${op}: ${e.cause?.code || e.cause?.message || e.message}`);
        throw e;
      }
    };
  }

  record(op, ms, status) {
    this.events.push({ t: Date.now(), op, ms, status });
    let o = this.ops.get(op);
    if (!o) this.ops.set(op, (o = { n: 0, statuses: {}, ms: [] }));
    o.n++;
    o.statuses[status] = (o.statuses[status] || 0) + 1;
    if (status && status < 400) {
      o.ms.push(ms);
      if (o.ms.length > 2000) o.ms.splice(0, o.ms.length - 2000);
    }
    this.totals.requests++;
    if (status === 0) this.totals.network++;
    else if (status === 429) this.totals.rateLimited++;
    // 409s are expected (a place event retried, someone else rotated the key).
    else if (status >= 400 && status !== 409) this.totals.errors++;
  }

  noteError(text) {
    this.recentErrors.push({ t: Date.now(), text });
    if (this.recentErrors.length > 20) this.recentErrors.shift();
  }

  count(kind, n = 1) {
    this.totals[kind] = (this.totals[kind] || 0) + n;
  }

  fanoutMs(ms) {
    if (ms >= 0 && ms < 120_000) {
      this.fanout.push({ t: Date.now(), ms });
      this.fanoutAll.push(ms);
      if (this.fanoutAll.length > 5000) this.fanoutAll.splice(0, this.fanoutAll.length - 5000);
    }
  }

  /** Something changed (mix, speed): the report compares the load before and after. */
  mark(label) {
    this.markers.push({ t: Date.now(), label });
    if (this.markers.length > 200) this.markers.splice(1, 1);
  }

  /** Whole-run per-call figures: calls, p50/p95, failures by status. */
  opTotals() {
    return [...this.ops].map(([op, o]) => {
      const s = [...o.ms].sort((a, b) => a - b);
      return { op, n: o.n, p50: round(pct(s, 50)), p95: round(pct(s, 95)), statuses: o.statuses };
    });
  }

  _trim(now) {
    const cut = now - WINDOW_MS;
    while (this.events.length && this.events[0].t < cut) this.events.shift();
    while (this.fanout.length && this.fanout[0].t < cut) this.fanout.shift();
  }

  /** Figures for the last minute. */
  lastMinute() {
    const now = Date.now();
    this._trim(now);
    const lat = this.events.filter((e) => e.status && e.status < 400).map((e) => e.ms).sort((a, b) => a - b);
    const fan = this.fanout.map((e) => e.ms).sort((a, b) => a - b);
    const byOp = new Map();
    for (const e of this.events) {
      let o = byOp.get(e.op);
      if (!o) byOp.set(e.op, (o = { op: e.op, n: 0, errors: 0, limited: 0, ms: [] }));
      o.n++;
      if (e.status === 429) o.limited++;
      else if (e.status === 0 || (e.status >= 400 && e.status !== 409)) o.errors++;
      o.ms.push(e.ms);
    }
    const ops = [...byOp.values()]
      .map((o) => {
        const s = o.ms.sort((a, b) => a - b);
        return { op: o.op, perMin: o.n, p50: round(pct(s, 50)), p95: round(pct(s, 95)), errors: o.errors, limited: o.limited };
      })
      .sort((a, b) => b.perMin - a.perMin);
    return {
      perMin: this.events.length,
      errorsPerMin: this.events.filter((e) => e.status === 0 || (e.status >= 400 && e.status !== 409 && e.status !== 429)).length,
      limitedPerMin: this.events.filter((e) => e.status === 429).length,
      p50: round(pct(lat, 50)),
      p95: round(pct(lat, 95)),
      p99: round(pct(lat, 99)),
      fanoutP50: round(pct(fan, 50)),
      fanoutP95: round(pct(fan, 95)),
      ops,
    };
  }

  /** The swarm's own CPU (% of one core) and memory, to rule it out as the bottleneck. */
  selfUsage() {
    const now = Date.now();
    const cpu = process.cpuUsage(this.lastCpu);
    const ms = now - this.lastCpuAt || 1;
    this.lastCpu = process.cpuUsage();
    this.lastCpuAt = now;
    // How late timers fire: if this is high, the swarm itself is overloaded
    // and the latencies it measures are inflated.
    const lagMs = round(this.lag.percentile(99) / 1e6);
    this.lag.reset();
    return { cpu: round(((cpu.user + cpu.system) / 1000 / ms) * 100, 1), rssMb: round(process.memoryUsage().rss / 1048576), lagMs, cores: cpus().length };
  }

  start(counts) {
    this.counts = counts;
    this.timer = setInterval(() => this.sample(), SAMPLE_MS);
    this.timer.unref();
  }

  sample() {
    const m = this.lastMinute();
    const c = this.counts();
    const self = this.selfUsage();
    const v = this.ha.values;
    const s = {
      t: Date.now(),
      people: c.people,
      online: c.online,
      circles: c.circles,
      perMin: m.perMin,
      p50: m.p50,
      p95: m.p95,
      p99: m.p99,
      fanoutP95: m.fanoutP95,
      errorsPerMin: m.errorsPerMin,
      limitedPerMin: m.limitedPerMin,
      addonCpu: v.addonCpu ?? null,
      addonMem: v.addonMem ?? null,
      hostCpu: v.hostCpu ?? null,
      hostMem: v.hostMem ?? null,
      hostLoad: v.hostLoad ?? null,
      swarmCpu: self.cpu,
      swarmRssMb: self.rssMb,
      swarmLagMs: self.lagMs,
    };
    this.timeline.push(s);
    if (this.timeline.length > KEEP_SAMPLES) this.timeline.shift();
    this._csv(s);
    return s;
  }

  _csv(s) {
    if (!this.csvPath) return;
    const cols = Object.keys(s);
    if (!this.csvStarted) {
      writeFileSync(this.csvPath, `${['time', ...cols.slice(1)].join(',')}\n`);
      this.csvStarted = true;
    }
    const row = [new Date(s.t).toISOString(), ...cols.slice(1).map((k) => s[k] ?? '')];
    appendFileSync(this.csvPath, `${row.join(',')}\n`);
  }

  // --- Home Assistant ----------------------------------------------------

  /**
   * Find HomeCircle's add-on CPU/memory sensors (Supervisor integration) and
   * the host's (System Monitor), then poll them every 15 s.
   */
  async startHomeAssistant({ url, token, entities = {} }) {
    if (!url || !token) {
      this.ha.status = 'off';
      this.ha.hint = 'Pass --ha-url and --ha-token to chart Home Assistant CPU and memory here.';
      return;
    }
    this.ha.url = url.replace(/\/+$/, '');
    const get = async (path) => {
      const res = await fetch(`${this.ha.url}${path}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Home Assistant answered ${res.status}`);
      return res.json();
    };
    try {
      const states = await get('/api/states');
      const ids = states.map((s) => s.entity_id).filter((id) => id.startsWith('sensor.'));
      const find = (list, ...res) => list.find((id) => res.every((r) => r.test(id))) || null;
      // Other add-ons have CPU and memory sensors too: the host's are the ones
      // that don't belong to any add-on (System Monitor's).
      const host = ids.filter((id) => !id.includes('homecircle') && !/_(cpu|memory)_percent$/.test(id));
      this.ha.entities = {
        addonCpu: entities.addonCpu || find(ids, /homecircle/, /cpu/),
        addonMem: entities.addonMem || find(ids, /homecircle/, /mem/),
        hostCpu: entities.hostCpu || find(host, /processor_use|processor_usage|cpu_usage/),
        hostMem: entities.hostMem || find(host, /memory_use_percent|memory_usage_percent|memory_usage$/),
        hostLoad: entities.hostLoad || find(host, /load_1_?m/),
      };
      const missing = [];
      if (!this.ha.entities.addonCpu || !this.ha.entities.addonMem) {
        missing.push(
          'HomeCircle CPU/memory sensors not found: Settings → Devices & services → Home Assistant Supervisor → HomeCircle device → enable “CPU percent” and “Memory percent”.',
        );
      }
      if (!this.ha.entities.hostCpu) missing.push('Host CPU not found: add the System Monitor integration and enable “Processor use” and “Memory usage”.');
      this.ha.hint = missing.join(' ') || null;
      this.ha.status = 'on';
    } catch (e) {
      this.ha.status = 'error';
      this.ha.hint = `Couldn’t read Home Assistant: ${e.message}. Check --ha-url and the long-lived token.`;
      return;
    }
    const poll = async () => {
      for (const [k, id] of Object.entries(this.ha.entities)) {
        if (!id) continue;
        try {
          const s = await get(`/api/states/${id}`);
          const n = Number.parseFloat(s.state);
          this.ha.values[k] = Number.isFinite(n) ? n : null;
          this.ha.status = 'on';
        } catch (e) {
          this.ha.status = 'error';
          this.ha.hint = `Couldn’t read ${id}: ${e.message}`;
        }
      }
    };
    await poll();
    this.haTimer = setInterval(poll, 15_000);
    this.haTimer.unref();
  }
}
