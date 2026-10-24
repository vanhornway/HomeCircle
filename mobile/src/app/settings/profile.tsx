import { useState } from 'react';
import { Alert, Text, TextInput, View } from 'react-native';
import { Avatar, Button } from '../../components/ui';
import { GroupBody, SettingsGroup, SettingsPage } from '../../components/SettingsKit';
import { errorText, useCircles } from '../../lib/circle';
import { useCircle } from '../../lib/useCircle';
import { useTheme } from '../../theme';

/** Your name in the open circle (each circle can know you by a different name). */
export default function ProfileSettings() {
  const t = useTheme();
  const client = useCircle();
  const { clients } = useCircles();
  const me = client.me;
  const [draft, setDraft] = useState<string | null>(null);
  const name = draft ?? me?.name ?? '';
  const [saving, setSaving] = useState(false);
  const save = () => {
    setSaving(true);
    client
      .setName(name)
      .then(() => setDraft(null))
      .catch((e) => Alert.alert('Couldn’t save', errorText(e)))
      .finally(() => setSaving(false));
  };
  return (
    <SettingsPage title="Profile">
      <View style={{ alignItems: 'center', marginTop: 20, gap: 8 }}>
        <Avatar name={name || '?'} color={me?.color ?? t.muted} size={72} />
      </View>
      <SettingsGroup
        title={clients.length > 1 ? `Your name in ${client.circle.name}` : 'Your name'}
        footer={clients.length > 1 ? 'Each circle can know you by a different name. Switch circles to change it in another.' : 'What your family sees on the map and in chats.'}
      >
        <GroupBody>
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
            <TextInput
              value={name}
              onChangeText={setDraft}
              maxLength={40}
              placeholder="Your name"
              placeholderTextColor={t.muted}
              accessibilityLabel="Your name"
              style={{ flex: 1, color: t.text, fontSize: 17, minHeight: 44, borderBottomWidth: 1, borderBottomColor: t.line }}
            />
            <Button small variant="primary" title="Save" loading={saving} disabled={!name.trim() || name === me?.name} onPress={save} />
          </View>
        </GroupBody>
      </SettingsGroup>
      <Text style={{ color: t.muted, fontSize: 13, marginTop: 16, marginHorizontal: 4 }}>Your chirp, the sound others hear when you chirp them, is under Chirps & SOS.</Text>
    </SettingsPage>
  );
}
