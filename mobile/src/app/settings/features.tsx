import { useState } from 'react';
import { Alert, Text } from 'react-native';
import type { Features } from '@homecircle/core';
import { FeaturePicker } from '../../components/FeaturePicker';
import { PluginSetup } from '../../components/PluginSetup';
import { GroupBody, SettingsGroup, SettingsPage } from '../../components/SettingsKit';
import { errorText } from '../../lib/circle';
import { useCircle } from '../../lib/useCircle';
import { useTheme } from '../../theme';

/** What this circle has: admins switch features on and off; everyone else sees the list. */
export default function FeatureSettings() {
  const t = useTheme();
  const client = useCircle(['circle']);
  const admin = client.isAdmin;
  // While a change is on its way, show it straight away.
  const [pending, setPending] = useState<Features | null>(null);
  const value = pending ?? client.features;
  const change = (next: Features) => {
    setPending(next);
    client
      .setFeatures(next)
      .catch((e) => Alert.alert('Couldn’t change it', errorText(e)))
      .finally(() => setPending(null));
  };
  return (
    <SettingsPage title="Features">
      <SettingsGroup>
        <GroupBody>
          <Text style={{ color: t.muted, fontSize: 14, lineHeight: 20 }}>
            {admin
              ? `What ${client.circle.name} has. Turn off what your circle doesn’t want; it disappears from everyone’s phone. You can turn it back on any time.`
              : `What ${client.circle.name} has. Its admins choose.`}
          </Text>
        </GroupBody>
      </SettingsGroup>
      <FeaturePicker
        value={value}
        onChange={change}
        readOnly={!admin}
        // Plugins with settings: filled in here once they're on.
        below={(id) => (admin && !pending && client.feature(id) && (id === 'homeAssistant' || id === 'air') ? <PluginSetup client={client} id={id} /> : null)}
      />
    </SettingsPage>
  );
}
