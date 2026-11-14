// Trackers → This phone: which tracker is paired with this phone (and when it
// was last near it), pairing one, and the phone bridge (lib/phoneBridge.ts):
// off by default; "Send it now" tries at once and says how it went.
import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import type { CircleClient } from '@homecircle/core';
import { Button, P } from './ui';
import { GroupBody, SettingsGroup, SettingsRow, ToggleRow } from './SettingsKit';
import { errorText } from '../lib/circle';
import { myTracker } from '../lib/meshOutbox';
import { usePaired } from '../lib/pairedTracker';
import { bridgeTick, phoneBridgeOn, setPhoneBridge } from '../lib/phoneBridge';
import { separation, separationText, useNow } from '../lib/trackers';
import { timeAgo } from '../lib/useCircle';

export function PhoneBridgeGroup({ client }: { client: CircleClient }) {
  const paired = usePaired();
  const tracker = myTracker(client);
  const now = useNow();
  const [on, setOn] = useState<boolean | null>(null);
  const [trying, setTrying] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    phoneBridgeOn().then(setOn);
  }, []);

  if (!client.feature('meshtastic') || on == null) return null;
  const sep = client.account ? separation(client, client.account.memberId, now) : null;
  const pairedDetail = paired
    ? [paired.node, paired.nearAt ? `near this phone ${timeAgo(paired.nearAt)}` : null, paired.battery != null ? `${paired.battery}%` : null].filter(Boolean).join(' · ')
    : 'Pair the tracker you carry: easier messages over the mesh, and its position passed on when you’re away';
  return (
    <SettingsGroup
      title="This phone"
      footer={
        tracker
          ? `When “Pass on” is on, this phone reads ${tracker.name}’s position over Bluetooth about every 10 minutes and passes it on, so it shows on the map wherever this phone has internet. It uses a little more battery.`
          : undefined
      }
    >
      <SettingsRow icon="locate" title={paired ? `Paired with ${paired.name}` : 'Pair your tracker'} detail={pairedDetail} onPress={() => router.push('/pair-tracker')} />
      {sep ? (
        <GroupBody>
          <P muted>{separationText(sep).replace('this phone', 'your phone')}</P>
        </GroupBody>
      ) : null}
      {tracker ? (
        <ToggleRow
          title={`Pass on ${tracker.name}’s position`}
          detail="Best with the Meshtastic app closed: the tracker talks to one app at a time."
          value={on}
          onChange={async (v) => {
            setOn(v);
            await setPhoneBridge(v);
          }}
        />
      ) : null}
      {tracker && on ? (
        <GroupBody>
          <Button
            small
            title="Send it now"
            loading={trying}
            onPress={async () => {
              setTrying(true);
              setResult(null);
              try {
                setResult(await bridgeTick([client], { force: true }));
              } catch (e) {
                setResult(errorText(e));
              } finally {
                setTrying(false);
              }
            }}
          />
          {result ? <P muted>{result}</P> : null}
        </GroupBody>
      ) : null}
    </SettingsGroup>
  );
}
