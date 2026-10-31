import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useCircles } from '../lib/circle';
import { attachCalls, pickUpCalls, startCallHost } from '../lib/calls';
import { useSkin } from '../skins';
import { CallScreen } from './CallScreen';

/**
 * Calls for the whole app: listens in every circle, shows the call screen over
 * whatever is open, and picks up a call the phone was woken for. Nothing
 * here for the Elderly Companion skin: she is never called in this release.
 */
export function CallHost() {
  const skin = useSkin();
  const { clients } = useCircles();
  const circlesKey = clients.map((c) => c.accountKey).join('|');
  useEffect(() => {
    if (skin === 'elderly') return;
    for (const c of clients) attachCalls(c);
    const off = startCallHost();
    // Coming forward again (a tap on the notification): anything that waited.
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') pickUpCalls();
    });
    return () => {
      off();
      sub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skin, circlesKey]);
  return skin === 'elderly' ? null : <CallScreen />;
}
