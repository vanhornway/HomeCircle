// Trackers → This phone: the phone bridge (lib/phoneBridge.ts), for whoever
// carries a tracker. Off by default; "Send it now" tries at once and says how
// it went.
import { useEffect, useState } from 'react';
import type { CircleClient } from '@homecircle/core';
import { Button, P } from './ui';
import { GroupBody, SettingsGroup, ToggleRow } from './SettingsKit';
import { errorText } from '../lib/circle';
import { myTracker } from '../lib/meshOutbox';
import { bridgeTick, phoneBridgeOn, setPhoneBridge } from '../lib/phoneBridge';

export function PhoneBridgeGroup({ client }: { client: CircleClient }) {
  const tracker = myTracker(client);
  const [on, setOn] = useState<boolean | null>(null);
  const [trying, setTrying] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    phoneBridgeOn().then(setOn);
  }, []);

  if (!tracker || on == null) return null;
  return (
    <SettingsGroup
      title="This phone"
      footer={`When it’s on, this phone reads ${tracker.name}’s position over Bluetooth about every 10 minutes and passes it on, so ${tracker.name} shows on the map wherever this phone has internet. It uses a little more battery.`}
    >
      <ToggleRow
        title={`Pass on ${tracker.name}’s position`}
        detail="Best with the Meshtastic app closed: the tracker talks to one app at a time."
        value={on}
        onChange={async (v) => {
          setOn(v);
          await setPhoneBridge(v);
        }}
      />
      {on ? (
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
