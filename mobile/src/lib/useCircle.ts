import { useEffect, useReducer } from 'react';
import type { CircleClient } from '@homecircle/core';
import { getClient } from './circle';

const EVENTS = ['members', 'locations', 'messages', 'places', 'status', 'circle'] as const;

/** Re-renders the component whenever circle data changes. */
export function useCircle(events: readonly string[] = EVENTS): CircleClient {
  const client = getClient();
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const offs = events.map((e) => client.on(e, bump));
    return () => offs.forEach((off) => off());
  }, [client, events]);
  return client;
}

export function timeAgo(ts?: number | null): string {
  if (!ts) return 'never';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0].toUpperCase())
      .join('') || '?'
  );
}
