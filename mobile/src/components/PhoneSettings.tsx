import { useState } from 'react';
import { Alert, Text, TextInput, View } from 'react-native';
import type { CircleClient } from '@homecircle/core';
import { Button } from './ui';
import { GroupBody, SettingsGroup } from './SettingsKit';
import { errorText } from '../lib/circle';
import { NUMBER_PROBLEMS, cleanNumber } from '../lib/whatsappCore';
import { useTheme } from '../theme';

/** "+923001234567" from what was typed, '' for nothing, or an Alert and null when it can't be used. */
function checked(typed: string): string | null {
  if (!typed.trim()) return '';
  const n = cleanNumber(typed);
  if (n.ok) return `+${n.digits}`;
  Alert.alert('Check the phone number', NUMBER_PROBLEMS[n.problem]);
  return null;
}

function PhoneEditor({ saved, label, onSave }: { saved: string | null; label: string; onSave: (phone: string) => Promise<unknown> }) {
  const t = useTheme();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const value = draft ?? saved ?? '';
  const save = () => {
    const phone = checked(value);
    if (phone === null) return;
    setSaving(true);
    onSave(phone)
      .then(() => setDraft(null))
      .catch((e) => Alert.alert('Couldn’t save', errorText(e)))
      .finally(() => setSaving(false));
  };
  return (
    <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
      <TextInput
        value={value}
        onChangeText={setDraft}
        maxLength={30}
        placeholder="+1 555 123 4567"
        placeholderTextColor={t.muted}
        keyboardType="phone-pad"
        autoComplete="tel"
        accessibilityLabel={label}
        style={{ flex: 1, color: t.text, fontSize: 17, minHeight: 44, borderBottomWidth: 1, borderBottomColor: t.line }}
      />
      <Button small variant="primary" title="Save" loading={saving} disabled={draft === null || (draft.trim() === '' && !saved)} onPress={save} />
    </View>
  );
}

/** Your own phone number, for Settings → You → Profile: sealed in your profile, so only your circle sees it. */
export function MyPhoneGroup({ client }: { client: CircleClient }) {
  const me = client.me;
  return (
    <SettingsGroup title="Phone number" footer="Optional. Shown only to people in this circle, end-to-end encrypted like everything else. It lets them tap “Call on WhatsApp”. Start with the country code, such as +1 or +92.">
      <GroupBody>
        <PhoneEditor saved={me?.phone ?? null} label="Your phone number" onSave={(p) => client.setPhone(p)} />
      </GroupBody>
    </SettingsGroup>
  );
}

/** An elder's phone number, for admins: sealed in her member record. It's used when she hasn't added one herself. */
export function ElderPhoneGroup({ client, memberId, admin }: { client: CircleClient; memberId: string; admin: boolean }) {
  const t = useTheme();
  const m = client.members.get(memberId);
  const own = m?.phone ?? null;
  return (
    <SettingsGroup title="Phone number" footer="For “Call on WhatsApp” in the family’s app, never on her phone. Encrypted, so only the circle can read it. Start with the country code, such as +92.">
      <GroupBody>
        {admin ? (
          <PhoneEditor saved={client.memberRecord(memberId)?.phone ?? null} label="Her phone number" onSave={(p) => client.setMemberRecord(memberId, { phone: p || null })} />
        ) : (
          <Text style={{ color: t.text, fontSize: 16 }}>{client.phoneOf(memberId) ?? 'None saved'}</Text>
        )}
        {own ? <Text style={{ color: t.muted, fontSize: 13 }}>She added her own number ({own}), which the family’s app uses instead.</Text> : null}
      </GroupBody>
    </SettingsGroup>
  );
}
