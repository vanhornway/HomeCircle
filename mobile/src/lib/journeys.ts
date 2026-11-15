// Journeys: a tracker marked "on the move" has the way it goes kept until it's
// back home (the server keeps its sealed positions; this phone opens them).
// What the app says about one, and the ways to draw on the map.
import { useEffect, useState } from 'react';
import { distanceM, type CircleClient, type Journey, type JourneyPoint } from '@homecircle/core';
import { formatDistance } from './units';

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const day = (ms: number, now: number) => {
  const d = new Date(ms);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === new Date(now - 86400_000).toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
};

/** How far it went, in metres, along the way. */
export function pathMeters(points: { lat: number; lng: number }[]): number {
  let m = 0;
  for (let i = 1; i < points.length; i++) m += distanceM(points[i - 1], points[i]);
  return m;
}

export const distanceText = (m: number) => formatDistance(m);

export function durationText(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return mins % 60 ? `${h} h ${mins % 60} min` : `${h} h`;
}

/** "Today 10:32 AM – 11:40 AM · 1 h 8 min", or "Today 10:32 AM · on the move". */
export function journeyWhen(j: Journey, now = Date.now()): string {
  if (!j.endedAt) return `${day(j.startedAt, now)} ${clock(j.startedAt)} · on the move`;
  const sameDay = new Date(j.startedAt).toDateString() === new Date(j.endedAt).toDateString();
  return `${day(j.startedAt, now)} ${clock(j.startedAt)} – ${sameDay ? '' : `${day(j.endedAt, now)} `}${clock(j.endedAt)} · ${durationText(j.endedAt - j.startedAt)}`;
}

/** How it ended, in a few words. */
export function journeyEnd(j: Journey): string {
  if (!j.endedAt) return 'Ends by itself when it’s back home';
  return { home: 'Back home', manual: 'Ended by hand', full: 'Stopped: it kept too many positions', time: 'Stopped after 3 days' }[j.endReason ?? 'manual'] ?? 'Ended';
}

/** The sheet's line for a tracker on the move. */
export function onTheMoveLine(j: Journey): string {
  return `On the move since ${clock(j.startedAt)} · ${j.points} position${j.points === 1 ? '' : 's'} so far`;
}

/**
 * The ways of the journeys to draw: every open one (kept fresh as its tracker
 * reports), and `extra`, one opened from the Journeys list. Points come back
 * in order, opened on this phone.
 */
export function useJourneyPaths(client: CircleClient, extra: string | null): Map<string, { journey: Journey; points: JourneyPoint[] }> {
  const [paths, setPaths] = useState(() => new Map<string, { journey: Journey; points: JourneyPoint[] }>());
  const open = [...client.journeys.values()];
  // Fetch again when a tracker on the move reports (its latest position changes).
  const key = [...open.map((j) => `${j.id}:${client.locations.get(j.memberId)?.ts ?? 0}:${j.points}`), extra ?? ''].join('|');
  useEffect(() => {
    let alive = true;
    const ids = [...new Set([...open.map((j) => j.id), ...(extra ? [extra] : [])])];
    Promise.all(ids.map((id) => client.journeyPath(id).catch(() => null))).then((all) => {
      if (!alive) return;
      setPaths(new Map(all.flatMap((p) => (p ? [[p.journey.id, p] as const] : []))));
    });
    return () => {
      alive = false;
    };
    // `key` covers the open journeys and their trackers' latest positions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);
  return paths;
}
