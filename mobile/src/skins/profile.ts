// A person's profile as an admin thinks of it: the full app, or the Elderly
// Companion with its care circle page or its grandkids page. It is stored as
// a skin and a page in the sealed `member` record about them. Kept free of
// React Native imports so it is tested in Node.

export type Profile = 'full' | 'care' | 'grandkids';

export const PROFILES: { id: Profile; label: string; detail: string }[] = [
  { id: 'full', label: 'Full app', detail: 'HomeCircle as everyone else has it' },
  { id: 'care', label: 'Elder · care circle', detail: 'Big photo tiles: Ring everyone and SOS' },
  { id: 'grandkids', label: 'Elder · grandkids', detail: 'Big photo tiles for a grandchild’s side: no SOS to the family' },
];

type RecordLike = { skin?: string | null; page?: string | null } | null | undefined;

/** The profile a member record names (the full app when there is none). */
export function profileOf(rec: RecordLike): Profile {
  if (rec?.skin !== 'elderly') return 'full';
  return rec.page === 'grandkids' ? 'grandkids' : 'care';
}

/** What to save to give a member this profile. Going back to full keeps the page they had. */
export function profilePatch(p: Profile): { skin: 'full' | 'elderly'; page?: 'care' | 'grandkids' } {
  return p === 'full' ? { skin: 'full' } : { skin: 'elderly', page: p };
}

export const profileLabel = (p: Profile) => PROFILES.find((x) => x.id === p)!.label;

/** The skin this phone should show, from what each of its circles says: the most restricted (locked) one wins. */
export function pickSkin<S extends string>(said: S[], isLocked: (s: S) => boolean): S | null {
  if (!said.length) return null;
  return said.find(isLocked) ?? said[0];
}

type Seen = { skin?: string | null; page?: string | null; ts: number } | null | undefined;

export type SkinStatus = { state: 'none' | 'waiting' | 'late' | 'updated' | 'unknown'; text: string };

/** How long an admin waits before being told the phone may be offline. */
export const LATE_MS = 30 * 60_000;

/**
 * Where a switch stands, for the admin: the record says what it should be,
 * `seen` is the last location that phone sent, which says what it is showing
 * (0.22.1+). A phone that hasn't reported since the change is "waiting".
 */
export function skinStatus(rec: (RecordLike & { ts?: number }) | null | undefined, seen: Seen, name: string, now = Date.now()): SkinStatus {
  if (!rec) return { state: 'none', text: '' };
  const want = profileOf(rec);
  const savedAt = rec.ts ?? 0;
  if (!seen) return { state: 'unknown', text: `Saved. ${name}’s phone switches the next time it’s online.` };
  const showing = seen.skin == null ? null : profileOf({ skin: seen.skin, page: seen.page });
  if (seen.ts >= savedAt && showing === want) return { state: 'updated', text: `Updated: ${name}’s phone is showing ${profileLabel(want)}.` };
  if (now - savedAt > LATE_MS) return { state: 'late', text: `${name}’s phone hasn’t switched yet. It may be offline or closed, or in another circle that keeps it on a different profile. It switches by itself when it connects.` };
  return { state: 'waiting', text: `Waiting for ${name}’s phone…` };
}
