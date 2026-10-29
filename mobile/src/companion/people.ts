// What her app knows about each circle and person beyond what HomeCircle
// shows: her settings for each circle (the admins' member record about her)
// and what she calls each person (her family names, in Urdu). Until an admin
// has saved a record, a circle's page comes from the invite she joined with;
// a person with no he/she set is spoken of as "he" (the respectful plural
// most families use by default).
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CircleClient } from '@homecircle/core';
import type { Gender } from './lines';

export type Page = 'care' | 'grandkids';
const KEY = 'companion.pages';
let pages: Record<string, Page> = {};

export async function loadPages() {
  try {
    pages = JSON.parse((await AsyncStorage.getItem(KEY)) || '{}');
  } catch {
    pages = {};
  }
}

export async function setPage(circleId: string, page: Page) {
  pages = { ...pages, [circleId]: page };
  await AsyncStorage.setItem(KEY, JSON.stringify(pages));
}

const mine = (client: CircleClient) => (client.account ? client.memberRecord(client.account.memberId) : null);

/** Which page a circle is on her phone: a care circle (SOS, reminders) or grandkids. */
export function pageOf(client: CircleClient): Page {
  return mine(client)?.page || (client.circleId && pages[client.circleId]) || 'care';
}

/** Her settings for a circle, with the defaults: Ring everyone on in a care circle, reminders every 10 minutes there. */
export function settingsOf(client: CircleClient) {
  const r = mine(client);
  const care = pageOf(client) === 'care';
  return {
    care,
    ringEveryone: r?.ringEveryone ?? care,
    games: r?.games ?? true,
    // Grandkids circles get one notification and no reminders (decided).
    remindEvery: care ? (r?.remindEvery ?? 10) : 0,
    sleep: r?.sleep ?? null,
    lang: r?.lang ?? 'ur',
  };
}

/** Whether it's her sleep hours now (her phone's clock), in any circle that set them. */
export function inSleepHours(clients: CircleClient[], now = new Date()): boolean {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const at = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  return clients.some((c) => {
    const s = settingsOf(c).sleep;
    if (!s) return false;
    const from = at(s.from);
    const to = at(s.to);
    return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
  });
}

/** He or she, for Urdu verbs about a person. */
export function genderOf(client: CircleClient, memberId: string): Gender {
  return client.genderOf(memberId) ?? 'm';
}

/** What she calls a person (her family name for them, in Urdu), else their own name. */
export function tileName(client: CircleClient, memberId: string): string {
  return client.displayName(memberId);
}

/** Her time zone, sent with each request so the family sees her time. */
export function myTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** The people on her page, in the order an admin chose (anyone not placed comes after). */
export function tilePeople(client: CircleClient) {
  // Someone whose profile this phone can't read yet has no name to show her: left off until it can.
  const people = client.memberList().filter((m) => !m.isMe && m.verified);
  const order = mine(client)?.tiles ?? [];
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  return people.sort((a, b) => rank(a.id) - rank(b.id));
}
