// One CircleClient for the whole app (UI and background tasks share it).
import { CircleClient } from '@homecircle/core';
import { secureStorage } from './storage';

let client: CircleClient | null = null;
let loaded: Promise<boolean> | null = null;

export function getClient(): CircleClient {
  if (!client) {
    client = new CircleClient({
      storage: secureStorage,
      onError: (e) => {
        if (__DEV__) console.warn('[homecircle]', e.message);
      },
    });
    client.on('signedOut', () => {
      loaded = null;
    });
  }
  return client;
}

/** Loads the account from secure storage once. Returns whether one exists. */
export function ensureLoaded(): Promise<boolean> {
  const client = getClient();
  // Set up or joined during this session: already in memory.
  if (client.account) return Promise.resolve(true);
  if (!loaded) {
    loaded = client.load().catch(() => false);
  }
  return loaded.then((ok) => {
    // Never cache "no account": the user may set up or join a circle next.
    if (!ok) loaded = null;
    return !!client.account;
  });
}

/** For background tasks: a loaded client, or null if this phone isn't in a circle. */
export async function loadedClient(): Promise<CircleClient | null> {
  return (await ensureLoaded()) ? getClient() : null;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
