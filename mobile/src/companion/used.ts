// When she last used her phone (opened the app, touched a button), sent
// sealed with her location so the family's phones can notice a long quiet
// stretch (PRD CUJ 11). The family never learns more than the time.
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'companion.used';
let last = 0;

export function markUsed() {
  const now = Date.now();
  // At most every minute: it only needs to be roughly right.
  if (now - last < 60_000) return;
  last = now;
  AsyncStorage.setItem(KEY, String(now)).catch(() => {});
}

export async function lastUsed(): Promise<number | null> {
  const v = Number(await AsyncStorage.getItem(KEY).catch(() => null));
  return Number.isFinite(v) && v > 0 ? v : null;
}
