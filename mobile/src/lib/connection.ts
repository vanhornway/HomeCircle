// Whether the app can reach its HomeCircle server right now. The UI shows a
// banner instead of failing when it can't, and keeps retrying in the background.
import { useSyncExternalStore } from 'react';

export interface ServerState {
  reachable: boolean;
  error: string | null;
  retrying: boolean;
}

let state: ServerState = { reachable: true, error: null, retrying: false };
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
