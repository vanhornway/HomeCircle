// The internet bridge's broker (MQTT), remembered on this phone in its secure
// store, so setting up another gateway (or the home base again) doesn't need
// it typed again. Never sent anywhere but sealed to the home base, or over
// Bluetooth to a gateway being set up.
import * as SecureStore from 'expo-secure-store';

export type BrokerSettings = { host: string; port: number; user: string; pass: string };

const KEY = 'homecircle.bridgeBroker';

export async function loadBroker(): Promise<BrokerSettings | null> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    const b = raw ? JSON.parse(raw) : null;
    return b && typeof b.host === 'string' ? { host: b.host, port: Number(b.port) || 8883, user: String(b.user ?? ''), pass: String(b.pass ?? '') } : null;
  } catch {
    return null;
  }
}

export async function saveBroker(b: BrokerSettings): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(b)).catch(() => {});
}

/** "abc.s1.eu.hivemq.cloud", with or without mqtts:// and a port. */
export function parseBrokerHost(input: string): { host: string; port: number | null } | null {
  const s = input.trim().replace(/^mqtts?:\/\//i, '').replace(/\/.*$/, '');
  const m = s.match(/^([A-Za-z0-9.-]{3,56})(?::(\d{2,5}))?$/);
  return m ? { host: m[1].toLowerCase(), port: m[2] ? Number(m[2]) : null } : null;
}

/** What's wrong with these settings, or null: Meshtastic keeps a password of at most 31 characters, and no spaces anywhere. */
export function brokerProblem(b: BrokerSettings): string | null {
  if (!b.host) return 'Enter the broker’s address.';
  if (!(b.port > 0 && b.port < 65536)) return 'The port is a number, usually 8883.';
  if (!b.user || /\s/.test(b.user)) return 'Enter the user name (no spaces).';
  if (!b.pass || /\s/.test(b.pass)) return 'Enter the password (no spaces).';
  if (b.pass.length > 31) return 'Meshtastic keeps at most 31 characters of a password: make a shorter one for this broker user.';
  return null;
}
