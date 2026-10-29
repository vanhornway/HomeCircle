// Skins: which screens this phone shows, on top of the same app, circles
// and data. An admin chooses each person's skin (it comes with the invite,
// and later from the circle); the phone remembers it, so a cold start with
// no network still opens the right screens. A locked skin has no way back
// to the full app from the phone itself. A new skin is an entry here and a
// route folder; nothing underneath changes.
import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Href } from 'expo-router';
import { IS_COMPANION } from '../lib/variant';

export type SkinId = 'full' | 'elderly';

export const SKINS: Record<SkinId, { label: string; detail: string; root: Href; locked: boolean }> = {
  full: { label: 'Full app', detail: 'HomeCircle as everyone else has it', root: '/(tabs)', locked: false },
  elderly: { label: 'Elderly Companion', detail: 'Big photo tiles, Ring everyone, SOS and games', root: '/companion', locked: true },
};

export const isSkin = (id: unknown): id is SkinId => typeof id === 'string' && id in SKINS;

const KEY = 'homecircle.skin';
// A separate Elderly Companion listing (app.config.js, APP_VARIANT=companion) always shows that skin.
const DEFAULT: SkinId = IS_COMPANION ? 'elderly' : 'full';
let current: SkinId | null = null;
let loading: Promise<SkinId> | null = null;
const listeners = new Set<() => void>();

/** This phone's skin, loaded once from storage (background tasks call this too). */
export function loadSkin(): Promise<SkinId> {
  if (current) return Promise.resolve(current);
  loading ??= AsyncStorage.getItem(KEY)
    .then((v) => (current = isSkin(v) ? v : DEFAULT))
    .catch(() => (current = DEFAULT));
  return loading;
}

/** The skin once loaded (the full app until then). */
export function currentSkin(): SkinId {
  return current ?? DEFAULT;
}

export async function setSkin(id: SkinId) {
  if (IS_COMPANION) id = 'elderly';
  current = id;
  listeners.forEach((l) => l());
  await AsyncStorage.setItem(KEY, id);
}

export function useSkin(): SkinId {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    currentSkin,
  );
}

/** Where this phone's app opens. */
export const skinRoot = (): Href => SKINS[currentSkin()].root;
