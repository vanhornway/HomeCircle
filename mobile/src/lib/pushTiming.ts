// How long a message's push took to become a notification on this phone,
// worked out from the diagnostics log. Plain functions, checked with:
//   node --test src/lib/pushTiming.test.ts
//
// 'wake:push' (type=message) is written when Android hands the app the silent
// wake-up; lagS is how long it was in transit (the sender's time stamp to now),
// so it is big when Android held the push back while the phone was locked.
// 'push:shown' is written once the notification is on screen; tookMs is the
// time from the wake-up to that. 'push:backup-cleared' is a generic backup
// alert taken down after the real one was shown.

type Entry = { t: number; e: string; d?: Record<string, unknown> };

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const median = (xs: number[]) => (xs.length ? xs[Math.floor((xs.length - 1) / 2)] : null);

/** Wake-ups closer together than this are one burst (a held-back batch delivered at once). */
const BURST_GAP_MS = 10_000;
/** Late enough that a person would notice. */
export const LATE_S = 60;

export function pushTiming(entries: Entry[]) {
  const wakes = entries.filter((x) => x.e === 'wake:push' && x.d?.type === 'message').sort((a, b) => a.t - b.t);
  const lags = wakes.map((x) => num(x.d?.lagS)).filter((n): n is number => n !== null && n >= 0).sort((a, b) => a - b);
  const took = entries
    .filter((x) => x.e === 'push:shown')
    .map((x) => num(x.d?.tookMs))
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);
  // Runs of three or more wake-ups within seconds of each other.
  let bursts = 0;
  let run = 1;
  for (let i = 1; i <= wakes.length; i++) {
    if (i < wakes.length && wakes[i].t - wakes[i - 1].t <= BURST_GAP_MS) run++;
    else {
      if (run >= 3) bursts++;
      run = 1;
    }
  }
  return {
    wakes: wakes.length,
    measured: lags.length,
    medianLagS: median(lags),
    maxLagS: lags.length ? lags[lags.length - 1] : null,
    late: lags.filter((n) => n > LATE_S).length,
    bursts,
    // Sent as high priority, delivered as normal: Android's own downgrade.
    downgraded: wakes.filter((x) => x.d?.sent === 'high' && x.d?.prio === 'normal').length,
    shown: took.length,
    medianTookS: median(took) === null ? null : Math.round((median(took) as number) / 100) / 10,
    backupCleared: entries.filter((x) => x.e === 'push:backup-cleared').length,
  };
}

const span = (s: number) => (s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 360) / 10} h`);

/** A few readable lines, or none when no message push has been logged. */
export function pushTimingLines(entries: Entry[]): string[] {
  const p = pushTiming(entries);
  if (!p.wakes) return [];
  const lines = [`Message pushes: ${p.wakes} woke the app${p.shown ? `, ${p.shown} shown` : ''}.`];
  if (p.measured) {
    lines.push(`In transit: usually ${span(p.medianLagS!)}, slowest ${span(p.maxLagS!)}; ${p.late} arrived more than a minute late${p.bursts ? `; ${p.bursts} arrived in a burst` : ''}.`);
  }
  if (p.downgraded) lines.push(`${p.downgraded} of ${p.wakes} were delivered at normal priority although sent as high: Android lowers them for apps it thinks are idle, and then holds them while the phone is locked.`);
  if (p.medianTookS !== null) lines.push(`From wake-up to notification: usually ${p.medianTookS} s.`);
  if (p.backupCleared) lines.push(`Backup alerts replaced by the real notification: ${p.backupCleared}.`);
  return lines;
}
