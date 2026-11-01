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
      <SettingsGroup
        footer="Choose what shows on your lock screen."
        how={[
          'Messages are decrypted on this phone before they’re shown.',
          'The push service that wakes your phone only learns that something arrived. It never sees who wrote or what they said.',
        ]}
      >
        <ToggleRow
          title="Show message text"
          detail={settings.showPreviews ? 'Shows who wrote and what they said.' : 'Just says “New message”.'}
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
          footer={
            battery === false
              ? 'Android can delay message sounds while your phone is locked. Letting HomeCircle run in the background and the backup alert both help.'
              : 'Android can delay message sounds while your phone is locked. The backup alert covers for that.'
          }
          how={[
            'Android can hold back HomeCircle’s silent wake-ups while the phone is locked and idle, so a message doesn’t sound until you pick the phone up.',
            'The backup alert: if a message hasn’t reached this phone within seconds, your server sends one alert that says only “New message in your circle”. Android sounds it at once, and the real notification replaces it as soon as the phone catches up. Anyone who sees your lock screen could read that line.',
            ...(battery === false ? ['Letting HomeCircle run in the background lets Android wake it as usual. It sends nothing extra.'] : []),
          ]}
          howTitle="Why messages can be late"
        >
          <ToggleRow
            title="Backup alert"
            detail={settings.backupAlerts ? 'If a message is late, you get one alert: “New message in your circle”.' : 'Off. Messages sound only when Android lets HomeCircle wake up.'}
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

      <SettingsGroup title="Chats" footer="Delivered ticks (✓✓) always show.">
        <ToggleRow
          title="Read receipts"
          detail={settings.readReceipts ? 'Others see when you’ve read, and you see when they have.' : 'Off. You don’t see read receipts and neither do they.'}
          value={settings.readReceipts}
          onChange={(v) => updateSettings({ readReceipts: v })}
        />
      </SettingsGroup>
    </SettingsPage>
  );
}
