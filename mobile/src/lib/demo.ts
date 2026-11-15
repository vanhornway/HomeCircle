// "Try a demo family": a private copy of a made-up family on the demo server,
// for an hour. It's a circle like any other on this phone, with its own keys,
// so leaving it or its ending touches nothing else. It never gets this phone's
// real location (see sharingClients).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CircleClient, randomId } from '@homecircle/core';
import { addCircle, allClients, draftClient } from './circle';
import { updateSettings } from './storage';

const DEMO_SERVER = process.env.EXPO_PUBLIC_DEMO_SERVER || 'https://demo.homecircle.umair.us';
const DEVICE_KEY = 'homecircle.demoDevice';

/** A random id for this phone, so the server can count its starts. */
async function deviceId() {
  let id = await AsyncStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = randomId();
    await AsyncStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

/** Get a ready copy and join it. Busy or at its limit, it throws what to tell the person. */
export async function startDemo(name: string) {
  const first = allClients().length === 0;
  let link: string;
  try {
    ({ link } = await CircleClient.startDemo(DEMO_SERVER, { device: await deviceId() }));
  } catch (e: any) {
    if (e?.code === 'demo_busy' || e?.code === 'demo_limit') throw e;
    throw new Error('The demo isn’t available right now. Try again in a while.');
  }
  const client = draftClient();
  await client.joinWithInvite(link, { name });
  await addCircle(client);
  if (first) {
    const info = await CircleClient.serverInfo(DEMO_SERVER).catch(() => null);
    if (info) await updateSettings({ tileUrl: info.tileUrl, tileAttribution: info.tileAttribution });
  }
}

/** Whole minutes left, at least 0. */
export const demoMinutesLeft = (endsAt: number, now = Date.now()) => Math.max(0, Math.ceil((endsAt - now) / 60_000));
