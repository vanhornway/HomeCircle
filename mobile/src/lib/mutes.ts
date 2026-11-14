// A tracker's messages muted on this phone for a while (its button presses,
// what's typed on it): 1 hour, 8 hours or until tomorrow morning. An SOS
// always comes through. Kept on this phone.
import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'homecircle.mutes';
let mutes: Record<string, number> = {};
let loaded: Promise<void> | null = null;
const listeners = new Set<() => void>();
let version = 0;

export const loadMutes = () =>
  (loaded ??= AsyncStorage.getItem(KEY)
    .then((raw) => {
      mutes = raw ? JSON.parse(raw) : {};
    })
    .catch(() => {})
    .then(() => {
      version++;
      listeners.forEach((l) => l());
    }));
loadMutes();

/** Muted until when (ms), or null. */
export function mutedUntil(memberId: string, now = Date.now()): number | null {
  const until = mutes[memberId];
  return until && until > now ? until : null;
}

export async function setMute(memberId: string, until: number | null) {
  await loadMutes();
  const next = { ...mutes };
  if (until) next[memberId] = until;
  else delete next[memberId];
  // Drop the expired ones.
  for (const [k, v] of Object.entries(next)) if (v <= Date.now()) delete next[k];
  mutes = next;
  version++;
  listeners.forEach((l) => l());
  await AsyncStorage.setItem(KEY, JSON.stringify(mutes)).catch(() => {});
}

/** 7 am tomorrow, here. */
export function tomorrowMorning(now = Date.now()): number {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(7, 0, 0, 0);
  return d.getTime();
}

export function useMutesVersion(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
}
