import { useCallback, useState } from 'react';
import { Linking } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Button } from '../../components/ui';
import { GroupBody, SettingsGroup, SettingsPage, ToggleRow } from '../../components/SettingsKit';
import { notificationPermission, registerPush } from '../../lib/push';
import { updateSettings, useSettings } from '../../lib/storage';

/** What notifications show, and whether they're allowed at all. */
export default function NotificationSettings() {
  const settings = useSettings();
  const [notif, setNotif] = useState<'granted' | 'denied' | 'undetermined' | null>(null);
  useFocusEffect(
    useCallback(() => {
      notificationPermission()
        .then(setNotif)
        .catch(() => {});
    }, []),
  );
  return (
    <SettingsPage title="Notifications">
      <SettingsGroup footer="Messages are decrypted on this phone before they’re shown. The push service only learns that something arrived.">
        <ToggleRow
          title="Show message text"
          detail={settings.showPreviews ? 'Notifications show who wrote and what they said.' : 'Notifications just say “New message”.'}
          value={settings.showPreviews}
          onChange={(v) => updateSettings({ showPreviews: v })}
        />
        {notif && notif !== 'granted' ? (
          <GroupBody>
            <Button
              small
              variant="primary"
              title={notif === 'denied' ? 'Turn on notifications in system settings' : 'Allow notifications'}
              onPress={() => (notif === 'denied' ? Linking.openSettings() : registerPush({ ask: true }).finally(() => notificationPermission().then(setNotif)))}
            />
          </GroupBody>
        ) : null}
      </SettingsGroup>
    </SettingsPage>
  );
}
