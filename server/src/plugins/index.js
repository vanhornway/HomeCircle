// Plugins: optional parts of the server that a circle's admins switch on in
// Settings → Features (each plugin is a feature, off until chosen). A plugin
// declares the outside hosts it may call; it gets a fetch that reaches only
// those, and its routes (under /api/v1/plugins/<id>/…) answer only members of
// circles that have it on.
//
// A plugin can also have settings an admin fills in for their circle (a Home
// Assistant address and token, an optional key). They're kept on this server,
// per circle; secrets are never sent back to a phone. A plugin with an
// address in its settings may call that address too, and nothing else new.
import { fail } from '../http.js';
import { air } from './air.js';
import { homeAssistant } from './homeassistant.js';
import { weather } from './weather.js';

export const PLUGINS = [weather, air, homeAssistant];

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10_000;

async function call(fetchImpl, u, { method = 'GET', headers = {}, body } = {}) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(u.toString(), {
      method,
      signal: abort.signal,
      headers: { 'User-Agent': 'HomeCircle (self-hosted family server)', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error(`${u.hostname} sent too much`);
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // not JSON: the status is what counts
    }
    return { status: res.status, ok: res.ok, json };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`${u.hostname} didn’t answer in time`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** A fetch for one plugin: only its declared hosts, 10 seconds, 1 MB, JSON back. */
export function hostFetch(plugin, fetchImpl = fetch) {
  return async (url) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !plugin.hosts.includes(u.hostname)) throw new Error(`${plugin.id} may not call ${u.hostname}`);
    const res = await call(fetchImpl, u);
    if (!res.ok) throw new Error(`${u.hostname} answered ${res.status}`);
    if (res.json == null) throw new Error(`${u.hostname} sent something unexpected`);
    return res.json;
  };
}

/** A fetch to the address an admin gave (http or https), and only there. Answers { status, ok, json }. */
export function addressFetch(base, fetchImpl = fetch) {
  const origin = new URL(base).origin;
  return (url, opts) => {
    const u = new URL(url, base);
    if (u.origin !== origin) throw new Error(`may not call ${u.host}`);
    return call(fetchImpl, u, opts);
  };
}

// Spaces, line breaks and invisible characters that keyboards and copying slip
// into an address or a key: never meant.
const STRAY = /[\s\u00A0\u200B-\u200D\u2060\uFEFF]/g;

/** A value as typed, tidied: a secret or address loses stray characters; an address gets https:// if it has no scheme. */
export function tidy(field, v) {
  if (typeof v !== 'string') return '';
  if (field.secret) return v.replace(STRAY, '').slice(0, 2000);
  if (field.url) {
    const s = v.replace(STRAY, '');
    return s && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? `https://${s}` : s;
  }
  return v.trim().slice(0, 2000);
}

/** What an admin sees of the settings: secrets only as "set". */
function shown(plugin, values) {
  const out = {};
  for (const f of plugin.settings) out[f.id] = f.secret ? (values?.[f.id] ? { set: true } : { set: false }) : (values?.[f.id] ?? '');
  return out;
}

/** Each plugin's routes, behind its feature. */
export function mountPlugins(router, { requireFeature, requireAdmin, store, hub, fetchImpl = fetch, log, version, env = process.env }) {
  for (const p of PLUGINS) {
    const key = (circleId) => `plugin:${circleId}:${p.id}`;
    const read = (circleId) => {
      try {
        return JSON.parse(store.getMeta(key(circleId)) || 'null');
      } catch {
        return null;
      }
    };
    const write = (circleId, value) => store.setMeta(key(circleId), JSON.stringify(value));
    const ctx = { fetch: hostFetch(p, fetchImpl), reach: (base) => addressFetch(base, fetchImpl), log, version };
    const state = p.start?.(ctx) ?? {};
    const gate = (me) => requireFeature(me, p.feature, p.name);

    for (const r of p.routes) {
      router.add(r.method, `/plugins/${p.id}${r.path}`, (req) => {
        gate(req.me);
        const circleId = req.me.circleId;
        return r.handler({ ...req, ...ctx, state, config: read(circleId), updateConfig: (fn) => write(circleId, fn(read(circleId))) });
      });
    }

    if (!p.settings) continue;
    // Settings: admins only. What's shown back never includes a secret.
    router.add('GET', `/plugins/${p.id}/settings`, ({ me }) => {
      gate(me);
      requireAdmin(me);
      const cfg = read(me.circleId);
      return { fields: p.settings, values: shown(p, cfg), ready: !!cfg?.ready, suggested: p.suggest?.(env) ?? {} };
    });
    router.add('PUT', `/plugins/${p.id}/settings`, async ({ me, body }) => {
      gate(me);
      requireAdmin(me);
      const old = read(me.circleId) ?? {};
      const values = {};
      for (const f of p.settings) {
        const v = body?.values?.[f.id];
        // A secret left empty keeps the one saved before.
        if (f.secret && (v === undefined || tidy(f, v) === '')) values[f.id] = old[f.id] ?? '';
        else values[f.id] = tidy(f, v);
        if (!f.optional && !values[f.id]) fail(400, 'invalid', `${f.label} is needed`);
      }
      // The plugin checks them (Home Assistant: does that address and token work?).
      const next = await p.configure(values, { ...ctx, old });
      write(me.circleId, { ...next, ready: true });
      hub.broadcast(me.circleId, { type: 'plugin', id: p.id });
      log(`plugin ${p.id}: settings saved`);
      return { ok: true, values: shown(p, next), ready: true };
    });
  }
}
