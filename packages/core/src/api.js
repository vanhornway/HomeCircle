// Thin HTTP + WebSocket client for a HomeCircle server.

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code || `HTTP ${status}`);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

// A request that hasn't answered in this long is given up on (a dead mobile
// connection can otherwise hang for minutes), and the caller can try again.
const REQUEST_TIMEOUT_MS = 20_000;
// Files can be big and networks slow: longer.
const BYTES_TIMEOUT_MS = 120_000;

/** fetch, given up after `ms` (the error says so). */
async function timed(fetchFn, url, init, ms) {
  const abort = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = abort ? setTimeout(() => abort.abort(), ms) : null;
  try {
    return await fetchFn(url, abort ? { ...init, signal: abort.signal } : init);
  } catch (e) {
    if (abort?.signal.aborted) throw new Error(`No answer in ${Math.round(ms / 1000)} s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export class Api {
  constructor(baseUrl, { token = null, fetchImpl, binaryFetchImpl, WebSocketImpl } = {}) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    // For files: a fetch that sends and reads raw bytes (React Native's own can't).
    this.binaryFetch = binaryFetchImpl || this.fetch;
    this.WebSocket = WebSocketImpl || globalThis.WebSocket;
  }

  /** Send bytes and/or get bytes back (encrypted files). JSON answers are parsed. */
  async bytes(method, path, body) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/octet-stream';
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let res;
    try {
      res = await timed(this.binaryFetch, `${this.baseUrl}/api/v1${path}`, { method, headers, body }, BYTES_TIMEOUT_MS);
    } catch (e) {
      throw new ApiError(0, 'network', "Can't reach the server. Check the address and your internet connection.", { detail: e.message });
    }
    const type = res.headers.get('content-type') || '';
    if (res.ok && type.startsWith('application/octet-stream')) return new Uint8Array(await res.arrayBuffer());
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error page from a proxy */
    }
    if (!res.ok) throw new ApiError(res.status, data?.error, data?.message || `Server error ${res.status}`, data || {});
    return data;
  }

  async req(method, path, body) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let res;
    try {
      res = await timed(this.fetch, `${this.baseUrl}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, REQUEST_TIMEOUT_MS);
    } catch (e) {
      throw new ApiError(0, 'network', "Can't reach the server. Check the address and your internet connection.", {
        detail: e.message,
      });
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error page from a proxy */
    }
    if (!res.ok) {
      // 502/503/504 without our JSON body come from a proxy or tunnel in front of a stopped server.
      const fallback = [502, 503, 504].includes(res.status)
        ? "The server isn't responding right now. It may be down or restarting."
        : `Server error ${res.status}`;
      throw new ApiError(res.status, data?.error, data?.message || fallback, data || {});
    }
    return data;
  }

  info = () => this.req('GET', '/info');
  setup = (body) => this.req('POST', '/setup', body);
  /** Server admins only: create another circle on this server. */
  createCircle = (body) => this.req('POST', '/circles', body);
  deleteCircle = () => this.req('DELETE', '/circle');
  joinPreview = (body) => this.req('POST', '/join/preview', body);
  join = (body) => this.req('POST', '/join', body);
  state = () => this.req('GET', '/state');
  putProfile = (profile) => this.req('PUT', '/members/me/profile', { profile });
  putPush = (token, platform) => this.req('PUT', '/members/me/push', { token, platform });
  removeMember = (id) => this.req('DELETE', `/members/${encodeURIComponent(id)}`);
  setRole = (id, role) => this.req('POST', `/members/${encodeURIComponent(id)}/role`, { role });
  createInvite = (body) => this.req('POST', '/invites', body);
  listInvites = () => this.req('GET', '/invites');
  deleteInvite = (id) => this.req('DELETE', `/invites/${encodeURIComponent(id)}`);
  rotate = (body) => this.req('POST', '/keys/rotate', body);
  envelopes = (since = 0) => this.req('GET', `/keys/envelopes?since=${since}`);
  locations = () => this.req('GET', '/locations');
  putLocation = (env) => this.req('PUT', '/locations/me', env);
  deleteLocation = () => this.req('DELETE', '/locations/me');
  requestLocations = (targets) => this.req('POST', '/locations/request', { targets });
  messages = (after = 0, limit = 200) => this.req('GET', `/messages?after=${after}&limit=${limit}`);
  postMessage = (id, env, { silent = false, to = null, urgent = false } = {}) => this.req('POST', '/messages', { id, ...env, silent, ...(to ? { to } : {}), ...(urgent ? { urgent: true } : {}) });
  putRetention = (days) => this.req('PUT', '/circle/retention', { days });
  putFeatures = (features) => this.req('PUT', '/circle/features', { features });
  places = () => this.req('GET', '/places');
  putPlace = (id, env) => this.req('PUT', `/places/${encodeURIComponent(id)}`, env);
  deletePlace = (id) => this.req('DELETE', `/places/${encodeURIComponent(id)}`);
  putCircle = (env) => this.req('PUT', '/circle', env);
  frequent = () => this.req('GET', '/frequent');
  putFrequent = (env) => this.req('PUT', '/frequent/me', env);
  deleteFrequent = () => this.req('DELETE', '/frequent/me');
  chirp = (body) => this.req('POST', '/chirps', body);
  agentHost = () => this.req('GET', '/agent-host');
  agentSetup = (body) => this.req('POST', '/agent-host/setup', body);
  uploadFile = (bytes) => this.bytes('POST', '/files', bytes);
  downloadFile = (id) => this.bytes('GET', `/files/${encodeURIComponent(id)}`);
  deleteFile = (id) => this.req('DELETE', `/files/${encodeURIComponent(id)}`);
  keepFile = (id) => this.req('POST', `/files/${encodeURIComponent(id)}/keep`);
  /** The weather plugin: only a grid cell is sent (rounded here too, to 0.1°). */
  weather = (lat, lng) => this.req('GET', `/plugins/weather/now?lat=${Math.round(lat * 10) / 10}&lng=${Math.round(lng * 10) / 10}`);
  /** Air and pollen, the same way. */
  air = (lat, lng) => this.req('GET', `/plugins/air/now?lat=${Math.round(lat * 10) / 10}&lng=${Math.round(lng * 10) / 10}`);
  /** The prayer times plugin: today's and tomorrow's times at a grid cell, for a madhab. */
  prayer = (lat, lng, madhab) => this.req('GET', `/plugins/prayer/times?lat=${Math.round(lat * 10) / 10}&lng=${Math.round(lng * 10) / 10}&madhab=${encodeURIComponent(madhab)}`);
  /** A plugin's settings for this circle (admins): secrets come back only as { set }. */
  pluginSettings = (id) => this.req('GET', `/plugins/${encodeURIComponent(id)}/settings`);
  putPluginSettings = (id, values) => this.req('PUT', `/plugins/${encodeURIComponent(id)}/settings`, { values });
  /** Your position, for your device in the circle's Home Assistant. */
  homeAssistantLocation = (body) => this.req('POST', '/plugins/homeAssistant/location', body);
  chirps = () => this.req('GET', '/chirps');
  // Recovery with the setup code (no account needed), and rejoin requests.
  recover = (setupToken) => this.req('POST', '/recover', { setupToken });
  recoverDelete = (setupToken, circleId) => this.req('POST', '/recover/delete', { setupToken, circleId });
  requestRejoin = (body) => this.req('POST', '/recover/rejoin', body);
  rejoinStatus = (body) => this.req('POST', '/recover/rejoin/status', body);
  completeRejoin = (body) => this.req('POST', '/recover/rejoin/complete', body);
  rejoinRequests = () => this.req('GET', '/rejoin-requests');
  approveRejoin = (id, body) => this.req('POST', `/rejoin-requests/${encodeURIComponent(id)}/approve`, body);
  denyRejoin = (id) => this.req('POST', `/rejoin-requests/${encodeURIComponent(id)}/deny`);

  /**
   * Live connection while the app is open. Reconnects with backoff.
   * The server sends a heartbeat every ~25 s; if nothing arrives for
   * `staleMs` the socket is treated as dead (proxies and tunnels can drop a
   * connection without either side seeing a close) and replaced.
   * A socket that isn't ready within `openMs` (stuck connecting on a bad
   * network) is replaced too. Retries back off up to 15 s.
   * Returns { close() }.
   */
  connect({ onEvent, onStatus = () => {}, staleMs = 70000, checkMs = 5000, openMs = 15000 }) {
    const wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}/api/v1/ws`;
    let ws = null;
    let closed = false;
    let attempt = 0;
    let timer = null;
    let lastHeard = 0;
    let ready = false;
    let openedAt = 0;

    const scheduleReconnect = (delay) => {
      clearTimeout(timer);
      timer = setTimeout(open, delay);
    };

    const drop = (socket) => {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    };

    const open = () => {
      if (closed) return;
      onStatus('connecting');
      const socket = new this.WebSocket(wsUrl);
      ws = socket;
      lastHeard = Date.now();
      openedAt = Date.now();
      ready = false;
      socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', token: this.token }));
      socket.onmessage = (e) => {
        lastHeard = Date.now();
        let msg;
        try {
          msg = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data));
        } catch {
          return;
        }
        if (msg.type === 'ready') {
          attempt = 0;
          ready = true;
          onStatus('online');
        } else if (msg.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong' }));
        } else {
          onEvent(msg);
        }
      };
      socket.onclose = (e) => {
        if (ws === socket) ws = null;
        if (closed) return;
        if (e && e.code === 4001) {
          onStatus('unauthorized');
          return;
        }
        onStatus('offline');
        scheduleReconnect(Math.min(15000, 1000 * 2 ** attempt++) * (0.75 + Math.random() / 2));
      };
      socket.onerror = () => {};
    };

    const watchdog = setInterval(() => {
      if (closed || !ws) return;
      const stuck = !ready && Date.now() - openedAt > openMs;
      if (!stuck && Date.now() - lastHeard < staleMs) return;
      // Silent connection: replace it now rather than waiting for a close that may never come.
      drop(ws);
      ws = null;
      onStatus('offline');
      scheduleReconnect(1000);
    }, checkMs);

    open();
    return {
      close() {
        closed = true;
        clearTimeout(timer);
        clearInterval(watchdog);
        if (ws) drop(ws);
        ws = null;
      },
    };
  }
}
