import { useCallback, useState } from 'react';
import { Linking, Platform } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Button } from '../../components/ui';
import { GroupBody, SettingsGroup, SettingsPage, ToggleRow } from '../../components/SettingsKit';
import { notificationPermission, registerPush } from '../../lib/push';
import { updateSettings, useSettings } from '../../lib/storage';
import { batteryUnrestricted, requestBatteryExemption } from '../../lib/health';
import { ensureNotificationChannels } from '../../lib/notify';

/** What notifications show, and whether they're allowed at all. */
export default function NotificationSettings() {
  const settings = useSettings();
  const [notif, setNotif] = useState<'granted' | 'denied' | 'undetermined' | null>(null);
  const [battery, setBattery] = useState<boolean | null>(null);
  useFocusEffect(
    useCallback(() => {
      notificationPermission()
        .then(setNotif)
        .catch(() => {});
      batteryUnrestricted().then(setBattery).catch(() => {});
    }, []),
  );
  // The server needs to know when this is turned on or off.
  const setBackup = async (on: boolean) => {
    await updateSettings({ backupAlerts: on });
    if (on) await ensureNotificationChannels().catch(() => {});
    registerPush().catch(() => {});
  };

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

      {Platform.OS === 'android' ? (
        <SettingsGroup
          title="When your phone is locked"
          footer="Android can hold back HomeCircle’s silent wake-ups while the phone is locked and idle, so a message doesn’t sound until you pick the phone up. Both settings below fix that; neither sends anything but a generic notice."
        >
          <ToggleRow
            title="Backup alert"
            detail={
              settings.backupAlerts
                ? 'If a message hasn’t reached this phone within seconds, your server sends one alert that says only “New message in your circle”. Android sounds it at once, and it is replaced by the real notification as soon as the phone catches up. Anyone who sees your lock screen could read that line.'
                : 'Off. Messages sound only when the phone lets HomeCircle wake up.'
            }
            value={settings.backupAlerts}
            onChange={setBackup}
          />
          {battery === false ? (
            <GroupBody>
              <Button small variant="primary" title="Let HomeCircle run in the background" onPress={() => requestBatteryExemption().finally(() => batteryUnrestricted().then(setBattery))} />
            </GroupBody>
          ) : null}
        </SettingsGroup>
      ) : null}

      <SettingsGroup title="Chats" footer="Delivered ticks (✓✓) always show. Read receipts work both ways, as in other messengers.">
        <ToggleRow
          title="Read receipts"
          detail={settings.readReceipts ? 'Others see when you’ve read their messages, and you see when they’ve read yours.' : 'Off: others don’t see when you’ve read, and you don’t see when they have.'}
          value={settings.readReceipts}
          onChange={(v) => updateSettings({ readReceipts: v })}
        />
      </SettingsGroup>
    </SettingsPage>
  );
}
