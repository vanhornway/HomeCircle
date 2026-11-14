// The phone bridge: this phone passes on the position of the tracker its
// person carries, read over Bluetooth, so the tracker shows on the map
// wherever the phone has internet (not only in reach of the home base or a
// gateway). Off unless turned on, per phone: it wakes Bluetooth every 10
// minutes or so. The position goes to the home base sealed, as a silent
// message (client.sendTrackerFix); the home base posts it "via <name>'s phone".
//
// It reads the tracker's own position from what the tracker tells its phone
// (the Meshtastic phone API), so if the Meshtastic app is connected to the
// tracker at the same time, the two take turns reading; best with the
// Meshtastic app closed.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import type { CircleClient } from '@homecircle/core';
import type { Device } from 'react-native-ble-plx';
import { blePermitted, findNode, knownDevice, MeshNode } from './meshNode';
import { myTracker } from './meshOutbox';
import { MESSAGES_CHANNEL, ensureNotificationChannels } from './notify';
import { loadPaired, markNear } from './pairedTracker';
import { distanceText, homeBaseOf, separation } from './trackers';

const KEY = 'homecircle.phoneBridge';
const EVERY_MS = 10 * 60_000;

type State = { on: boolean; lastTry: number; lastSent: Record<string, number>; apartToldAt?: number };
let cached: State | null = null;

async function load(): Promise<State> {
  if (cached) return cached;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    cached = { on: false, lastTry: 0, lastSent: {}, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    cached = { on: false, lastTry: 0, lastSent: {} };
  }
  return cached!;
}

async function save(patch: Partial<State>) {
  cached = { ...(await load()), ...patch };
  await AsyncStorage.setItem(KEY, JSON.stringify(cached)).catch(() => {});
}

export async function phoneBridgeOn(): Promise<boolean> {
  return (await load()).on;
}

export async function setPhoneBridge(on: boolean) {
  await save({ on, lastTry: 0 });
}

/**
 * You and your tracker are apart (both positions fresh, over 500 m) and this
 * phone isn't the one left at home: say so here once (at most every 6 hours),
 * so you can go back for it.
 */
export async function checkSeparation(clients: CircleClient[]) {
  const st = await load();
  if (Date.now() - (st.apartToldAt ?? 0) < 6 * 3600_000) return;
  for (const c of clients) {
    if (!c.account || !c.feature('meshtastic')) continue;
    const sep = separation(c, c.account.memberId, Date.now());
    if (!sep || sep.phoneAtHome) continue;
    await save({ apartToldAt: Date.now() });
    await ensureNotificationChannels();
    await Notifications.scheduleNotificationAsync({
      content: {
        title: sep.trackerAtHome ? `${sep.trackerName} is still at home` : `You’re ${distanceText(sep.meters)} from ${sep.trackerName}`,
        body: sep.trackerAtHome ? 'You left with your phone but not your tracker.' : 'Did you leave your tracker somewhere? Open HomeCircle to see where it is.',
        data: { t: 'separated' },
      },
      trigger: Platform.OS === 'android' ? { channelId: MESSAGES_CHANNEL } : null,
    });
    return;
  }
}

/**
 * Pass on the carried tracker's position, if the bridge is on and it's due
 * (or `force`). Returns what happened, for the settings screen.
 */
export async function bridgeTick(clients: CircleClient[], { force = false } = {}): Promise<string> {
  const st = await load();
  if (!st.on && !force) return 'off';
  if (!force && Date.now() - st.lastTry < EVERY_MS) return 'not due';
  const c = clients.find((x) => myTracker(x) && homeBaseOf(x));
  if (!c) return 'You don’t carry a tracker in any circle with a home base.';
  const tracker = myTracker(c)!;
  const home = homeBaseOf(c)!;
  await save({ lastTry: Date.now() });
  if (!(await blePermitted())) return 'HomeCircle needs Nearby devices (Bluetooth) for this.';
  // The paired tracker: straight to it by its Bluetooth address; otherwise look for it.
  const paired = await loadPaired();
  let device: Device | null = null;
  if (paired?.node === tracker.node) {
    device = await knownDevice(paired.deviceId);
  }
  device ??= await findNode(tracker.node, 12_000);
  if (!device) return `${tracker.name} isn’t in Bluetooth range.`;
  const node = await MeshNode.open(device);
  try {
    const snap = await node.download();
    const me = snap.nodes.get(snap.myNode);
    await markNear(me?.battery != null && me.battery <= 100 ? me.battery : null);
    if (me?.lat == null || me.lng == null) return `${tracker.name} has no GPS fix yet.`;
    const at = me.time ? me.time * 1000 : Date.now();
    if ((st.lastSent[tracker.node] ?? 0) >= at && !force) return `${tracker.name} hasn’t moved on since the last one.`;
    await c.sendTrackerFix(home.id, { node: tracker.node, lat: me.lat, lng: me.lng, at, battery: me.battery != null && me.battery <= 100 ? me.battery : null });
    await save({ lastSent: { ...st.lastSent, [tracker.node]: at } });
    return `Sent ${tracker.name}’s position.`;
  } finally {
    await node.close();
  }
}
