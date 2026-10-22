// The swarm's live dashboard on http://localhost:8090: load, latency, Home
// Assistant CPU/memory, every circle with a QR code to join it, and a feed of
// what the simulated people are doing. Only listens on this computer, since
// the invite links in it are real.
import { createServer } from 'node:http';
import qrcode from 'qrcode-generator';

export async function startDashboard({ port, stats, setSpeed }) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/stats') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(stats()));
      }
      if (url.pathname === '/api/speed' && req.method === 'POST') {
        const s = Number(url.searchParams.get('x'));
        if (Number.isFinite(s) && s > 0) setSpeed(s);
        res.writeHead(204);
        return res.end();
      }
      if (url.pathname === '/qr.svg') {
        const qr = qrcode(0, 'M');
        qr.addData(String(url.searchParams.get('u') || '').slice(0, 1000));
        qr.make();
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
        return res.end(qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true }));
      }
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(PAGE);
      }
      res.writeHead(404);
      res.end();
    } catch (e) {
      res.writeHead(500);
      res.end(String(e.message));
    }
  });
  for (let p = port; p < port + 20; p++) {
    const ok = await new Promise((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(p, '127.0.0.1', () => resolve(true));
    });
    if (ok) return { port: p, close: () => server.close() };
  }
  throw new Error(`No free port from ${port}`);
}

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HomeCircle swarm</title>
<style>
:root {
  --bg: #f6f7f5; --card: #ffffff; --ink: #18211e; --muted: #66706c; --line: #e3e7e4;
  --brand: #2f7d6d; --s1: #2f7d6d; --s2: #d0822b; --s3: #6a5acd; --bad: #c2412d; --warn: #b7791f;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #111614; --card: #1a201e; --ink: #e8ecea; --muted: #97a29e; --line: #2a322f;
    --brand: #5fb8a3; --s1: #5fb8a3; --s2: #e9a35a; --s3: #a99cf0; --bad: #ef7b67; --warn: #e3b55c; color-scheme: dark; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1240px; margin: 0 auto; padding: 20px 16px 48px; }
header { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; margin-bottom: 16px; }
h1 { font-size: 20px; margin: 0; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0 0 10px; font-weight: 600; }
.sub { color: var(--muted); }
.pill { padding: 2px 10px; border-radius: 999px; background: color-mix(in srgb, var(--brand) 14%, transparent); color: var(--brand); font-weight: 600; font-size: 12px; }
.speed { margin-left: auto; display: flex; gap: 4px; align-items: center; }
.speed button { border: 1px solid var(--line); background: var(--card); color: var(--ink); border-radius: 8px; padding: 4px 10px; cursor: pointer; font: inherit; }
.speed button.on { border-color: var(--brand); color: var(--brand); font-weight: 700; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 14px; }
.kpi, .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; }
.kpi { padding: 12px 14px; }
.kpi .v { font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; }
.kpi .l { color: var(--muted); font-size: 12px; }
.kpi .d { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.hint { background: color-mix(in srgb, var(--warn) 14%, var(--card)); border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent); border-radius: 12px; padding: 10px 14px; margin-bottom: 14px; }
.charts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-bottom: 14px; }
@media (max-width: 760px) { .charts { grid-template-columns: 1fr; } }
.scroll { max-height: 560px; overflow-y: auto; }
.card { padding: 14px 16px; min-width: 0; }
.legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--muted); margin: -4px 0 6px; }
.legend i { display: inline-block; width: 10px; height: 3px; border-radius: 2px; margin-right: 5px; vertical-align: middle; }
svg.chart { width: 100%; height: 180px; display: block; overflow: visible; }
svg.chart text { fill: var(--muted); font-size: 11px; }
.grid2 { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 12px; }
@media (max-width: 900px) { .grid2 { grid-template-columns: 1fr; } }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 7px 6px; border-bottom: 1px solid var(--line); vertical-align: middle; }
th { color: var(--muted); font-weight: 600; font-size: 12px; }
td.n, th.n { text-align: right; }
.table-wrap { overflow-x: auto; }
.btn { border: 1px solid var(--brand); color: var(--brand); background: transparent; border-radius: 8px; padding: 3px 10px; cursor: pointer; font: inherit; font-size: 12px; font-weight: 600; }
.ok { color: var(--brand); font-weight: 600; }
.feed { list-style: none; margin: 0; padding: 0; max-height: 520px; overflow-y: auto; }
.feed li { padding: 6px 0; border-bottom: 1px solid var(--line); }
.feed .c { color: var(--muted); font-size: 12px; }
.feed .you { color: var(--s3); font-weight: 600; }
.bad { color: var(--bad); }
dialog { border: 1px solid var(--line); border-radius: 16px; background: var(--card); color: var(--ink); padding: 20px; max-width: min(92vw, 420px); }
dialog::backdrop { background: rgb(0 0 0 / .45); }
dialog img { width: 100%; background: #fff; border-radius: 10px; }
dialog code { display: block; word-break: break-all; font-size: 11px; color: var(--muted); margin: 10px 0; }
.foot { color: var(--muted); font-size: 12px; margin-top: 16px; }
</style>
</head>
<body>
<main>
  <header>
    <h1>HomeCircle swarm</h1>
    <span class="pill" id="phase">starting</span>
    <span class="sub" id="where"></span>
    <div class="speed" id="speed"><span class="sub">Speed</span></div>
  </header>
  <div id="hint" class="hint" hidden></div>
  <section class="kpis" id="kpis"></section>
  <section class="charts">
    <div class="card"><h2>Home Assistant CPU</h2><div class="legend" id="lg-cpu"></div><svg class="chart" id="ch-cpu"></svg></div>
    <div class="card"><h2>Home Assistant memory</h2><div class="legend" id="lg-mem"></div><svg class="chart" id="ch-mem"></svg></div>
    <div class="card"><h2>Requests per minute</h2><div class="legend" id="lg-req"></div><svg class="chart" id="ch-req"></svg></div>
    <div class="card"><h2>Latency</h2><div class="legend" id="lg-lat"></div><svg class="chart" id="ch-lat"></svg></div>
  </section>
  <section class="grid2">
    <div>
      <div class="card" style="margin-bottom:12px"><h2>Circles · join them from your phone</h2><div class="table-wrap scroll"><table id="circles"></table></div></div>
      <div class="card"><h2>API calls, last minute</h2><div class="table-wrap"><table id="ops"></table></div></div>
    </div>
    <div class="card"><h2>What people are doing</h2><ul class="feed" id="feed"></ul></div>
  </section>
  <p class="foot" id="foot"></p>
</main>
<dialog id="qr">
  <h2 id="qr-title" style="color:var(--ink);text-transform:none;font-size:16px;letter-spacing:0"></h2>
  <p class="sub" style="margin-top:0">In the HomeCircle app: <b>Join my family</b> → scan this code. Or copy the link to your phone.</p>
  <img id="qr-img" alt="Invite QR code">
  <code id="qr-link"></code>
  <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" id="qr-copy">Copy link</button><button class="btn" id="qr-close">Close</button></div>
</dialog>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = (v, d = 0) => (v == null ? '–' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d }));
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const ago = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? s + 's' : s < 3600 ? Math.round(s / 60) + 'm' : (s / 3600).toFixed(1) + 'h'; };
let speeds = [1, 5, 20, 50];
let current = null;

function niceMax(v) {
  if (!v || v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 4, 5, 10].map((m) => m * p).find((m) => m >= v);
}
// 4 gridlines for 2 or 4 (…×10ⁿ), 5 for 1 or 5: round numbers either way.
const divisions = (max) => (/^[24]/.test(String(max / 10 ** Math.floor(Math.log10(max)))) ? 4 : 5);

function chart(id, legendId, tl, series, unit, fixedMax) {
  const svg = $(id);
  const W = svg.clientWidth || 500, H = 180, L = 40, R = 8, T = 8, B = 20;
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  $(legendId).innerHTML = series.map((s) => {
    const last = [...tl].reverse().find((p) => p[s.key] != null);
    return '<span><i style="background:' + css(s.color) + '"></i>' + esc(s.name) + ' <b style="color:var(--ink)">' + (last ? fmt(last[s.key], 1) + unit : '–') + '</b></span>';
  }).join('');
  if (tl.length < 2) { svg.innerHTML = '<text x="' + L + '" y="' + H / 2 + '">Collecting… first points in about 10 seconds</text>'; return; }
  const t0 = tl[0].t, t1 = tl[tl.length - 1].t;
  const vals = series.flatMap((s) => tl.map((p) => p[s.key]).filter((v) => v != null));
  const max = fixedMax || niceMax(Math.max(...vals, 0) * 1.1);
  const X = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const Y = (v) => T + (1 - v / max) * (H - T - B);
  let out = '';
  const div = divisions(max);
  for (let i = 0; i <= div; i++) {
    const v = (max / div) * i, y = Y(v);
    out += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '" stroke="' + css('--line') + '"/>';
    out += '<text x="' + (L - 6) + '" y="' + (y + 4) + '" text-anchor="end">' + fmt(v, max < 5 ? 1 : 0) + '</text>';
  }
  out += '<text x="' + L + '" y="' + (H - 4) + '">' + new Date(t0).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '</text>';
  out += '<text x="' + (W - R) + '" y="' + (H - 4) + '" text-anchor="end">' + new Date(t1).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '</text>';
  for (const s of series) {
    let d = '', pen = false;
    for (const p of tl) {
      if (p[s.key] == null) { pen = false; continue; }
      d += (pen ? 'L' : 'M') + X(p.t).toFixed(1) + ' ' + Y(p[s.key]).toFixed(1);
      pen = true;
    }
    out += '<path d="' + d + '" fill="none" stroke="' + css(s.color) + '" stroke-width="2" stroke-linejoin="round"/>';
  }
  svg.innerHTML = out;
}

function render(s) {
  current = s;
  const m = s.lastMinute, c = s.counts, v = s.ha.values || {}, t = s.totals;
  $('phase').textContent = s.phase;
  $('where').textContent = s.server + ' · ' + s.scale + ' · running ' + ago(s.now - s.startedAt);
  $('speed').innerHTML = '<span class="sub">Speed</span>' + speeds.map((x) => '<button class="' + (x === s.speed ? 'on' : '') + '" data-x="' + x + '">' + x + '×</button>').join('');
  const last = s.timeline[s.timeline.length - 1] || {};
  const hints = [];
  if (last.swarmLagMs > 200 || last.swarmCpu > 90) hints.push('This computer is too busy running the swarm (CPU ' + fmt(last.swarmCpu) + '%, timers ' + fmt(last.swarmLagMs) + ' ms late), so measured latency is inflated. Lower the speed or scale, or run a second swarm on another computer.');
  if (s.ha.hint) hints.push(s.ha.hint);
  if (s.recentErrors.length && s.now - s.recentErrors[0].t < 60000) hints.push('Recent connection errors: ' + s.recentErrors.map((e) => e.text).join(' · '));
  $('hint').hidden = !hints.length;
  $('hint').innerHTML = hints.map(esc).join('<br>');
  const k = [
    ['People', fmt(c.people), fmt(c.online) + ' with the app open · ' + c.circles + ' circles'],
    ['Requests / min', fmt(m.perMin), fmt(t.requests) + ' total'],
    ['Latency p95', fmt(m.p95) + ' ms', 'p50 ' + fmt(m.p50) + ' · p99 ' + fmt(m.p99) + ' ms'],
    ['Chat delivery p95', fmt(m.fanoutP95) + ' ms', 'send → others see it'],
    ['Errors / min', '<span class="' + (m.errorsPerMin ? 'bad' : '') + '">' + fmt(m.errorsPerMin) + '</span>', fmt(m.limitedPerMin) + ' rate-limited · ' + fmt(t.errors) + ' total'],
    ['HomeCircle CPU', v.addonCpu != null ? fmt(v.addonCpu, 1) + '%' : '–', 'host ' + (v.hostCpu != null ? fmt(v.hostCpu, 1) + '%' : '–') + (v.hostLoad != null ? ' · load ' + fmt(v.hostLoad, 2) : '')],
    ['HomeCircle memory', v.addonMem != null ? fmt(v.addonMem, 1) + '%' : '–', 'host ' + (v.hostMem != null ? fmt(v.hostMem, 1) + '%' : '–')],
  ];
  $('kpis').innerHTML = k.map(([l, val, d]) => '<div class="kpi"><div class="l">' + l + '</div><div class="v">' + val + '</div><div class="d">' + d + '</div></div>').join('');
  const tl = s.timeline;
  chart('ch-cpu', 'lg-cpu', tl, [{ key: 'addonCpu', name: 'HomeCircle add-on', color: '--s1' }, { key: 'hostCpu', name: 'Whole machine', color: '--s2' }, { key: 'swarmCpu', name: 'Swarm (this computer)', color: '--s3' }], '%');
  chart('ch-mem', 'lg-mem', tl, [{ key: 'addonMem', name: 'HomeCircle add-on', color: '--s1' }, { key: 'hostMem', name: 'Whole machine', color: '--s2' }], '%');
  chart('ch-req', 'lg-req', tl, [{ key: 'perMin', name: 'Requests/min', color: '--s1' }], '');
  chart('ch-lat', 'lg-lat', tl, [{ key: 'p50', name: 'p50', color: '--s1' }, { key: 'p95', name: 'p95', color: '--s2' }, { key: 'fanoutP95', name: 'Chat delivery p95', color: '--s3' }], ' ms');

  const rows = [{ name: s.hq.name, label: 'Swarm status (send “status”)', people: 1, online: 1, messages: null, invite: s.hq.invite, you: s.hq.joined ? ['you'] : [], active: true }, ...s.circles];
  $('circles').innerHTML = '<tr><th>Circle</th><th>Kind</th><th class="n">People</th><th class="n">App open</th><th class="n">Messages</th><th>You</th></tr>' +
    rows.map((r, i) => '<tr><td>' + esc(r.name) + (r.active ? '' : ' <span class="sub">(starting)</span>') + '</td><td class="sub">' + esc(r.label) + '</td><td class="n">' + fmt(r.people) + '</td><td class="n">' + fmt(r.online) + '</td><td class="n">' + fmt(r.messages) + '</td><td>' +
      (r.you.length ? '<span class="ok">✓ joined</span>' : r.invite ? '<button class="btn" data-i="' + i + '">Join</button>' : '<span class="sub">…</span>') + '</td></tr>').join('');
  $('circles').querySelectorAll('button[data-i]').forEach((b) => (b.onclick = () => openQr(rows[b.dataset.i])));

  $('ops').innerHTML = '<tr><th>Call</th><th class="n">/min</th><th class="n">p50 ms</th><th class="n">p95 ms</th><th class="n">Errors</th><th class="n">429</th></tr>' +
    m.ops.map((o) => '<tr><td><code>' + esc(o.op) + '</code></td><td class="n">' + fmt(o.perMin) + '</td><td class="n">' + fmt(o.p50) + '</td><td class="n">' + fmt(o.p95) + '</td><td class="n ' + (o.errors ? 'bad' : '') + '">' + fmt(o.errors) + '</td><td class="n">' + fmt(o.limited) + '</td></tr>').join('');

  $('feed').innerHTML = s.feed.map((f) => '<li><span class="' + (f.kind === 'you' ? 'you' : '') + '">' + esc(f.who) + '</span>' + (f.kind === 'chat' || f.kind === 'you' ? ': ' : ' ') + esc(f.text) +
    '<div class="c">' + esc(f.circle) + ' · ' + ago(s.now - f.t) + ' ago</div></li>').join('') || '<li class="sub">Nothing yet</li>';
  $('foot').textContent = 'Timeline CSV: ' + s.csvPath + (s.inviteServer ? ' · invite links use ' + s.inviteServer : '');
}

function openQr(r) {
  $('qr-title').textContent = 'Join “' + r.name + '”';
  $('qr-img').src = '/qr.svg?u=' + encodeURIComponent(r.invite);
  $('qr-link').textContent = r.invite;
  $('qr-copy').onclick = () => navigator.clipboard.writeText(r.invite).then(() => ($('qr-copy').textContent = 'Copied'));
  $('qr-copy').textContent = 'Copy link';
  $('qr').showModal();
}
$('qr-close').onclick = () => $('qr').close();
$('speed').addEventListener('click', (e) => {
  const x = e.target.dataset?.x;
  if (x) fetch('/api/speed?x=' + x, { method: 'POST' }).then(tick);
});

async function tick() {
  try { render(await (await fetch('/api/stats')).json()); }
  catch { $('phase').textContent = 'swarm stopped'; }
}
tick();
setInterval(tick, 3000);
addEventListener('resize', () => current && render(current));
</script>
</body>
</html>`;
