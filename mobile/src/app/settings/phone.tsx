import { Text } from 'react-native';
import { router } from 'expo-router';
import { Button } from '../../components/ui';
import { GroupBody, SettingsGroup, SettingsPage, SettingsRow } from '../../components/SettingsKit';
import { useServerState } from '../../lib/connection';
import { useCircle } from '../../lib/useCircle';
import { APP_VERSION } from '../../lib/updates';
import { useTheme } from '../../theme';

/** This phone: whether it's set up to share reliably, its log, and the server it talks to. */
export default function PhoneSettings() {
  const t = useTheme();
  const client = useCircle();
  const server = useServerState();
  return (
    <SettingsPage title="This phone">
      <SettingsGroup>
        <SettingsRow icon="✅" title="Setup check" detail="Location, battery and notifications set so your circle always sees where you are" href="/setup-check" />
        <SettingsRow icon="🩺" title="Diagnostics" detail="A 7-day log of what HomeCircle did in the background" href="/diagnostics" />
      </SettingsGroup>

      <SettingsGroup title="Server">
        <GroupBody gap={4}>
          <Text style={{ color: t.text, fontSize: 15 }}>{client.serverUrl?.replace(/^https?:\/\//, '')}</Text>
          <Text style={{ color: server.reachable ? t.muted : t.danger, fontSize: 13 }}>
            {server.reachable ? `Key version ${client.account?.epoch} · ${client.status} · end-to-end encrypted` : 'Not reachable right now'}
          </Text>
          <Button small title="Change server address" style={{ marginTop: 8 }} onPress={() => router.push('/server')} />
        </GroupBody>
      </SettingsGroup>

      <Text style={{ color: t.muted, fontSize: 13, textAlign: 'center', marginTop: 24 }}>HomeCircle {APP_VERSION}</Text>
    </SettingsPage>
  );
}
