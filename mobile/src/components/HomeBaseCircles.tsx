// "Use it in another circle": the same home base (and the trackers it keeps)
// in up to 3 circles. The app makes an invite in the other circle, sends the
// home base "join <link>", and once it has joined there makes it an admin and
// turns Meshtastic trackers on, as you would by hand. Only circles where you're
// an admin; a circle that already has this home base is left out.
import { useState } from 'react';
import type { CircleClient } from '@homecircle/core';
import { SettingsRow } from './SettingsKit';
import { errorText } from '../lib/circle';
import { notice, showSheet } from '../lib/sheet';
import { homeBaseOf, tellHomeBase } from '../lib/trackers';
import { useAllCircles } from '../lib/useCircle';

const MAX_CIRCLES = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function HomeBaseCircles({ client }: { client: CircleClient }) {
  const circles = useAllCircles(['members', 'records', 'circle']);
  const [busy, setBusy] = useState<string | null>(null);
  const home = homeBaseOf(client);
  if (!home || !client.isAdmin) return null;
  const node = home.status.node;
  // Circles that already have this home base (it reports the same node there).
  const hasIt = (c: CircleClient) => !!node && homeBaseOf(c)?.status.node === node;
  const using = circles.filter(hasIt);
  const others = circles.filter((c) => c.circleId !== client.circleId && c.isAdmin && !hasIt(c));

  const join = async (other: CircleClient) => {
    const name = other.circle.name;
    setBusy(name);
    try {
      const sentAt = Date.now();
      const { link } = await other.createInvite({ hours: 1 });
      await tellHomeBase(client, home.id, `join ${link}`);
      // It joins within half a minute or so: then it needs to be an admin there, with trackers on.
      for (let i = 0; i < 30; i++) {
        await sleep(3000);
        await other.refresh();
        const joined = other.memberList().find((m) => m.name === 'Home base' && m.joinedAt >= sentAt - 60_000);
        if (!joined) continue;
        if (joined.role === 'member') await other.setRole(joined.id, 'admin');
        if (!other.feature('meshtastic')) await other.setFeatures({ ...other.features, meshtastic: true });
        notice(`${home.name} is in ${name} too`, `It’s an admin there and Meshtastic trackers are on. In ${name}, add trackers from Trackers: ones it already keeps here show under “Heard nearby”. Their settings stay with the circle that added them first.`);
        return;
      }
      notice('Sent to the home base', `It hasn’t joined ${name} yet. Its answer comes in your chat with it here; if it joins later, make “Home base” an admin in ${name} and turn on Meshtastic trackers there.`);
    } catch (e) {
      notice('Couldn’t add it there', errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const choose = () => {
    if (using.length >= MAX_CIRCLES) {
      notice('In 3 circles already', `${home.name} is the home base in ${MAX_CIRCLES} circles, the most it takes. To use it elsewhere, send it “leave” in one of them first.`);
      return;
    }
    if (!others.length) {
      notice('No other circle to add it to', 'It can be added to another circle on this phone where you’re an admin. Join or start that circle first.');
      return;
    }
    showSheet(`Use ${home.name} in another circle`, 'The same home base and radio, with its own trackers there. A tracker can be in both circles: each gets its positions, presses and SOS.', [
      ...others.slice(0, 5).map((c) => ({ text: c.circle.name, onPress: () => void join(c) })),
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  };

  const detail = busy
    ? `Adding it to ${busy}…`
    : using.length > 1
      ? `Also in ${using.filter((c) => c.circleId !== client.circleId).map((c) => c.circle.name).join(', ')} · up to ${MAX_CIRCLES} circles`
      : `Its trackers in another circle of yours too (up to ${MAX_CIRCLES})`;
  return <SettingsRow icon="users" title="Use it in another circle" detail={detail} onPress={busy ? undefined : choose} />;
}
