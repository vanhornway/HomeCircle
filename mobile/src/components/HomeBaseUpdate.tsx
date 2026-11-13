// The home base's firmware version, like the app's own in Settings: tap to
// check GitHub for a newer one, tap again (an admin) and the home base
// downloads it over its Wi-Fi, checks it and restarts into it ("update <link>
// <sha256>" in its chat; devices/meshtastic/README.md). The row says
// "Updating…" until the home base reports the new version.
import { useState, useSyncExternalStore } from 'react';
import type { CircleClient } from '@homecircle/core';
import { SettingsRow } from './SettingsKit';
import { errorText } from '../lib/circle';
import { confirm, notice } from '../lib/sheet';
import { compareVersions, homeBaseOf, latestHomeBaseFirmware, tellHomeBase, useNow, type HomeBaseFirmware } from '../lib/trackers';

// What was checked, and an update sent, per home base: kept while the app runs.
type Seen = { latest: HomeBaseFirmware | null; checkedAt: number; sent: { version: string; at: number } | null };
const seen = new Map<string, Seen>();
const listeners = new Set<() => void>();
let version = 0;
const set = (id: string, patch: Partial<Seen>) => {
  seen.set(id, { latest: null, checkedAt: 0, sent: null, ...seen.get(id), ...patch });
  version++;
  listeners.forEach((l) => l());
};
const useSeen = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );

/** The home base's version row (nothing if the circle has no home base). */
export function HomeBaseUpdateRow({ client }: { client: CircleClient }) {
  useSeen();
  const [checking, setChecking] = useState(false);
  const now = useNow();
  const home = homeBaseOf(client);
  if (!home || !client.feature('meshtastic')) return null;
  const fw = home.status.fw ?? null;
  const s = seen.get(home.id);
  const latest = s?.latest ?? null;
  const newer = fw && latest && compareVersions(latest.version, fw) > 0 ? latest : null;
  // Sent, and not yet on it: updating (it gives up after 10 minutes and says so in its chat).
  const sent = s?.sent && fw !== s.sent.version && now - s.sent.at < 10 * 60_000 ? s.sent : null;
  const updated = s?.sent && fw === s.sent.version ? s.sent.version : null;

  const update = async (f: HomeBaseFirmware) => {
    if (!client.isAdmin) {
      notice(`Home base ${f.version} is out`, 'Ask an admin of the circle to update it: Settings → Home base.');
      return;
    }
    const mb = (f.size / 1048576).toFixed(1);
    const ok = await confirm(
      `Update the home base to ${f.version}?`,
      `It downloads it (${mb} MB) over its Wi-Fi, checks it and restarts: about 2 minutes, with no tracker updates meanwhile. If ${f.version} doesn’t start properly, it goes back to ${fw} by itself. It says how it went in its chat.`,
      'Update',
    );
    if (!ok) return;
    try {
      await tellHomeBase(client, home.id, `update ${f.url} ${f.sha256}`);
      set(home.id, { sent: { version: f.version, at: Date.now() } });
    } catch (e) {
      notice('Couldn’t send it to the home base', errorText(e));
    }
  };

  const onPress = async () => {
    if (sent) return;
    if (!fw) {
      notice('Update it over USB once', 'This home base is older than 0.29, which can’t update itself yet. Flash it once over USB (devices/meshtastic); after that it updates over its Wi-Fi from here.');
      return;
    }
    if (newer) return update(newer);
    setChecking(true);
    const f = await latestHomeBaseFirmware();
    setChecking(false);
    set(home.id, { latest: f, checkedAt: Date.now() });
    if (f && compareVersions(f.version, fw) > 0) return update(f);
    if (!f) notice('Couldn’t check for updates', 'GitHub didn’t answer, or the latest release has no home base firmware. Try again later.');
  };

  const detail = !fw
    ? 'Older than 0.29: update it over USB once, then it updates from here'
    : sent
      ? `Updating to ${sent.version}: downloading and restarting, about 2 minutes`
      : updated
        ? `Updated to ${updated}`
        : checking
          ? 'Checking…'
          : newer
            ? `${newer.version} is out. Tap to update it${client.isAdmin ? '' : ' (admins)'}`
            : s?.checkedAt
              ? 'It has the latest version'
              : 'Tap to check for a new version';
  return <SettingsRow icon="refresh" title={`Home base ${fw ?? ''}`.trim()} detail={detail} badge={newer && !sent ? '1' : null} onPress={onPress} />;
}
