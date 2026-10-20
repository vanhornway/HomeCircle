// What you've read, per conversation (a circle's group chat, or a direct chat
// with one member). Stored on this phone so unread counts survive restarts.
import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CircleClient, Message } from '@homecircle/core';

const READ_KEY = 'homecircle.read';

/** "circleId" for the group chat, "circleId:memberId" for a direct chat. */
export const conversationKey = (circleId: string, peer: string | null) => (peer ? `${circleId}:${peer}` : circleId);

type ReadState = {
  /** Last read message seq per conversation. */
  read: Record<string, number>;
  /** Per circle: everything up to here counts as read (history from before this feature or before joining). */
  base: Record<string, number>;
};

let state: ReadState = { read: {}, base: {} };
let loading: Promise<void> | null = null;
let version = 0;
const subs = new Set<() => void>();

function changed() {
  version++;
  subs.forEach((fn) => fn());
}

export function loadRead(): Promise<void> {
  if (!loading) {
    loading = AsyncStorage.getItem(READ_KEY)
      .then((raw) => {
        if (raw) state = { read: {}, base: {}, ...JSON.parse(raw) };
      })
      .catch(() => {})
      .finally(changed);
  }
  return loading;
}

const save = () => AsyncStorage.setItem(READ_KEY, JSON.stringify(state)).catch(() => {});

/** The first time a circle is loaded on this phone, its existing history counts as read. */
export async function ensureReadBase(client: CircleClient) {
  await loadRead();
  const id = client.circleId;
  if (!id || state.base[id] != null) return;
  state.base[id] = client.lastSeq;
  await save();
  changed();
}

function lastRead(circleId: string, peer: string | null) {
  return state.read[conversationKey(circleId, peer)] ?? state.base[circleId] ?? Number.MAX_SAFE_INTEGER;
}

const counts = (m: Message, me: string | undefined) => m.from !== me && (m.kind === 'chat' || m.kind === 'event');

export function unreadIn(client: CircleClient, peer: string | null): number {
  const id = client.circleId;
  if (!id) return 0;
  const after = lastRead(id, peer);
  const me = client.account?.memberId;
  return client.conversation(peer).filter((m) => m.seq > after && counts(m, me)).length;
}

/** Unread across a circle's group chat and its direct chats. */
export function unreadInCircle(client: CircleClient): number {
  return [null, ...client.directPeers()].reduce((n, peer) => n + unreadIn(client, peer), 0);
}

export async function markRead(client: CircleClient, peer: string | null) {
  const id = client.circleId;
  if (!id) return;
  const seq = client.conversation(peer).reduce((n, m) => Math.max(n, m.seq), 0);
  const key = conversationKey(id, peer);
  if (seq <= (state.read[key] ?? 0)) return;
  state.read[key] = seq;
  await save();
  changed();
}

/** Re-renders when anything is marked read. */
export function useReadVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => version,
  );
}

export async function clearRead(circleId: string) {
  await loadRead();
  delete state.base[circleId];
  for (const k of Object.keys(state.read)) if (k === circleId || k.startsWith(`${circleId}:`)) delete state.read[k];
  await save();
  changed();
}
