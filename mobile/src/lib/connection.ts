// Whether the app can reach its HomeCircle server right now. The UI shows a
// banner instead of failing when it can't, and keeps retrying in the background.
import { useSyncExternalStore } from 'react';

export interface ServerState {
  reachable: boolean;
  error: string | null;
  retrying: boolean;
  /** The server answers but doesn't know this phone in the open circle. */
  unrecognized: boolean;
  /**
   * When the app started reconnecting (after opening or unlocking), while it
   * still is. Errors wait for RECONNECT_GRACE_MS: phones often need a moment.
   */
  reconnectingSince: number | null;
}

/** How long after opening the app a connection problem is "reconnecting", not an error. */
export const RECONNECT_GRACE_MS = 10_000;

let state: ServerState = { reachable: true, error: null, retrying: false, unrecognized: false, reconnectingSince: null };
const subscribers = new Set<() => void>();
let retryHandler: (() => void) | null = null;

export function setServerState(patch: Partial<ServerState>) {
  state = { ...state, ...patch };
  subscribers.forEach((fn) => fn());
}

export function getServerState() {
  return state;
}

export function useServerState(): ServerState {
  return useSyncExternalStore(
    (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    () => state,
  );
}

/** The app shell registers how to reconnect; the banner's Retry button calls it. */
export function setRetryHandler(fn: (() => void) | null) {
  retryHandler = fn;
}

export function retryServer() {
  retryHandler?.();
}

/** Errors that mean "server unreachable" rather than "request rejected". */
export function isUnreachable(e: unknown): boolean {
  const err = e as { code?: string; status?: number } | null;
  if (!err) return false;
  return err.code === 'network' || err.status === 0 || (typeof err.status === 'number' && err.status >= 500);
}
