import { useState } from 'react';
import { Text } from 'react-native';
import { router } from 'expo-router';
import { GroupBody, SettingsGroup, SettingsPage, SettingsRow } from '../components/SettingsKit';
import { Chips } from '../components/FamilyNames';
import { errorText } from '../lib/circle';
import { useCircle } from '../lib/useCircle';
import { useTheme } from '../theme';
import { showSheet } from '../lib/sheet';

const EVENTS = ['members', 'records'] as const;

/**
 * Mark someone as an elder (design 13): someone already in the circle (their
 * phone switches to the elder screens and they stop being an
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
        .catch((e) => showSheet('Couldn’t mark them', errorText(e)))
        .finally(() => setBusy(null));
    };
    showSheet(
      `Mark ${name} as an elder?`,
      `${name}’s phone switches to the simple elder screens, with no way back to the full app from that phone.${admin ? ` ${name} also stops being an admin.` : ''}`,
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
      <SettingsGroup title="Someone new" footer="Make an invite and scan it on their phone." how="Their name and screens go sealed inside the invite, end-to-end encrypted. Nobody types anything on their phone, and it switches as soon as it joins.">
        <SettingsRow icon="plus" title="Make an invite" detail="For a phone that isn’t in the circle yet" href="/companion-invite" />
      </SettingsGroup>
      {candidates.length ? (
        <SettingsGroup title="Someone already here">
          {candidates.map((m) => (
            <SettingsRow
              key={m.id}
              icon="user"
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
