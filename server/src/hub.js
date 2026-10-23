// WebSocket hub: live updates for apps that are open. Clients authenticate
// with their first frame so the token never appears in a URL or access log.
import { WebSocketServer } from 'ws';
import { sha256 } from './http.js';

export class Hub {
  constructor({ store, log, heartbeatMs = 25000, authTimeoutMs = 10000 }) {
    this.store = store;
    this.authTimeoutMs = authTimeoutMs;
    this.log = log;
    this.sockets = new Map(); // memberId -> Set<WebSocket>
    this.circleOf = new Map(); // memberId -> circleId, for connected members
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
    this.wss.on('connection', (ws) => this._onConnection(ws));
    this.heartbeat = setInterval(() => this._heartbeat(), heartbeatMs);
  }

  attach(server) {
    server.on('upgrade', (req, socket, head) => {
      const path = (req.url || '').split('?')[0];
      if (path !== '/api/v1/ws') {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    });
  }

  _onConnection(ws) {
    ws.isAlive = true;
    // Before auth, protocol pongs count. After auth only the app's own replies do,
    // since a proxy in the middle can answer protocol pings for a dead client.
    ws.on('pong', () => {
      if (!ws.memberId) ws.isAlive = true;
    });
    // Close codes: 4001 only when this server doesn't know the device (removed,
    // or the circle was deleted). Apps from before 0.8 delete their keys on
    // 4001, so a slow or paused phone must never get it: 4000 and 4002 mean
    // "try again".
    const authTimer = setTimeout(() => ws.close(4000, 'auth timeout'), this.authTimeoutMs);
    ws.on('message', (data) => {
      ws.isAlive = true;
      if (ws.memberId) return; // after auth, clients only send heartbeat replies
      clearTimeout(authTimer);
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return ws.close(4002, 'bad auth');
      }
      if (msg?.type !== 'auth' || typeof msg.token !== 'string') return ws.close(4002, 'bad auth');
      const member = this.store.memberByToken(sha256(msg.token));
      if (!member) return ws.close(4001, 'unauthorized');
      ws.memberId = member.id;
      if (!this.sockets.has(member.id)) this.sockets.set(member.id, new Set());
      this.sockets.get(member.id).add(ws);
      this.circleOf.set(member.id, member.circleId);
      this.store.touchMember(member.id, Date.now());
      ws.send(JSON.stringify({ type: 'ready' }));
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      const set = ws.memberId && this.sockets.get(ws.memberId);
      if (set) {
        set.delete(ws);
        if (!set.size) {
          this.sockets.delete(ws.memberId);
          this.circleOf.delete(ws.memberId);
        }
      }
    });
    ws.on('error', () => {});
  }

  _heartbeat() {
    for (const ws of this.wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
      // App-level heartbeat too: clients can't see protocol pings, and proxies or
      // tunnels may answer those themselves while the real path is dead.
      if (ws.memberId && ws.readyState === 1) ws.send('{"type":"ping"}');
    }
  }

  isOnline(memberId) {
    return this.sockets.has(memberId);
  }

  send(memberId, msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.sockets.get(memberId) || []) if (ws.readyState === 1) ws.send(data);
  }

  /** Send to every connected member of one circle. */
  broadcast(circleId, msg, exceptId = null) {
    for (const [id, c] of this.circleOf) if (c === circleId && id !== exceptId) this.send(id, msg);
  }

  disconnect(memberId, code = 4001) {
    for (const ws of this.sockets.get(memberId) || []) ws.close(code, 'removed');
    this.sockets.delete(memberId);
    this.circleOf.delete(memberId);
  }

  close() {
    clearInterval(this.heartbeat);
    for (const ws of this.wss.clients) ws.close(1001, 'server shutting down');
    this.wss.close();
  }
}
