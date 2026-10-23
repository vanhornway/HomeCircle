// Turns what the swarm measured into findings: what broke, what slowed down,
// how much load your Home Assistant handles, and what to do about it. Used by
// the dashboard (live), the HQ circle (alerts) and the Markdown report.

const median = (a) => {
  const s = a.filter((v) => v != null).sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const avg = (a) => {
  const v = a.filter((x) => x != null && Number.isFinite(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
};
const max = (a) => {
  const v = a.filter((x) => x != null && Number.isFinite(x));
  return v.length ? Math.max(...v) : null;
};
const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : null;
};
const r0 = (v) => (v == null ? '–' : Math.round(v).toLocaleString('en-US'));
const r1 = (v) => (v == null ? '–' : (Math.round(v * 10) / 10).toLocaleString('en-US'));
const mins = (ms) => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : ms < 5_400_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);

/** Least-squares line y = a + b·x, with r². */
function fit(points) {
  const n = points.length;
  if (n < 3) return null;
  const mx = points.reduce((s, p) => s + p[0], 0) / n;
  const my = points.reduce((s, p) => s + p[1], 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of points) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  if (!sxx) return null;
  const b = sxy / sxx;
  return { a: my - b * mx, b, r2: syy ? (sxy * sxy) / (sxx * syy) : 0 };
}

/** The run split at each change (mix, speed), with average load and response. */
export function loadSteps(timeline, markers, now = Date.now()) {
  const steps = [];
  for (let i = 0; i < markers.length; i++) {
    const from = markers[i].t;
    const to = markers[i + 1]?.t ?? now;
    // Skip the first 30 s after a change while things settle, if there's enough left.
    const settle = to - from > 90_000 ? 30_000 : 0;
    const s = timeline.filter((x) => x.t >= from + settle && x.t < to);
    if (!s.length) continue;
    steps.push({
      label: markers[i].label,
      from,
      to,
      people: avg(s.map((x) => x.people)),
      online: avg(s.map((x) => x.online)),
      perMin: avg(s.map((x) => x.perMin)),
      p50: median(s.map((x) => x.p50)),
      p95: median(s.map((x) => x.p95)),
      fanoutP95: median(s.map((x) => x.fanoutP95)),
      errorsPerMin: avg(s.map((x) => x.errorsPerMin)),
      addonCpu: avg(s.map((x) => x.addonCpu)),
      addonCpuMax: max(s.map((x) => x.addonCpu)),
      addonMem: avg(s.map((x) => x.addonMem)),
      hostCpu: avg(s.map((x) => x.hostCpu)),
    });
  }
  return steps;
}

const FAIL_HINT = {
  0: {
    level: 'bad',
    what: 'couldn’t reach the server',
    action: 'The server may have restarted (Watchdog), run out of memory, or the network dropped. Check the add-on’s Log tab and Home Assistant’s memory around those times.',
  },
  500: { level: 'bad', what: 'server errors', action: 'Open the add-on’s Log tab and look for “[load-test] … error” lines: they name the failing code.' },
  502: { level: 'bad', what: 'proxy errors (server not answering)', action: 'The server was down or restarting behind Tailscale/the proxy. Check the add-on log for restarts.' },
  503: { level: 'bad', what: 'server unavailable', action: 'The server was overloaded or restarting.' },
  401: { level: 'warn', what: 'signed-out devices', action: 'A simulated phone was removed or the server was reset. Harmless after a reset; otherwise worth a look.' },
  404: { level: 'warn', what: 'not found', action: 'Usually an invite that was already used or expired. Worth a look if it keeps growing.' },
  400: { level: 'warn', what: 'rejected requests', action: 'The server refused something as invalid: probably a bug in the swarm or the app. Note the call and report it.' },
  413: { level: 'warn', what: 'requests too large', action: 'Something sent more data than the server allows.' },
};

/**
 * Findings, most important first: [{ id, level: 'bad'|'warn'|'info'|'good', title, detail, action }].
 * `ctx`: { totals, opTotals, timeline, markers, fanoutAll, ha, speed, counts }.
 */
export function findings(ctx) {
  const { totals, opTotals, timeline, fanoutAll, ha, speed } = ctx;
  const out = [];
  const add = (f) => out.push(f);
  const busy = timeline.filter((x) => x.people > 0);

  // 1. What broke: failed calls by status.
  let failures = 0;
  for (const o of opTotals) {
    for (const [code, n] of Object.entries(o.statuses)) {
      const c = Number(code);
      if (c && (c < 400 || c === 409 || c === 429)) continue;
      failures += n;
      const hint = FAIL_HINT[c] || (c >= 500 ? FAIL_HINT[500] : FAIL_HINT[400]);
      add({
        id: `fail:${o.op}:${c}`,
        level: n < 3 && hint.level === 'bad' ? 'warn' : hint.level,
        title: `${o.op}: ${n} × ${hint.what}${c ? ` (HTTP ${c})` : ''}`,
        detail: `${n} of ${o.n.toLocaleString('en-US')} calls failed.`,
        action: hint.action,
      });
    }
  }
  if (!failures && totals.requests > 200) {
    add({ id: 'no-errors', level: 'good', title: `No errors in ${totals.requests.toLocaleString('en-US')} requests`, detail: 'Every call the simulated phones made succeeded (apart from expected rate limits).' });
  }

  // 2. Rate limits: expected at high speed, but worth knowing.
  for (const o of opTotals) {
    const n = o.statuses[429];
    if (!n) continue;
    const locate = o.op.includes('/locations/request');
    add({
      id: `limit:${o.op}`,
      level: locate ? 'info' : 'warn',
      title: `${o.op}: rate-limited ${n} times`,
      detail: locate
        ? 'The server allows one Locate per minute per pair of people and six per hour. At high speed the swarm asks more often than real people would.'
        : 'The server slowed these down to protect itself.',
      action: locate ? 'Expected; nothing to fix.' : 'If real families would hit this (many people joining from one network), the limit may be too tight.',
    });
  }

  // 3. What slowed down: when response times climbed.
  if (busy.length >= 6) {
    const base = median(busy.slice(0, 3).map((x) => x.p95)) ?? 0;
    const limit = Math.max(300, base * 3);
    const knee = busy.findIndex((x, i) => x.p95 > limit && (busy[i + 1]?.p95 ?? x.p95) > limit);
    const peak = busy.reduce((a, b) => (b.perMin > a.perMin ? b : a));
    if (knee >= 0) {
      const k = busy[knee];
      // If the swarm's own computer was overloaded then, the slowdown is likely ours.
      const ours = k.swarmLagMs > 200 || k.swarmCpu > 90;
      add({
        id: 'latency-knee',
        level: ours ? 'info' : k.p95 > 1000 ? 'bad' : 'warn',
        title: `Responses slowed down at about ${r0(k.people)} people (${r0(k.perMin)} requests/min)`,
        detail:
          `p95 went from ${r0(base)} ms to ${r0(k.p95)} ms${k.addonCpu != null ? ` while HomeCircle’s CPU was ${r1(k.addonCpu)}%` : ''}.` +
          (ours ? ` This computer was overloaded at the same moment (CPU ${r0(k.swarmCpu)}%), so the slowdown is probably the swarm, not Home Assistant.` : ''),
        action: ours
          ? 'Run that load again from two computers, or at a lower speed, to find Home Assistant’s real limit.'
          : 'That’s around your Home Assistant’s comfortable limit at this speed. Check whether CPU or memory peaked at the same moment.',
      });
    } else {
      add({
        id: 'latency-ok',
        level: 'good',
        title: `Responses stayed fast: p95 at most ${r0(max(busy.map((x) => x.p95)))} ms`,
        detail: `Up to ${r0(peak.people)} people and ${r0(peak.perMin)} requests/min at ${speed}× speed.`,
      });
    }
  }

  // 4. Slowest calls.
  const slow = opTotals.filter((o) => o.n >= 20 && o.p95 != null).sort((a, b) => b.p95 - a.p95).slice(0, 3);
  if (slow.length) {
    add({
      id: 'slowest',
      level: slow[0].p95 > 1000 ? 'warn' : 'info',
      title: `Slowest calls: ${slow.map((o) => `${o.op} (p95 ${r0(o.p95)} ms)`).join(', ')}`,
      detail: 'Over the whole run. Location uploads and catch-up fetches (state, messages, locations, places) are what phones do most.',
      action: slow[0].p95 > 1000 ? 'Look at what this call does on the server for large circles; it’s the first place to optimize.' : undefined,
    });
  }

  // 5. Chat delivery over live connections.
  if (fanoutAll.length >= 20) {
    const p95 = pct(fanoutAll, 95);
    add({
      id: 'delivery',
      level: p95 > 5000 ? 'bad' : p95 > 1000 ? 'warn' : 'good',
      title: `Chat messages reached others in ${r0(p95)} ms (p95)`,
      detail: `Measured from sending to arriving on other people’s open apps, ${fanoutAll.length.toLocaleString('en-US')} deliveries.`,
      action: p95 > 1000 ? 'The live connections are falling behind: the server is busy or the network (Tailscale) adds delay.' : undefined,
    });
  }

  // 6. CPU: peak, cost per request, capacity estimate.
  const cpuPts = busy.filter((x) => x.addonCpu != null && x.perMin > 0).map((x) => [x.perMin, x.addonCpu]);
  if (ha?.status !== 'on' && !cpuPts.length) {
    add({ id: 'ha-off', level: 'info', title: 'No CPU or memory findings yet', detail: 'Connect Home Assistant (--ha-url and --ha-token) and enable HomeCircle’s CPU and memory sensors to see them.' });
  } else if (cpuPts.length >= 6) {
    const peak = max(cpuPts.map((p) => p[1]));
    if (peak > 80) {
      add({ id: 'cpu-high', level: 'bad', title: `HomeCircle’s CPU reached ${r1(peak)}%`, detail: 'Near the limit: responses will slow down and Home Assistant itself may lag.', action: 'Lower the load, or give Home Assistant more CPU (a faster machine).' });
    }
    const line = fit(cpuPts);
    const spread = max(cpuPts.map((p) => p[0])) / Math.max(1, Math.min(...cpuPts.map((p) => p[0])));
    if (line && line.b > 0 && line.r2 > 0.3 && spread > 1.5) {
      const reqAt70 = (70 - line.a) / line.b;
      const perPerson = avg(busy.filter((x) => x.people).map((x) => x.perMin / x.people));
      const people = perPerson ? reqAt70 / perPerson : null;
      add({
        id: 'capacity',
        level: 'info',
        title: `Estimated capacity: ~${r0(reqAt70)} requests/min before HomeCircle’s CPU reaches 70%`,
        detail:
          `Each 1,000 requests/min costs about ${r1(line.b * 1000)}% CPU.` +
          (people ? ` That’s roughly ${r0(people)} people at ${speed}× speed, or about ${r0(people * speed)} people living normally (1×).` : '') +
          ' A straight-line estimate: real limits often arrive sooner.',
      });
    } else {
      add({ id: 'capacity-wait', level: 'info', title: `HomeCircle’s CPU peaked at ${r1(peak)}%`, detail: 'For a capacity estimate, change the load during the run (more circles, people or speed) so the swarm sees CPU at several levels.' });
    }
  }

  // 7. Memory: a steady climb under steady load suggests a leak.
  const recent = busy.filter((x) => x.addonMem != null && x.t > Date.now() - 3_600_000);
  if (recent.length >= 120) {
    // ≥ 20 minutes of samples
    const ppl = recent.map((x) => x.people);
    const steady = (Math.max(...ppl) - Math.min(...ppl)) / Math.max(1, Math.max(...ppl)) < 0.1;
    const line = fit(recent.map((x) => [(x.t - recent[0].t) / 3_600_000, x.addonMem]));
    if (steady && line && line.b > 1) {
      add({ id: 'mem-growth', level: 'warn', title: `HomeCircle’s memory keeps growing: +${r1(line.b)}% per hour at steady load`, detail: 'Could be a leak (or caches warming up). Leave it running longer: a leak keeps climbing, a cache levels off.', action: 'If it keeps climbing, note the version and report it with the CSV.' });
    } else if (steady && line) {
      add({ id: 'mem-steady', level: 'good', title: 'HomeCircle’s memory is steady under steady load', detail: `${r1(avg(recent.map((x) => x.addonMem)))}% on average over the last ${mins(recent.at(-1).t - recent[0].t)}.` });
    }
  }
  const hostMemPeak = max(busy.map((x) => x.hostMem));
  if (hostMemPeak > 90) add({ id: 'host-mem', level: 'bad', title: `Home Assistant’s machine memory reached ${r1(hostMemPeak)}%`, detail: 'Add-ons can be killed when memory runs out.', action: 'Lower the load or free memory (other add-ons).' });
  const hostCpuPeak = max(busy.map((x) => x.hostCpu));
  if (hostCpuPeak > 85) add({ id: 'host-cpu', level: 'warn', title: `The whole machine’s CPU reached ${r1(hostCpuPeak)}%`, detail: 'Home Assistant’s own automations and UI may get slow at this load.' });

  // 8. Live connections dropping.
  if (totals.socketDrops) {
    add({
      id: 'drops',
      level: totals.socketDrops > 20 ? 'bad' : 'warn',
      title: `Live connections dropped ${totals.socketDrops} times (${totals.reconnects || 0} reconnected)`,
      detail: 'Open apps lost their connection and had to reconnect and catch up.',
      action: 'Check whether drops line up with CPU peaks or add-on restarts. Through Tailscale Funnel, idle timeouts can also cause them.',
    });
  }

  // 9. Key rotations (people leaving) and joins.
  const rotate = opTotals.find((o) => o.op === 'POST /keys/rotate');
  if (rotate?.n) add({ id: 'rotate', level: rotate.p95 > 1000 ? 'warn' : 'info', title: `${rotate.n} key rotations, p95 ${r0(rotate.p95)} ms`, detail: 'Each time people leave, the circle’s key is re-sealed for everyone left. Bigger circles cost more.' });
  const join = opTotals.find((o) => o.op === 'POST /join');
  if (join?.n >= 10) add({ id: 'join', level: join.p95 > 1000 ? 'warn' : 'info', title: `${join.n} people joined, p95 ${r0(join.p95)} ms per join`, detail: 'How quickly invites are accepted when many people sign up at once.' });

  // 10. Was this computer the bottleneck?
  const strained = timeline.filter((x) => x.swarmLagMs > 200 || x.swarmCpu > 90);
  if (strained.length >= 3) {
    add({
      id: 'swarm-strained',
      level: 'warn',
      title: `This computer was the bottleneck for about ${mins(strained.length * 10_000)}`,
      detail: 'The swarm itself was too busy, so latency in that period is overstated.',
      action: 'Lower --speed or the number of people, or split the swarm across two computers (different --data folders).',
    });
  }

  const order = { bad: 0, warn: 1, info: 2, good: 3 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

const ICON = { bad: '🔴', warn: '🟠', info: '🔵', good: '🟢' };

/** The whole run as Markdown: findings, load steps, calls, activity. */
export function report(ctx) {
  const { totals, opTotals, timeline, markers, server, startedAt, speed, mix, csvPath } = ctx;
  const now = Date.now();
  const f = findings(ctx);
  const steps = loadSteps(timeline, markers, now);
  const L = [];
  L.push(`# HomeCircle load test report`, '');
  L.push(`- **Server:** ${server}`);
  L.push(`- **Run:** ${new Date(startedAt).toLocaleString()} → ${new Date(now).toLocaleString()} (${mins(now - startedAt)})`);
  L.push(`- **Now:** ${ctx.counts.people} people in ${ctx.counts.circles} circles at ${speed}× speed`);
  if (mix) L.push(`- **Mix:** ${mix}`);
  L.push(`- **Requests:** ${totals.requests.toLocaleString('en-US')} · errors ${totals.errors} · rate-limited ${totals.rateLimited}`);
  L.push('');
  L.push('## Findings', '');
  for (const x of f) {
    L.push(`- ${ICON[x.level]} **${x.title}.** ${x.detail}${x.action ? ` *What to do:* ${x.action}` : ''}`);
  }
  L.push('');
  if (steps.length) {
    L.push('## Load steps', '', 'Averages between each change of mix or speed (first 30 s after a change skipped).', '');
    L.push('| From | Change | Length | People | Req/min | p50 ms | p95 ms | Chat p95 ms | Errors/min | HomeCircle CPU % (peak) | Memory % | Host CPU % |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const s of steps) {
      L.push(
        `| ${new Date(s.from).toLocaleTimeString()} | ${s.label} | ${mins(s.to - s.from)} | ${r0(s.people)} | ${r0(s.perMin)} | ${r0(s.p50)} | ${r0(s.p95)} | ${r0(s.fanoutP95)} | ${r1(s.errorsPerMin)} | ${r1(s.addonCpu)} (${r1(s.addonCpuMax)}) | ${r1(s.addonMem)} | ${r1(s.hostCpu)} |`,
      );
    }
    L.push('');
  }
  L.push('## API calls (whole run)', '');
  L.push('| Call | Calls | p50 ms | p95 ms | Failed | Rate-limited |');
  L.push('|---|---|---|---|---|---|');
  for (const o of [...opTotals].sort((a, b) => b.n - a.n)) {
    const failed = Object.entries(o.statuses)
      .filter(([c]) => Number(c) === 0 || (Number(c) >= 400 && ![409, 429].includes(Number(c))))
      .map(([c, n]) => `${n} × ${c === '0' ? 'network' : c}`)
      .join(', ');
    L.push(`| \`${o.op}\` | ${o.n.toLocaleString('en-US')} | ${r0(o.p50)} | ${r0(o.p95)} | ${failed || '0'} | ${o.statuses[429] || 0} |`);
  }
  L.push('');
  L.push('## What the simulated people did', '');
  L.push(
    `${totals.messages} group messages, ${totals.dms} direct messages, ${totals.reactions} reactions, ${totals.locations} location updates, ` +
      `${totals.placeEvents} arrivals/departures, ${totals.locates} Locates, ${totals.checkins} check-ins, ${totals.joins} joins, ${totals.appOpens} app opens, ` +
      `${totals.socketDrops || 0} dropped connections.`,
  );
  L.push('');
  L.push(`Timeline (every 10 s): \`${csvPath}\``, '');
  L.push('> Paste this report (and the CSV, if you like) into a chat with Claude to dig into what to fix first.');
  return L.join('\n');
}
