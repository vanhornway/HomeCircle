// What reaches her phone from a circle, open or closed: a reply to her
// call-back request is played in Urdu (and shown in Urdu if the app is
// closed); someone else's SOS rings as in HomeCircle. She never gets message text.
import { AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { AndroidImportance, AndroidNotificationVisibility } from 'expo-notifications';
import type { CircleClient, Message } from '@homecircle/core';
import { alertSos, stopAlarm } from '../lib/sosAlarm';
import { replyLine } from './status';
import { genderOf, inSleepHours, tileName } from './people';
import { allClients } from '../lib/circle';
import { say, text, type Gender, type Line } from './lines';

const CHANNEL = 'companion-replies';

async function ensureChannel() {
  if (Platform.OS !== 'android') return;
  // The clip plays on its own, so the notification itself is silent.
  await Notifications.setNotificationChannelAsync(CHANNEL, {
    name: 'Replies from family',
    importance: AndroidImportance.HIGH,
    sound: null,
    lockscreenVisibility: AndroidNotificationVisibility.PUBLIC,
  });
}

/** Messages newer than `last` in this circle, as her phone takes them. */
export async function companionAlerts(client: CircleClient, messages: Message[], last: number) {
  const me = client.account?.memberId;
  if (!me) return;
  let latest: Line | null = null;
  // Her sleep hours: nothing sounds, except replies to a request she sent during them.
  const asleep = inSleepHours(allClients().length ? allClients() : [client]);
  for (const m of messages) {
    if (m.seq <= last || m.from === me || m.kind !== 'chat' || m.peer) continue;
    const sos = client.feature('sos') ? m.body?.sos?.state : null;
    if (sos === 'start') await alertSos(client, m).catch(() => {});
    if (sos === 'safe') stopAlarm();
    const r = m.body?.callback;
    if (r?.state !== 'reply') continue;
    const s = client.callbackState(r.of);
    const who = s?.replies.find((x) => x.memberId === m.from);
    if (s?.from !== me || !who || (asleep && s.awake)) continue;
    // Several "asleep" answers to one request come together as one line.
    if (who.reply === 'asleep') queueAsleep(client, who.memberId);
    else latest = replyLine(client, who.memberId, who.name, who.reply);
  }
  if (latest) await tell(client, latest);
}

async function tell(client: CircleClient, line: Line) {
  say(line);
  if (AppState.currentState === 'active') return;
  await ensureChannel();
  await Notifications.scheduleNotificationAsync({
    content: { title: text(line), data: { t: 'companion', circle: client.circleId ?? '' } },
    trigger: Platform.OS === 'android' ? { channelId: CHANNEL } : null,
  });
}

// "Asleep" answers arrive one by one, a moment apart; she hears them as one
// line: "X and Y are asleep right now and will call you back later."
const ASLEEP_WAIT_MS = 2500;
let asleepQueue: { client: CircleClient; people: string[] } | null = null;
let asleepTimer: ReturnType<typeof setTimeout> | null = null;

function queueAsleep(client: CircleClient, memberId: string) {
  if (!asleepQueue || asleepQueue.client !== client) asleepQueue = { client, people: [] };
  if (!asleepQueue.people.includes(memberId)) asleepQueue.people.push(memberId);
  if (asleepTimer) clearTimeout(asleepTimer);
  asleepTimer = setTimeout(() => {
    const q = asleepQueue;
    asleepQueue = null;
    asleepTimer = null;
    if (q) tell(q.client, asleepLine(q.client, q.people)).catch(() => {});
  }, ASLEEP_WAIT_MS);
}

/** One person: asleep.one in their he/she; several: asleep.many, male if any man is among them. */
export function asleepLine(client: CircleClient, people: string[]): Line {
  const g = (id: string): Gender => genderOf(client, id);
  if (people.length === 1) return { key: 'asleep.one', g: g(people[0]), name: tileName(client, people[0]) };
  const names = people.map((id) => tileName(client, id));
  const joined = text({ key: 'names.and', a: names.slice(0, -1).join('، '), b: names[names.length - 1] } as Line);
  return { key: 'asleep.many', g: people.some((id) => g(id) === 'm') ? 'm' : 'f', names: joined };
}
