import { useState } from 'react';
import { Alert, Text } from 'react-native';
import { router } from 'expo-router';
import { GroupBody, SettingsGroup, SettingsPage, SettingsRow } from '../components/SettingsKit';
import { Chips } from '../components/FamilyNames';
import { errorText } from '../lib/circle';
import { useCircle } from '../lib/useCircle';
import { useTheme } from '../theme';

const EVENTS = ['members', 'records'] as const;

/**
 * Mark someone as an elder (design 13): someone already in the circle (their
 * phone switches to the Elderly Companion screens and they stop being an
 * admin), or someone new, with an invite.
 */
export default function MarkElder() {
  const t = useTheme();
  const client = useCircle(EVENTS);
  const [page, setPage] = useState<'care' | 'grandkids'>('care');
  const [busy, setBusy] = useState<string | null>(null);
  const candidates = client.memberList().filter((m) => !m.isMe && m.role !== 'owner' && client.memberRecord(m.id)?.skin !== 'elderly');

  const mark = (id: string, name: string, admin: boolean) => {
    const go = () => {
      setBusy(id);
      client
        .markElder(id, { page, ringEveryone: page === 'care' })
        .then(() => router.replace({ pathname: '/elder', params: { member: id } }))
        .catch((e) => Alert.alert('Couldn’t mark them', errorText(e)))
        .finally(() => setBusy(null));
    };
    Alert.alert(
      `Mark ${name} as an elder?`,
      `${name}’s phone switches to the simple Elderly Companion screens, with no way back to the full app from that phone.${admin ? ` ${name} also stops being an admin.` : ''}`,
      [{ text: 'Cancel', style: 'cancel' }, { text: 'Mark as elder', onPress: go }],
    );
  };

  return (
    <SettingsPage title="Mark someone as an elder">
      <SettingsGroup title="This circle is her">
        <GroupBody>
          <Chips
            options={[
              { value: 'care', label: 'Care circle' },
              { value: 'grandkids', label: 'Grandkids' },
            ]}
            value={page}
            onPick={setPage}
          />
          <Text style={{ color: t.muted, fontSize: 13 }}>{page === 'care' ? 'Adult children: SOS, Ring everyone, reminders until someone calls.' : 'Grandchildren: one notification, no reminders, no SOS.'}</Text>
        </GroupBody>
      </SettingsGroup>
      <SettingsGroup title="Someone new" footer="Their name and skin go inside the invite; scan it on their phone.">
        <SettingsRow icon="➕" title="Make an invite" detail="For a phone that isn’t in the circle yet" href="/companion-invite" />
      </SettingsGroup>
      {candidates.length ? (
        <SettingsGroup title="Someone already here">
          {candidates.map((m) => (
            <SettingsRow
              key={m.id}
              icon="👤"
              title={busy === m.id ? `Marking ${m.name}…` : m.name}
              detail={m.role === 'admin' ? 'Admin · stops being an admin' : 'Member'}
              onPress={() => (busy ? undefined : mark(m.id, m.name, m.role === 'admin'))}
            />
          ))}
        </SettingsGroup>
      ) : null}
      {client.me?.role !== 'owner' ? <Text style={{ color: t.muted, fontSize: 13, marginTop: 12 }}>Only the circle’s owner can mark an admin as an elder.</Text> : null}
    </SettingsPage>
  );
}
