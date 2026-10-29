// Her requests when there's no internet (PRD CUJ 10): they wait on the phone
// and go out by themselves once it's back. Tapping again for the same
// request (everyone in a circle, or the same person) doesn't add another.
// She hears that it will go later, and again when it has gone.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ApiError, type CircleClient } from '@homecircle/core';
import { loadedClients } from '../lib/circle';
import { say } from './lines';

const KEY = 'companion.outbox';
type Pending = { circle: string; to: string | null; tz: string | null; remind: number; at: number };
type Ask = { to?: string | null; tz: string | null; remind: number };

async function read(): Promise<Pending[]> {
  try {
    return JSON.parse((await AsyncStorage.getItem(KEY)) || '[]');
  } catch {
    return [];
  }
}
const write = (list: Pending[]) => AsyncStorage.setItem(KEY, JSON.stringify(list));

/** A server that answered isn't "no internet": only a request that never got there waits. */
const offline = (e: unknown) => !(e instanceof ApiError);

/** Ask for a call back now, or keep it for later if the phone is offline. */
export async function askOrQueue(client: CircleClient, ask: Ask): Promise<'sent' | 'queued'> {
  try {
    await client.askCallback({ to: ask.to ?? null, tz: ask.tz, awake: true, remind: ask.remind });
    return 'sent';
  } catch (e) {
    if (!offline(e)) throw e;
    const list = (await read()).filter((p) => !(p.circle === client.circleId && p.to === (ask.to ?? null)));
    list.push({ circle: client.circleId!, to: ask.to ?? null, tz: ask.tz, remind: ask.remind, at: Date.now() });
    await write(list);
    say({ key: 'offline.queued' });
    return 'queued';
  }
}

/** Whether a request to this circle (and person) is waiting to go. */
export async function isQueued(client: CircleClient, to: string | null = null): Promise<boolean> {
  return (await read()).some((p) => p.circle === client.circleId && p.to === to);
}

let flushing: Promise<number> | null = null;

/** Send what's waiting. Returns how many went. */
export function flushOutbox(): Promise<number> {
  flushing ??= (async () => {
    let sent = 0;
    try {
      const waiting = await read();
      // Also from the background task, where the circles may not be loaded yet.
      const clients = waiting.length ? await loadedClients() : [];
      for (const p of waiting) {
        const client = clients.find((c) => c.circleId === p.circle);
        try {
          if (client) await client.askCallback({ to: p.to, tz: p.tz, awake: true, remind: p.remind });
          // Sent, or its circle is gone from this phone: either way it's done.
          await write((await read()).filter((x) => !(x.circle === p.circle && x.to === p.to)));
          if (client) sent++;
        } catch (e) {
          if (offline(e)) break; // still no internet: try again later
          await write((await read()).filter((x) => !(x.circle === p.circle && x.to === p.to)));
        }
      }
      if (sent) say({ key: 'offline.sent' });
      return sent;
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}
