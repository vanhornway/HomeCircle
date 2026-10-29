import { useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { Member } from '@homecircle/core';
import { Avatar, Button, Tag } from '../../components/ui';
import { GroupBody, SettingsGroup, SettingsPage, SettingsRow } from '../../components/SettingsKit';
import { errorText, useCircles } from '../../lib/circle';
import { setLastUpload, clearDeviceData } from '../../lib/storage';
import { stopBackgroundUpdates, syncGeofences } from '../../lib/location';
import { useCircle } from '../../lib/useCircle';
import { useTheme } from '../../theme';

const RETENTION_LABELS: Record<number, string> = { 1: '1 day', 7: '1 week', 30: '1 month', 90: '3 months', 365: '1 year' };

/** The open circle: its people (and safety numbers), invites, message history, and leaving it. */
export default function CircleSettings() {
  const t = useTheme();
  const client = useCircle();
  const { clients } = useCircles();
  const me = client.me;
  const name = client.circle.name;
  const [open, setOpen] = useState<string | null>(null);

  const confirm = (title: string, body: string, action: string, fn: () => Promise<unknown>) =>
    Alert.alert(title, body, [
      { text: 'Cancel', style: 'cancel' },
      { text: action, style: 'destructive', onPress: () => fn().catch((e) => Alert.alert('Something went wrong', errorText(e))) },
    ]);

  // Leaving the phone's last circle also clears its settings and stops sharing.
  const afterLeaving = async (fn: () => Promise<void>) => {
    const last = clients.length <= 1;
    await fn();
    if (last) {
      await stopBackgroundUpdates();
      await clearDeviceData();
      await setLastUpload(null);
      router.replace('/welcome');
    } else {
      syncGeofences().catch(() => {});
      router.back();
    }
  };

  const row = (m: Member) => {
    const canRemove = client.isAdmin && !m.isMe && m.role !== 'owner' && (m.role !== 'admin' || me?.role === 'owner');
    const canPromote = me?.role === 'owner' && !m.isMe && m.role !== 'owner';
    const shown = open === m.id;
    return (
      <Pressable key={m.id} accessibilityRole="button" accessibilityState={{ expanded: shown }} onPress={() => setOpen(shown ? null : m.id)} style={{ padding: 14 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Avatar name={m.name} color={m.color} size={36} />
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <Text style={{ color: t.text, fontWeight: '600', fontSize: 16 }}>{m.name}</Text>
              {m.isMe ? <Tag label="You" /> : null}
              {m.role !== 'member' ? <Tag label={m.role} /> : null}
              {m.keyChanged ? <Tag label="Keys changed" warn /> : null}
            </View>
            <Text style={{ color: t.muted, fontSize: 13 }}>Tap for safety number</Text>
          </View>
        </View>
        {shown ? (
          <View style={{ marginTop: 10, gap: 10 }}>
            <Text style={{ color: t.text, fontFamily: 'Menlo', fontSize: 15, letterSpacing: 1 }}>{m.safetyNumber}</Text>
            <Text style={{ color: t.muted, fontSize: 13 }}>Compare this with {m.isMe ? 'other people’s phones' : `${m.name}’s phone`} in person. If it matches, no one has been swapped in.</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {canPromote ? <Button small title={m.role === 'admin' ? 'Make member' : 'Make admin'} onPress={() => client.setRole(m.id, m.role === 'admin' ? 'member' : 'admin').catch((e) => Alert.alert('Error', errorText(e)))} /> : null}
              {canRemove ? (
                <Button small variant="danger" title="Remove" onPress={() => confirm(`Remove ${m.name}?`, 'They lose access right away and the circle’s encryption key is changed.', 'Remove', () => client.removeMember(m.id))} />
              ) : null}
            </View>
          </View>
        ) : null}
      </Pressable>
    );
  };

  return (
    <SettingsPage title={name}>
      <SettingsGroup title="People" footer="Everyone here can see each other’s location and tap Locate to ask for it. Joining means agreeing to that.">
        {client.memberList().map(row)}
        {client.isAdmin ? (
          <GroupBody>
            <Button title="Invite someone" variant="primary" onPress={() => router.push('/invite')} />
          </GroupBody>
        ) : null}
      </SettingsGroup>

      {client.isAdmin ? (
        <SettingsGroup title="Elderly Companion" footer="Choose which skin an elder’s HomeCircle app shows: the full app, or the simple Elderly Companion screens. Their phone switches automatically. Location sharing and everything else keeps working underneath.">
          <SettingsRow icon="👵" title="Mark someone as an elder" detail="Their name and skin go in the invite; scan it on their phone" href="/companion-invite" />
        </SettingsGroup>
      ) : null}

      {client.isAdmin && client.feature('circleHealth') ? (
        <SettingsGroup>
          <SettingsRow icon="📋" title="Circle health" detail="How each member’s phone is set up; nudge them to fix problems" href="/circle-health" />
        </SettingsGroup>
      ) : null}

      <SettingsGroup
        title="Delete messages after"
        footer={`${client.isAdmin ? 'Applies to the group chat and direct messages in this circle.' : 'Set by the circle’s admins.'} Older messages are deleted from the server. Nothing is kept longer than a year.`}
      >
        <GroupBody>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {client.retention.choices.map((d) => {
              const on = client.retention.days === d;
              return (
                <Pressable
                  key={d}
                  disabled={!client.isAdmin}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on, disabled: !client.isAdmin }}
                  onPress={() => client.setRetention(d).catch((e) => Alert.alert('Couldn’t change it', errorText(e)))}
                  style={{ minHeight: 44, paddingHorizontal: 16, justifyContent: 'center', borderRadius: 999, borderWidth: 1, borderColor: on ? t.brand : t.line, backgroundColor: on ? t.brandSoft : 'transparent', opacity: client.isAdmin || on ? 1 : 0.5 }}
                >
                  <Text style={{ color: on ? t.brand : t.text, fontWeight: '600', fontSize: 15 }}>{RETENTION_LABELS[d] ?? `${d} days`}</Text>
                </Pressable>
              );
            })}
          </View>
        </GroupBody>
      </SettingsGroup>

      <SettingsGroup title="Leave">
        <GroupBody>
          <Button
            title={clients.length > 1 ? `Sign out of ${name} on this phone` : 'Sign out of this phone'}
            onPress={() =>
              confirm(
                clients.length > 1 ? `Sign out of ${name}?` : 'Sign out of this phone?',
                'This phone’s keys for the circle are deleted. You’ll need a new invite to come back.',
                'Sign out',
                () => afterLeaving(() => client.signOut()),
              )
            }
          />
          {me?.role !== 'owner' ? (
            <Button title={`Leave ${name}`} variant="danger" onPress={() => confirm(`Leave ${name}?`, 'You’ll be removed and your location deleted from the server.', 'Leave', () => afterLeaving(() => client.leave()))} />
          ) : (
            <Button
              title={`Delete ${name}`}
              variant="danger"
              onPress={() =>
                confirm(
                  `Delete ${name}?`,
                  'Everyone is removed and the circle’s messages, places and locations are deleted from the server. This can’t be undone. Your other circles aren’t affected.',
                  'Delete',
                  () => afterLeaving(() => client.deleteCircle()),
                )
              }
            />
          )}
        </GroupBody>
      </SettingsGroup>
    </SettingsPage>
  );
}
