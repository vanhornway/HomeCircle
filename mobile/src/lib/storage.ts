// Keys live in the iOS Keychain / Android Keystore via expo-secure-store.
// Values are chunked because SecureStore may reject values over ~2 KB.
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Storage } from '@homecircle/core';

const CHUNK = 1800;
// Background tasks run while the phone is locked, so keys must be readable
// after first unlock. THIS_DEVICE_ONLY keeps them out of backups.
const OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export const secureStorage: Storage = {
  async getItem(key) {
    const n = await SecureStore.getItemAsync(`${key}.n`, OPTS);
    if (n == null) return null;
    const parts: string[] = [];
    for (let i = 0; i < Number(n); i++) {
      const part = await SecureStore.getItemAsync(`${key}.${i}`, OPTS);
      if (part == null) return null;
      parts.push(part);
    }
    return parts.join('');
  },
  async setItem(key, value) {
    const old = Number((await SecureStore.getItemAsync(`${key}.n`, OPTS)) || 0);
    const count = Math.max(1, Math.ceil(value.length / CHUNK));
    for (let i = 0; i < count; i++) {
      await SecureStore.setItemAsync(`${key}.${i}`, value.slice(i * CHUNK, (i + 1) * CHUNK), OPTS);
    }
    await SecureStore.setItemAsync(`${key}.n`, String(count), OPTS);
    for (let i = count; i < old; i++) await SecureStore.deleteItemAsync(`${key}.${i}`, OPTS);
  },
  async removeItem(key) {
    const n = Number((await SecureStore.getItemAsync(`${key}.n`, OPTS)) || 0);
    for (let i = 0; i < n; i++) await SecureStore.deleteItemAsync(`${key}.${i}`, OPTS);
    await SecureStore.deleteItemAsync(`${key}.n`, OPTS);
  },
};

// --- non-secret device settings ------------------------------------------

export interface Settings {
  /** Share this phone's location with the circle. */
  sharing: boolean;
  /** Background update interval. The OS treats this as a minimum. */
  intervalMinutes: number;
  /** Show sender and text in notifications (otherwise just "New message"). */
  showPreviews: boolean;
  /** Map tiles, from the server's /info. */
  tileUrl: string;
  tileAttribution: string;
}

const SETTINGS_KEY = 'homecircle.settings';
const LAST_UPLOAD_KEY = 'homecircle.lastUpload';

export const DEFAULT_SETTINGS: Settings = {
  sharing: true,
  intervalMinutes: 15,
  showPreviews: true,
  tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  tileAttribution: '&copy; OpenStreetMap contributors',
};

export async function getSettings(): Promise<Settings> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

export interface LastUpload {
  ts: number;
  lat: number;
  lng: number;
}

export async function getLastUpload(): Promise<LastUpload | null> {
  try {
    const raw = await AsyncStorage.getItem(LAST_UPLOAD_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function setLastUpload(v: LastUpload | null) {
  if (v) await AsyncStorage.setItem(LAST_UPLOAD_KEY, JSON.stringify(v));
  else await AsyncStorage.removeItem(LAST_UPLOAD_KEY);
}

export async function clearDeviceData() {
  await AsyncStorage.multiRemove([SETTINGS_KEY, LAST_UPLOAD_KEY, 'homecircle.geofenceEvents', 'homecircle.lastNotifiedSeq']);
}
