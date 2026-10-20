// Thin HTTP + WebSocket client for a HomeCircle server.

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code || `HTTP ${status}`);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

export class Api {
  constructor(baseUrl, { token = null, fetchImpl, WebSocketImpl } = {}) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    this.WebSocket = WebSocketImpl || globalThis.WebSocket;
  }

  async req(method, path, body) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let res;
    try {
      res = await this.fetch(`${this.baseUrl}/api/v1${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
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
  postMessage = (id, env, { silent = false } = {}) => this.req('POST', '/messages', { id, ...env, silent });
  places = () => this.req('GET', '/places');
  putPlace = (id, env) => this.req('PUT', `/places/${encodeURIComponent(id)}`, env);
  deletePlace = (id) => this.req('DELETE', `/places/${encodeURIComponent(id)}`);
  putCircle = (env) => this.req('PUT', '/circle', env);

  /**
   * Live connection while the app is open. Reconnects with backoff.
   * The server sends a heartbeat every ~25 s; if nothing arrives for
   * `staleMs` the socket is treated as dead (proxies and tunnels can drop a
   * connection without either side seeing a close) and replaced.
   * Returns { close() }.
   */
  connect({ onEvent, onStatus = () => {}, staleMs = 70000, checkMs = 10000 }) {
    const wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}/api/v1/ws`;
    let ws = null;
    let closed = false;
    let attempt = 0;
    let timer = null;
    let lastHeard = 0;

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
        scheduleReconnect(Math.min(30000, 1000 * 2 ** attempt++) * (0.75 + Math.random() / 2));
      };
      socket.onerror = () => {};
    };

    const watchdog = setInterval(() => {
      if (closed || !ws || Date.now() - lastHeard < staleMs) return;
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
