// Plugins: optional parts of the server that a circle's admins switch on in
// Settings → Features (each plugin is a feature, off until chosen). A plugin
// declares the outside hosts it may call; it gets a fetch that reaches only
// those, and its routes (under /api/v1/plugins/<id>/…) answer only members of
// circles that have it on.
import { weather } from './weather.js';

export const PLUGINS = [weather];

const MAX_BYTES = 1024 * 1024;

/** A fetch for one plugin: only its declared hosts, 10 seconds, 1 MB, JSON back. */
export function hostFetch(plugin, fetchImpl = fetch) {
  return async (url) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !plugin.hosts.includes(u.hostname)) throw new Error(`${plugin.id} may not call ${u.hostname}`);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10_000);
    try {
      const res = await fetchImpl(u.toString(), { signal: abort.signal, headers: { 'User-Agent': 'HomeCircle (self-hosted family server)' } });
      if (!res.ok) throw new Error(`${u.hostname} answered ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new Error(`${u.hostname} sent too much`);
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Each plugin's routes, behind its feature. */
export function mountPlugins(router, { requireFeature, fetchImpl, log }) {
  for (const p of PLUGINS) {
    const ctx = { fetch: hostFetch(p, fetchImpl), log };
    const state = p.start?.(ctx) ?? {};
    for (const r of p.routes) {
      router.add(r.method, `/plugins/${p.id}${r.path}`, (req) => {
        requireFeature(req.me, p.feature, p.name);
        return r.handler({ ...req, ...ctx, state });
      });
    }
  }
}
