import { useCallback, useState } from 'react';
import { Alert, Linking, Pressable, Switch, Text, TextInput, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import type { Member } from '@homecircle/core';
import { Avatar, Button, Card, H1, SectionTitle, Screen, Tag } from '../../components/ui';
import { ServerBanner } from '../../components/ServerBanner';
import { useServerState } from '../../lib/connection';
import { useCircle } from '../../lib/useCircle';
import { errorText, setActiveCircle, useCircles } from '../../lib/circle';
import { useUnread } from '../../lib/notify';
import { clearDeviceData, getSettings, setLastUpload, updateSettings, type Settings } from '../../lib/storage';
import { shareNow, startBackgroundUpdates, stopBackgroundUpdates, syncGeofences, type SharingMode } from '../../lib/location';
import { notificationPermission, registerPush } from '../../lib/push';
import { useTheme } from '../../theme';

const INTERVALS = [5, 15, 30, 60];

export default function SettingsTab() {
  const t = useTheme();
  const client = useCircle();
  const { clients } = useCircles();
  const unread = useUnread();
  const me = client.me;
  const server = useServerState();
  // Your name is per circle: an unsaved edit only applies to the circle it was typed in.
  const [edit, setEdit] = useState<{ circle: string; value: string } | null>(null);
  const draft = edit?.circle === client.accountKey ? edit.value : null;
  const setDraft = (value: string | null) => setEdit(value == null ? null : { circle: client.accountKey, value });
  const name = draft ?? me?.name ?? '';
  const [settings, setSettings] = useState<Settings | null>(null);
  const [mode, setMode] = useState<SharingMode | null>(null);
  const [openMember, setOpenMember] = useState<string | null>(null);

  const [notif, setNotif] = useState<'granted' | 'denied' | 'undetermined' | null>(null);
  useFocusEffect(
    useCallback(() => {
      notificationPermission().then(setNotif).catch(() => {});
      getSettings().then(setSettings);
      startBackgroundUpdates().then(setMode).catch(() => setMode(null));
    }, []),
  );

  const apply = async (patch: Partial<Settings>) => {
    const next = await updateSettings(patch);
    setSettings(next);
    if (next.sharing) setMode(await startBackgroundUpdates());
    else {
      await stopBackgroundUpdates();
      setMode('off');
    }
  };

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
    }
  };

  // Turning a circle off also removes your last location from it.
  const toggleCircleSharing = async (target: (typeof clients)[number], on: boolean) => {
    const id = target.circleId!;
    const paused = new Set(settings?.pausedCircles ?? []);
    if (on) paused.delete(id);
    else paused.add(id);
    setSettings(await updateSettings({ pausedCircles: [...paused] }));
    syncGeofences().catch(() => {});
    if (on) shareNow('open').catch(() => {});
    else target.clearLocation().catch((e) => Alert.alert('Couldn’t remove your location', errorText(e)));
  };
  const circleName = client.circle.name;

  const modeText: Record<SharingMode, string> = {
    background: 'Sharing in the background',
    'foreground-only': 'Only while the app is open — allow “Always” for background updates',
    'no-permission': 'Location permission is off',
    off: 'Paused — your circle sees your last shared location',
  };

  const memberRow = (m: Member) => {
    const canRemove = client.isAdmin && !m.isMe && m.role !== 'owner' && (m.role !== 'admin' || me?.role === 'owner');
    const canPromote = me?.role === 'owner' && !m.isMe && m.role !== 'owner';
    const open = openMember === m.id;
    return (
      <Pressable key={m.id} onPress={() => setOpenMember(open ? null : m.id)} style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: t.line }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Avatar name={m.name} color={m.color} size={36} />
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
              <Text style={{ color: t.text, fontWeight: '600', fontSize: 16 }}>{m.name}</Text>
              {m.isMe ? <Tag label="You" /> : null}
              {m.role !== 'member' ? <Tag label={m.role} /> : null}
              {m.keyChanged ? <Tag label="Keys changed" warn /> : null}
            </View>
            <Text style={{ color: t.muted, fontSize: 13 }}>Tap for safety number</Text>
          </View>
        </View>
        {open ? (
          <View style={{ marginTop: 10, gap: 10 }}>
            <Text style={{ color: t.text, fontFamily: 'Menlo', fontSize: 15, letterSpacing: 1 }}>{m.safetyNumber}</Text>
            <Text style={{ color: t.muted, fontSize: 13 }}>Compare this with {m.isMe ? 'other people’s phones' : `${m.name}’s phone`} in person. If it matches, no one has been swapped in.</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {canPromote ? (
                <Button small title={m.role === 'admin' ? 'Make member' : 'Make admin'} onPress={() => client.setRole(m.id, m.role === 'admin' ? 'member' : 'admin').catch((e) => Alert.alert('Error', errorText(e)))} />
              ) : null}
              {canRemove ? (
                <Button
                  small
                  variant="danger"
                  title="Remove"
                  onPress={() =>
                    confirm(`Remove ${m.name}?`, 'They lose access right away and the circle’s encryption key is changed.', 'Remove', () => client.removeMember(m.id))
                  }
                />
              ) : null}
            </View>
          </View>
        ) : null}
      </Pressable>
    );
  };

  return (
    <Screen>
      <H1 style={{ marginTop: 4 }}>Settings</H1>
      <ServerBanner style={{ marginTop: 14 }} />

      <SectionTitle>Your circles</SectionTitle>
      <Card style={{ gap: 4 }}>
        {clients.map((c) => {
          const isActive = c === client;
          const sharingHere = !(settings?.pausedCircles ?? []).includes(c.circleId!);
          const n = unread[c.circleId!] || 0;
          return (
            <View key={c.accountKey} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: t.line }}>
              <Pressable accessibilityRole="button" onPress={() => setActiveCircle(c.accountKey)} style={{ flex: 1 }}>
                <Text style={{ color: isActive ? t.brand : t.text, fontSize: 16, fontWeight: '600' }} numberOfLines={1}>
                  {isActive ? '✓ ' : ''}
                  {c.circle.name}
                  {n ? `  (${n} new)` : ''}
                </Text>
                <Text style={{ color: t.muted, fontSize: 13 }} numberOfLines={1}>
                  {clients.length > 1 ? (sharingHere ? 'Sees your location' : 'Doesn’t see your location') : `${c.memberList().length} members`}
                  {isActive ? '' : ' · tap to open'}
                </Text>
              </Pressable>
              {clients.length > 1 ? (
                <Switch
                  accessibilityLabel={`Share my location with ${c.circle.name}`}
                  value={sharingHere}
                  onValueChange={(v) => toggleCircleSharing(c, v)}
                  trackColor={{ true: t.brand }}
                />
              ) : null}
            </View>
          );
        })}
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
          {clients.some((c) => c.isServerAdmin) ? <Button small title="New circle" onPress={() => router.push('/new-circle')} style={{ flex: 1 }} /> : null}
          <Button small title="Join a circle" onPress={() => router.push('/join')} style={{ flex: 1 }} />
        </View>
        <Text style={{ color: t.muted, fontSize: 13, marginTop: 8 }}>
          Each circle is separate: its own people, map, chat and encryption key. Nobody sees anything from a circle they’re not in.
        </Text>
      </Card>

      <SectionTitle>{clients.length > 1 ? `You in ${circleName}` : 'You'}</SectionTitle>
      <Card>
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
          <TextInput
            value={name}
            onChangeText={setDraft}
            maxLength={40}
            placeholder="Your name"
            placeholderTextColor={t.muted}
            style={{ flex: 1, color: t.text, fontSize: 16, minHeight: 44, borderBottomWidth: 1, borderBottomColor: t.line }}
          />
          <Button small title="Save" disabled={!name.trim() || name === me?.name} onPress={() => client.setName(name).then(() => setDraft(null)).catch((e) => Alert.alert('Error', errorText(e)))} />
        </View>
      </Card>

      <SectionTitle>Location sharing</SectionTitle>
      <Card style={{ gap: 14 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>Share my location</Text>
            <Text style={{ color: t.muted, fontSize: 13, marginTop: 2 }}>{mode ? modeText[mode] : ' '}</Text>
          </View>
          <Switch value={!!settings?.sharing} onValueChange={(v) => apply({ sharing: v })} trackColor={{ true: t.brand }} />
        </View>
        {mode === 'foreground-only' || mode === 'no-permission' ? <Button small title="Fix permissions" onPress={() => router.push('/permissions')} /> : null}
        <View>
          <Text style={{ color: t.text, fontSize: 16, fontWeight: '600', marginBottom: 8 }}>Update about every</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {INTERVALS.map((n) => {
              const on = settings?.intervalMinutes === n;
              return (
                <Pressable
                  key={n}
                  onPress={() => apply({ intervalMinutes: n })}
                  style={{ flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 10, borderWidth: 1, borderColor: on ? t.brand : t.line, backgroundColor: on ? t.brandSoft : 'transparent' }}
                >
                  <Text style={{ color: on ? t.brand : t.text, fontWeight: '600' }}>{n} min</Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={{ color: t.muted, fontSize: 13, marginTop: 8 }}>
            Also updates when you move a lot, arrive at a place, or someone taps “Locate”. Longer intervals save battery.
          </Text>
        </View>
        <Button small title="Share my location now" onPress={() => shareNow('manual').then((ok) => !ok && Alert.alert('Couldn’t get your location', 'Check that location is allowed.'))} />
      </Card>

      <SectionTitle>Notifications</SectionTitle>
      <Card style={{ gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>Show message text</Text>
            <Text style={{ color: t.muted, fontSize: 13, marginTop: 2 }}>
              {settings?.showPreviews ? 'Notifications show who wrote and what they said' : 'Notifications just say “New message”'}
            </Text>
          </View>
          <Switch
            value={settings?.showPreviews ?? true}
            onValueChange={(v) => updateSettings({ showPreviews: v }).then(setSettings)}
            trackColor={{ true: t.brand }}
          />
        </View>
        {notif && notif !== 'granted' ? (
          <Button
            small
            title={notif === 'denied' ? 'Turn on notifications in system settings' : 'Allow notifications'}
            onPress={() =>
              notif === 'denied'
                ? Linking.openSettings()
                : registerPush({ ask: true }).finally(() => notificationPermission().then(setNotif))
            }
          />
        ) : null}
        <Text style={{ color: t.muted, fontSize: 13 }}>
          Messages are decrypted on this phone before they’re shown. The push service only learns that something arrived.
        </Text>
      </Card>

      <SectionTitle>{circleName}</SectionTitle>
      <Card>
        {client.memberList().map(memberRow)}
        {client.isAdmin ? <Button title="Invite someone" variant="primary" style={{ marginTop: 14 }} onPress={() => router.push('/invite')} /> : null}
      </Card>

      <SectionTitle>Server</SectionTitle>
      <Card>
        <Text style={{ color: t.text, fontSize: 15 }}>{client.serverUrl?.replace(/^https?:\/\//, '')}</Text>
        <Text style={{ color: server.reachable ? t.muted : t.danger, fontSize: 13, marginTop: 4 }}>
          {server.reachable ? `Key version ${client.account?.epoch} · ${client.status} · end-to-end encrypted` : 'Not reachable right now'}
        </Text>
        <Button small title="Change server address" style={{ marginTop: 12 }} onPress={() => router.push('/server')} />
      </Card>

      <SectionTitle>Leave</SectionTitle>
      <View style={{ gap: 10 }}>
        <Button
          title={clients.length > 1 ? `Sign out of ${circleName} on this phone` : 'Sign out of this phone'}
          onPress={() =>
            confirm(
              clients.length > 1 ? `Sign out of ${circleName}?` : 'Sign out of this phone?',
              'This phone’s keys for the circle are deleted. You’ll need a new invite to come back.',
              'Sign out',
              () => afterLeaving(() => client.signOut()),
            )
          }
        />
        {me?.role !== 'owner' ? (
          <Button
            title={`Leave ${circleName}`}
            variant="danger"
            onPress={() =>
              confirm(`Leave ${circleName}?`, 'You’ll be removed and your location deleted from the server.', 'Leave', () => afterLeaving(() => client.leave()))
            }
          />
        ) : (
          <Button
            title={`Delete ${circleName}`}
            variant="danger"
            onPress={() =>
              confirm(
                `Delete ${circleName}?`,
                'Everyone is removed and the circle’s messages, places and locations are deleted from the server. This can’t be undone. Your other circles aren’t affected.',
                'Delete',
                () => afterLeaving(() => client.deleteCircle()),
              )
            }
          />
        )}
      </View>
    </Screen>
  );
}
