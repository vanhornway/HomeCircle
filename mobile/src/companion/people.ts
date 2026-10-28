// What her app knows about each circle and person beyond what HomeCircle
// shows. Until admins set these from HomeCircle (her config and family names),
// a circle's page comes from the invite she joined with, and everyone is
// spoken of as "he" (the respectful plural most families use by default).
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

/** Which page a circle is on her phone: a care circle (SOS, reminders) or grandkids. */
export function pageOf(client: CircleClient): Page {
  return (client.circleId && pages[client.circleId]) || 'care';
}

/** He or she, for Urdu verbs about a person. */
export function genderOf(_client: CircleClient, _memberId: string): Gender {
  return 'm';
}

/** Her time zone, sent with each request so the family sees her time. */
export function myTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** The people on her page: everyone else in the circle, not its helper. */
export function tilePeople(client: CircleClient) {
  return client.memberList().filter((m) => !m.isMe);
}
