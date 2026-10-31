// Call signals (voice calls, docs/CALLS-PLAN.md): sealed envelopes relayed from
// one member to another. They are never written to the database, a file or a
// log; a signal for a phone with no open connection waits here, in memory,
// for a short while (long enough to wake a sleeping phone) and is then gone.

/** STUN servers apps use when the server doesn't say (CALLS_STUN overrides). */
export const DEFAULT_STUN = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'];

export class CallRelay {
  constructor({ holdMs = 45_000, perMember = 64, total = 2000 } = {}) {
    this.holdMs = holdMs;
    this.perMember = perMember;
    this.total = total;
    this.held = new Map(); // memberId -> [{ from, id, env, at }]
    this.count = 0;
  }

  /** Keep a signal for a member who isn't connected. False if it was dropped (full). */
  hold(toId, signal, now = Date.now()) {
    this._expire(toId, now);
    const list = this.held.get(toId) || [];
    if (list.length >= this.perMember || this.count >= this.total) return false;
    list.push({ ...signal, at: now });
    this.held.set(toId, list);
    this.count++;
    return true;
  }

  /** What is waiting for a member, oldest first. Taking it removes it. */
  take(toId, now = Date.now()) {
    this._expire(toId, now);
    const list = this.held.get(toId) || [];
    this.held.delete(toId);
    this.count -= list.length;
    return list;
  }

  /** Drop a member's waiting signals (they were removed, or the circle was deleted). */
  clear(toId) {
    this.count -= (this.held.get(toId) || []).length;
    this.held.delete(toId);
  }

  /** Forget everything that waited too long. */
  sweep(now = Date.now()) {
    for (const id of [...this.held.keys()]) this._expire(id, now);
  }

  _expire(toId, now) {
    const list = this.held.get(toId);
    if (!list) return;
    const fresh = list.filter((s) => now - s.at < this.holdMs);
    this.count -= list.length - fresh.length;
    if (fresh.length) this.held.set(toId, fresh);
    else this.held.delete(toId);
  }
}
