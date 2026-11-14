// The tracker paired with this phone (Trackers → This phone → Pair your
// tracker): its node id, name and Bluetooth address, remembered on this phone
// so the phone bridge and messages over the mesh connect to it directly. When
// it's last been near this phone (read over Bluetooth) helps tell whether the
// person and their tracker are together.
import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type Paired = { node: string; name: string; deviceId: string; pairedAt: number; nearAt: number | null; battery: number | null };

const KEY = 'homecircle.pairedTracker';
let paired: Paired | null = null;
let loaded = false;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

export async function loadPaired(): Promise<Paired | null> {
  if (loaded) return paired;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const p = raw ? JSON.parse(raw) : null;
    paired = p && typeof p.node === 'string' && /^![0-9a-f]{8}$/.test(p.node) ? p : null;
  } catch {
    paired = null;
  }
  loaded = true;
  changed();
  return paired;
}
loadPaired();

/** The paired tracker, as last loaded (null until loaded, or none). */
export const pairedNow = () => paired;

export async function setPaired(p: Paired | null) {
  paired = p;
  loaded = true;
  changed();
  if (p) await AsyncStorage.setItem(KEY, JSON.stringify(p)).catch(() => {});
  else await AsyncStorage.removeItem(KEY).catch(() => {});
}

/** Paired just now (it's next to this phone). */
export function pairNow(p: Omit<Paired, 'pairedAt' | 'nearAt'>) {
  const now = Date.now();
  return setPaired({ ...p, pairedAt: now, nearAt: now });
}

/** It was near this phone just now (read over Bluetooth). */
export async function markNear(battery: number | null) {
  if (!paired) return;
  await setPaired({ ...paired, nearAt: Date.now(), battery: battery ?? paired.battery });
}

export function usePaired(): Paired | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => paired,
  );
}
