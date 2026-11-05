import { useState } from 'react';
import { Linking, Text } from 'react-native';
import { GroupBody, SettingsGroup, SettingsPage, ToggleRow } from '../../components/SettingsKit';
import { allClients } from '../../lib/circle';
import { askCalendar, shareBusyTimes } from '../../lib/busy';
import { updateSettings, useSettings } from '../../lib/storage';
import { useTheme } from '../../theme';
import { showSheet } from '../../lib/sheet';

/** Busy times: your own choice, on your own phone. */
export default function CalendarSettings() {
  const t = useTheme();
  const settings = useSettings();
  const [busy, setBusy] = useState(false);

  const change = async (on: boolean) => {
    setBusy(true);
    try {
      if (on && !(await askCalendar())) {
        showSheet('HomeCircle can’t read your calendar', 'Allow Calendar for HomeCircle in your phone’s settings, then try again.', [
          { text: 'Not now', style: 'cancel' },
          { text: 'Open settings', onPress: () => Linking.openSettings() },
        ]);
        return;
      }
      await updateSettings({ shareBusy: on });
      await shareBusyTimes(allClients(), { force: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsPage title="Calendar">
      <SettingsGroup title="Busy times" how="Your phone reads its own calendars, whichever accounts it's synced with, and shares only when you're busy, sealed so that only your circle can read it.">
        <ToggleRow title="Share when I’m busy" detail={settings.shareBusy ? 'On · your circle sees the times for the next two weeks' : 'Off · nobody sees your calendar'} value={settings.shareBusy} onChange={change} disabled={busy} />
        <GroupBody gap={6}>
          <Text style={{ color: t.text, fontSize: 15 }}>Only the times are shared, never what for.</Text>
          <Text style={{ color: t.muted, fontSize: 14 }}>Events marked Free don’t count. Plans from the chat go into your calendar only when you tap Add to my calendar.</Text>
        </GroupBody>
      </SettingsGroup>
    </SettingsPage>
  );
}
