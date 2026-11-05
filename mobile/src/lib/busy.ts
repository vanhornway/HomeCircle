// Busy times: this phone reads its own calendars (Google, iCloud, Outlook,
// whatever it's synced with) and shares when, sealed to the circle. Each person
// turns this on for themselves. Titles never leave the phone: only a start and
// an end go into what's shared. Nothing is written to anyone's calendar unless
// they tap "Add to my calendar" on a plan.
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Calendar from 'expo-calendar/legacy';
import { BUSY_DAYS, busyNow, type BusyBlock, type CircleClient, type PlanState } from '@homecircle/core';
import { diag } from './diagnostics';
import { getSettings } from './storage';

const SHARED_KEY = 'homecircle.busySharedAt';
const SHARE_EVERY_MS = 30 * 60_000;
const DAY = 86400_000;

export const askCalendar = async () => (await Calendar.requestCalendarPermissionsAsync()).granted;

/** Your busy blocks for the coming days. "Free" events don't count, and neither do cancelled ones. */
async function readBusy(): Promise<BusyBlock[]> {
  if (!(await Calendar.getCalendarPermissionsAsync()).granted) return [];
  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  const now = Date.now();
  const end = now + BUSY_DAYS * DAY;
  const events = await Calendar.getEventsAsync(calendars.map((c) => c.id), new Date(now), new Date(end));
  return events
    .filter((e) => e.availability !== Calendar.Availability.FREE && e.status !== Calendar.EventStatus.CANCELED)
    .map((e) => ({ s: new Date(e.startDate).getTime(), e: new Date(e.endDate).getTime() }))
    .filter((b) => b.e > now && b.s < end);
}

/** Bring what the circle sees up to date, at most every half hour unless `force`. Turned off, it's taken back. */
export async function shareBusyTimes(clients: CircleClient[], { force = false } = {}) {
  const last = Number((await AsyncStorage.getItem(SHARED_KEY)) || 0);
  if (!force && Date.now() - last < SHARE_EVERY_MS) return;
  const { shareBusy } = await getSettings();
  if (!shareBusy && !force) return;
  const mine = clients.filter((c) => c.account && c.feature('busyTimes'));
  const blocks = shareBusy ? await readBusy() : [];
  const results = await Promise.allSettled(mine.map((c) => (shareBusy ? c.shareBusy(blocks) : c.clearBusy())));
  await AsyncStorage.setItem(SHARED_KEY, String(Date.now()));
  diag('busy:share', { blocks: blocks.length, circles: results.filter((r) => r.status === 'fulfilled').length });
}

const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/** "Busy until 3:30 PM", "Free until 2:00 PM", or null when their phone hasn't said lately. */
export function busyLine(client: CircleClient, memberId: string, now = Date.now()): string | null {
  const b = client.feature('busyTimes') ? client.busy.get(memberId) : null;
  if (!b || now - b.ts > 2 * DAY) return null;
  const { busy, until } = busyNow(b.blocks, now);
  if (busy) return `Busy until ${until && sameDay(until, now) ? clock(until) : 'tomorrow or later'}`;
  return until && sameDay(until, now) ? `Free until ${clock(until)}` : 'Free the rest of today';
}

/** Hands the plan to the phone's own calendar app: the person checks it there and saves it themselves. */
export async function addPlanToCalendar(plan: PlanState) {
  await Calendar.createEventInCalendarAsync({
    title: plan.title,
    startDate: new Date(plan.start),
    endDate: new Date(plan.end),
    allDay: plan.allDay,
    location: plan.where || undefined,
    ...(Platform.OS === 'ios' ? { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } : {}),
  });
}
