// Getting back into a circle with the server's setup code. The request waits
// on the server until a member's phone approves it, which encrypts the circle
// key to this phone; until then this phone keeps the request (and the new
// keys it holds) in secure storage.
import { useCallback, useEffect, useState } from 'react';
import type { CircleClient, PendingRejoin, RejoinRequest } from '@homecircle/core';
import { secureStorage } from './storage';

const PENDING_KEY = 'homecircle.pendingRejoin';

export async function getPendingRejoin(): Promise<PendingRejoin | null> {
  try {
    const raw = await secureStorage.getItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as PendingRejoin) : null;
  } catch {
    return null;
  }
}

export function setPendingRejoin(pending: PendingRejoin) {
  return secureStorage.setItem(PENDING_KEY, JSON.stringify(pending));
}

export function clearPendingRejoin() {
  return secureStorage.removeItem(PENDING_KEY);
}

/** Requests waiting in this circle (none on servers before 0.8). Reloads when they change. */
export function useRejoinRequests(client: CircleClient): [RejoinRequest[], () => void] {
  const [requests, setRequests] = useState<RejoinRequest[]>([]);
  const load = useCallback(() => {
    if (!client.account) return;
    client
      .rejoinRequests()
      .then(setRequests)
      .catch(() => setRequests([]));
  }, [client]);
  useEffect(() => {
    load();
    return client.on('rejoinRequests', load);
  }, [client, load]);
  return [requests, load];
}
