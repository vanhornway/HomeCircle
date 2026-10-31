// The circles this phone belongs to. Each circle has its own CircleClient,
// keys and account (stored under its own key); the UI shows one "active"
// circle at a time, and background tasks work across all of them.
import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetch as expoFetch } from 'expo/fetch';
import { ACCOUNT_KEY, CircleClient } from '@homecircle/core';
import { diag } from './diagnostics';
import { mark } from './startup';
import { messageCache } from './messageCache';
import { secureStorage } from './storage';

const LIST_KEY = 'homecircle.circles';
const ACTIVE_KEY = 'homecircle.activeCircle';

const clients = new Map<string, CircleClient>(); // accountKey -> client
let active: string | null = null;
let loading: Promise<void> | null = null;
let loaded = false;
let draft: CircleClient | null = null;
let version = 0;
const subs = new Set<() => void>();

function changed() {
  version++;
  subs.forEach((fn) => fn());
}

function makeClient(accountKey: string): CircleClient {
  const client = new CircleClient({
    storage: secureStorage,
    // Opened messages, kept between launches (a cold start opens only what's new).
    cache: messageCache,
    accountKey,
    // Files for the helper go up and down as raw bytes, which React Native's own fetch can't do.
    binaryFetchImpl: expoFetch,
    onError: (e) => {
      if (__DEV__) console.warn('[homecircle]', e.message);
    },
  });
  // Signed out, left, removed by an admin, or the circle was deleted. Keys
  // are only ever deleted for one of these reasons; each is logged.
  client.on('signedOut', ({ reason }) => {
    diag('signout', { reason });
    if (clients.get(accountKey) === client) forget(accountKey).catch(() => {});
  });
  // The server no longer knows this phone in the circle. The keys stay until
  // the person removes the circle (the banner offers it).
  client.on('unrecognized', () => {
    diag('server:unrecognized', { via: 'live' });
  });
  return client;
}

async function saveList() {
  await AsyncStorage.setItem(LIST_KEY, JSON.stringify([...clients.keys()]));
  if (active) await AsyncStorage.setItem(ACTIVE_KEY, active);
  else await AsyncStorage.removeItem(ACTIVE_KEY);
}

async function forget(accountKey: string) {
  clients.delete(accountKey);
  if (active === accountKey) active = clients.keys().next().value ?? null;
  await saveList();
  changed();
}

async function loadAll() {
  const t0 = Date.now();
  let keys: string[] = [];
  let stored: string | null = null;
  let saved: string | null = null;
  [stored, saved] = await Promise.all([AsyncStorage.getItem(LIST_KEY), AsyncStorage.getItem(ACTIVE_KEY)]).catch(() => [null, null]);
  try {
    keys = JSON.parse(stored || '[]');
  } catch {
    keys = [];
  }
  // Phones from before multiple circles had one account under ACCOUNT_KEY.
  if (!keys.length) keys = [ACCOUNT_KEY];
  // Every circle's keys at once: each is several reads from the Keychain /
  // Keystore, and one after another they added up to seconds of white screen.
  const slowest = { key: '', ms: 0 };
  let failed = 0;
  const results = await Promise.all(
    keys.map(async (key) => {
      if (clients.has(key)) return { key, client: clients.get(key)!, found: true };
      const client = makeClient(key);
      const t = Date.now();
      let found = false;
      try {
        found = await client.load();
      } catch (e) {
        // The keys are there but couldn't be read right now (the phone is
        // locked, the Keystore is busy): not the same as "no account".
        failed++;
        diag('error', { where: 'load-circle', msg: errorText(e).slice(0, 100) });
        return { key, client, found: false, error: true };
      }
      if (Date.now() - t > slowest.ms) Object.assign(slowest, { key, ms: Date.now() - t });
      return { key, client, found };
    }),
  );
  for (const r of results) if (r.found) clients.set(r.key, r.client);
  active = saved && clients.has(saved) ? saved : (clients.keys().next().value ?? null);
  // The list drops a circle only when its account is really gone, not when it couldn't be read this time.
  const keep = results.filter((r) => r.found || r.error).map((r) => r.key);
  mark('circles');
  // Not waited for: the screens don't need the list written to draw.
  if (JSON.stringify(keep) !== stored || active !== saved) {
    AsyncStorage.setItem(LIST_KEY, JSON.stringify(keep))
      .then(() => (active ? AsyncStorage.setItem(ACTIVE_KEY, active) : AsyncStorage.removeItem(ACTIVE_KEY)))
      .catch(() => {});
  }
  // Retried by the next call when something couldn't be read.
  loaded = !failed;
  changed();
  startupDiag.circlesMs = Date.now() - t0;
  startupDiag.circles = clients.size;
  startupDiag.slowestLoadMs = slowest.ms;
  warmCaches();
}

/**
 * Read what each circle's phone copy holds (messages, members, last locations)
 * once the first screen is up, the one on screen first, so it's there when
 * the chat opens and not after the server has answered.
 */
function warmCaches() {
  setTimeout(async () => {
    const order = [...clients.values()].sort((a, b) => Number(b.accountKey === active) - Number(a.accountKey === active));
    for (const client of order) await client.loadCache().catch(() => {});
  }, 50);
}

/** What loading the circles took, for Diagnostics (see startup.ts). */
export const startupDiag: Record<string, number> = {};

/** Loads this phone's circles once. Returns whether it's in any circle. */
export async function ensureLoaded(): Promise<boolean> {
  if (!loaded) {
    if (!loading) loading = loadAll().finally(() => (loading = null));
    await loading.catch(() => {});
  }
  return clients.size > 0;
}

/**
 * The active circle's client. Before the phone is in any circle this is a
 * fresh, unsaved client (used for previews on the welcome screens).
 */
export function getClient(): CircleClient {
  if (active && clients.has(active)) return clients.get(active)!;
  return draftClient();
}

/** All circles on this phone, in the order they were added. */
export function allClients(): CircleClient[] {
  return [...clients.values()];
}

/** For background tasks: every circle this phone is in (possibly none). */
export async function loadedClients(): Promise<CircleClient[]> {
  await ensureLoaded();
  return allClients();
}

export function clientForCircle(circleId: string | null | undefined): CircleClient | undefined {
  return allClients().find((c) => c.circleId === circleId);
}

/** An unsaved client for setting up or joining another circle. */
export function draftClient(): CircleClient {
  if (!draft || draft.account) {
    let key = ACCOUNT_KEY;
    for (let i = 2; clients.has(key); i++) key = `${ACCOUNT_KEY}.${Date.now().toString(36)}${i}`;
    draft = makeClient(key);
  }
  return draft;
}

/** Register a client that just set up or joined a circle, and switch to it. */
export async function addCircle(client: CircleClient) {
  if (!client.account) throw new Error('Not in a circle yet');
  const existing = clientForCircle(client.circleId);
  if (existing && existing !== client) {
    // Already in this circle (e.g. scanned an invite twice): keep the old keys.
    await client.signOut();
    active = existing.accountKey;
  } else {
    clients.set(client.accountKey, client);
    active = client.accountKey;
  }
  if (draft === client) draft = null;
  loaded = true;
  await saveList();
  changed();
}

export async function setActiveCircle(accountKey: string) {
  if (!clients.has(accountKey) || active === accountKey) return;
  active = accountKey;
  await saveList();
  changed();
}

/** Re-renders when circles are added, removed or switched. */
export function useCircles(): { clients: CircleClient[]; active: CircleClient | null; version: number } {
  const v = useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => version,
  );
  return { clients: allClients(), active: active ? clients.get(active) ?? null : null, version: v };
}

/** A server address without the scheme or trailing slash, for showing people. */
export function serverHost(url: string | null | undefined): string {
  return (url || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

export type ServerGroup = { url: string; host: string; circles: CircleClient[] };

/** The servers this phone has circles on, in the order first joined, each with its circles. */
export function serverGroups(list: CircleClient[]): ServerGroup[] {
  const groups = new Map<string, CircleClient[]>();
  for (const c of list) {
    const url = c.serverUrl || '';
    groups.set(url, [...(groups.get(url) || []), c]);
  }
  return [...groups].map(([url, circles]) => ({ url, host: serverHost(url), circles }));
}

export function onCirclesChanged(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
