// A 7-day log of what this phone did in the background: wake-ups, GPS fixes,
// place decisions, uploads and errors. It stays on the phone, encrypted with a
// key kept in the Keychain / Keystore, and is only shared when you choose to
// (Settings → Diagnostics).
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import nacl from 'tweetnacl';
import { fromB64, toB64, utf8Decode, utf8Encode } from '@homecircle/core';

const LOG_KEY = 'homecircle.diag';
const KEY_NAME = 'homecircle.diagKey';
const KEEP_MS = 7 * 86400_000;
const MAX_ENTRIES = 3000;

export type DiagEntry = { t: number; e: string; d?: Record<string, unknown> };

const b64 = { enc: toB64, dec: fromB64 };

let keyPromise: Promise<Uint8Array> | null = null;
function logKey(): Promise<Uint8Array> {
  if (!keyPromise) {
    keyPromise = (async () => {
      const opts = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
      const saved = await SecureStore.getItemAsync(KEY_NAME, opts);
      if (saved) return b64.dec(saved);
      const k = nacl.randomBytes(32);
      await SecureStore.setItemAsync(KEY_NAME, b64.enc(k), opts);
      return k;
    })().catch((e) => {
      keyPromise = null;
      throw e;
    });
  }
  return keyPromise;
}

async function readAll(): Promise<DiagEntry[]> {
  const raw = await AsyncStorage.getItem(LOG_KEY);
  if (!raw) return [];
  try {
    const { n, c } = JSON.parse(raw);
    const plain = nacl.secretbox.open(b64.dec(c), b64.dec(n), await logKey());
    if (!plain) return [];
    return JSON.parse(utf8Decode(plain));
  } catch {
    return [];
  }
}

async function writeAll(entries: DiagEntry[]) {
  const n = nacl.randomBytes(24);
  const c = nacl.secretbox(utf8Encode(JSON.stringify(entries)), n, await logKey());
  await AsyncStorage.setItem(LOG_KEY, JSON.stringify({ n: b64.enc(n), c: b64.enc(c) }));
}

// Writes are queued so background tasks running at the same time can't
// overwrite each other's entries.
let queue: Promise<unknown> = Promise.resolve();

/** Record one event. Never throws: diagnostics must not break tracking. */
export function diag(e: string, d?: Record<string, unknown>): Promise<void> {
  const entry: DiagEntry = { t: Date.now(), e, ...(d ? { d } : {}) };
  const run = queue.then(async () => {
    const cutoff = Date.now() - KEEP_MS;
    const entries = (await readAll()).filter((x) => x.t >= cutoff);
    entries.push(entry);
    await writeAll(entries.slice(-MAX_ENTRIES));
  });
  queue = run.catch(() => {});
  return run.catch(() => {});
}

export async function readDiagnostics(): Promise<DiagEntry[]> {
  await queue;
  return readAll();
}

export async function clearDiagnostics() {
  await queue;
  await AsyncStorage.removeItem(LOG_KEY);
}

const time = (t: number) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });

/** One readable line per event. */
export function formatEntry(x: DiagEntry): string {
  const details = x.d
    ? Object.entries(x.d)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}=${typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(1) : String(v)}`)
        .join(' ')
    : '';
  return `${time(x.t)}  ${x.e}${details ? `  ${details}` : ''}`;
}

/**
 * A short summary for the last 7 days: counts, failures and the longest gap
 * between location uploads, which is what usually explains "why was Mom's
 * pin stale".
 */
export function summarize(entries: DiagEntry[], now = Date.now()) {
  const count = (e: string) => entries.filter((x) => x.e === e).length;
  const uploads = entries.filter((x) => x.e === 'upload').map((x) => x.t).sort((a, b) => a - b);
  // Longest stretch without a successful upload, including from the start of
  // the log to the first upload and from the last upload until now.
  const marks = entries.length ? [entries[0].t, ...uploads, now] : [];
  let longestGap = 0;
  let gapEnd = 0;
  for (let i = 1; i < marks.length; i++) {
    const g = marks[i] - marks[i - 1];
    if (g > longestGap) {
      longestGap = g;
      gapEnd = marks[i];
    }
  }
  return {
    since: entries[0]?.t ?? null,
    wakeups: entries.filter((x) => x.e.startsWith('wake:')).length,
    uploads: uploads.length,
    uploadFailures: count('upload-failed'),
    arrivals: entries.filter((x) => x.e === 'place' && x.d?.action === 'arrived').length,
    departures: entries.filter((x) => x.e === 'place' && x.d?.action === 'left').length,
    placeRetries: count('place-retry'),
    locateRequests: count('locate-request'),
    errors: entries.filter((x) => x.e.endsWith('-failed') || x.e === 'error').length,
    longestGapMin: Math.round(longestGap / 60_000),
    longestGapEnded: gapEnd || null,
    gapOngoing: !!gapEnd && gapEnd === now,
  };
}

/** The whole log as text, for sharing or a direct message to an admin. */
/** "45 min" or "3.5 h". */
export function formatGap(min: number) {
  return min < 90 ? `${min} min` : `${Math.round(min / 6) / 10} h`;
}

export function diagnosticsText(entries: DiagEntry[], header: string, maxLines?: number) {
  const s = summarize(entries);
  const lines = (maxLines ? entries.slice(-maxLines) : entries).map(formatEntry);
  return [
    header,
    `Since ${s.since ? time(s.since) : '—'}: ${s.wakeups} background wake-ups, ${s.uploads} location uploads (${s.uploadFailures} failed),`,
    `${s.arrivals} arrivals and ${s.departures} departures (${s.placeRetries} retried), ${s.locateRequests} Locate requests, ${s.errors} errors.`,
    `Longest time without an upload: ${formatGap(s.longestGapMin)}${s.gapOngoing ? ' (still going on)' : s.longestGapEnded ? ` (ended ${time(s.longestGapEnded)})` : ''}.`,
    '',
    ...lines,
  ].join('\n');
}
