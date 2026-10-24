import { useCallback, useState } from 'react';
import { Alert, Linking, Modal, Pressable, Switch, Text, TextInput, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import type { Member } from '@homecircle/core';
import { Avatar, Button, Card, Checkbox, H1, SectionTitle, Screen, Tag } from '../../components/ui';
import { ServerBanner } from '../../components/ServerBanner';
import { ServerPicker } from '../../components/ServerPicker';
import { RejoinBanner } from '../../components/RejoinBanner';
import { ChirpSettings } from '../../components/ChirpSettings';
import { useServerState } from '../../lib/connection';
import { useCircle } from '../../lib/useCircle';
import { errorText, serverGroups, setActiveCircle, useCircles } from '../../lib/circle';
import { unreadInCircle } from '../../lib/unread';
import { clearDeviceData, getSettings, setLastUpload, updateSettings, type Settings } from '../../lib/storage';
import { shareNow, startBackgroundUpdates, stopBackgroundUpdates, syncGeofences, type SharingMode } from '../../lib/location';
import { notificationPermission, registerPush } from '../../lib/push';
import { useTheme } from '../../theme';

const INTERVALS = [5, 15, 30, 60];
const RETENTION_LABELS: Record<number, string> = { 1: '1 day', 7: '1 week', 30: '1 month', 90: '3 months', 365: '1 year' };

export default function SettingsTab() {
  const t = useTheme();
  const client = useCircle();
  const { clients } = useCircles();
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
  // "Your circles" shows one server at a time: the one picked, else the open
  // circle's. A pick lasts until another circle is opened.
  const [pick, setPick] = useState<{ circle: string; server: string } | null>(null);
  const pickedServer = pick?.circle === client.accountKey ? pick.server : null;
  const servers = serverGroups(clients);
  const shownServer = servers.find((g) => g.url === pickedServer) ?? servers.find((g) => g.url === client.serverUrl) ?? servers[0];

  const [notif, setNotif] = useState<'granted' | 'denied' | 'undetermined' | null>(null);
  useFocusEffect(
    useCallback(() => {
      notificationPermission().then(setNotif).catch(() => {});
      getSettings().then(setSettings);
      startBackgroundUpdates().then(setMode).catch(() => setMode(null));
    }, [setNotif]),
  );

  const apply = async (patch: Partial<Settings>) => {
    const next = await updateSettings(patch);
    setSettings(next);
    if (next.sharing) setMode(await startBackgroundUpdates());
    else {
      await stopBackgroundUpdates();
      setMode('off');
    }
    // Turning sharing off tells each circle you paused; turning it on shares now.
    if (patch.sharing === false) {
      await Promise.allSettled(clients.filter((c) => !next.pausedCircles.includes(c.circleId!)).map((c) => c.pauseSharing()));
    } else if (patch.sharing === true) {
      shareNow('manual').catch(() => {});
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
  // How much each circle sees: your exact position, a ~1 km area, or "paused"
  // (with an optional reason they can read).
  type Precision = 'exact' | 'approximate' | 'paused';
  const precisionOf = (id: string): Precision =>
    settings?.pausedCircles.includes(id) ? 'paused' : settings?.approximateCircles.includes(id) ? 'approximate' : 'exact';
  const [pausing, setPausing] = useState<(typeof clients)[number] | null>(null);
  const [reason, setReason] = useState('');
  const setPrecision = async (target: (typeof clients)[number], mode: Precision, why = '') => {
    const id = target.circleId!;
    const s = settings ?? (await getSettings());
    const paused = new Set(s.pausedCircles);
    const approx = new Set(s.approximateCircles);
    const reasons = { ...s.pauseReasons };
    paused.delete(id);
    approx.delete(id);
    delete reasons[id];
    if (mode === 'paused') {
      paused.add(id);
      if (why.trim()) reasons[id] = why.trim().slice(0, 80);
    }
    if (mode === 'approximate') approx.add(id);
    setSettings(await updateSettings({ pausedCircles: [...paused], approximateCircles: [...approx], pauseReasons: reasons }));
    syncGeofences().catch(() => {});
    if (mode === 'paused') target.pauseSharing(why).catch((e) => Alert.alert('Couldn’t pause sharing', errorText(e)));
    else shareNow('manual').catch(() => {});
  };
  const circleName = client.circle.name;

  const modeText: Record<SharingMode, string> = {
    background: 'Sharing in the background',
    'foreground-only': 'Only while the app is open — allow “Always” for background updates',
    'no-permission': 'Location permission is off',
    off: 'Paused — your circles see that you paused',
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
      <RejoinBanner style={{ marginTop: 14 }} />

      <SectionTitle>Your circles</SectionTitle>
      <Card style={{ gap: 4 }}>
        {shownServer ? <ServerPicker groups={servers} value={shownServer.url} onChange={(server) => setPick({ circle: client.accountKey, server })} /> : null}
        {(shownServer?.circles ?? clients).map((c) => {
          const isActive = c === client;
          const precision = precisionOf(c.circleId!);
          const why = settings?.pauseReasons[c.circleId!];
          const n = unreadInCircle(c);
          return (
            <View key={c.accountKey} style={{ gap: 8, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: t.line }}>
              <Pressable accessibilityRole="button" onPress={() => setActiveCircle(c.accountKey)}>
                <Text style={{ color: isActive ? t.brand : t.text, fontSize: 16, fontWeight: '600' }} numberOfLines={1}>
                  {isActive ? '✓ ' : ''}
                  {c.circle.name}
                  {n ? `  (${n} new)` : ''}
                </Text>
                <Text style={{ color: t.muted, fontSize: 13 }} numberOfLines={2}>
                  {precision === 'exact'
                    ? 'Sees your exact location'
                    : precision === 'approximate'
                      ? 'Sees only your approximate area (about 1 km)'
                      : `Paused${why ? `: “${why}”` : ''}. They see that you paused`}
                  {isActive || clients.length < 2 ? '' : ' · tap to open'}
                </Text>
              </Pressable>
              <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', borderRadius: 12, borderWidth: 1, borderColor: t.line, overflow: 'hidden' }}>
                {(['exact', 'approximate', 'paused'] as const).map((mode) => {
                  const on = precision === mode;
                  return (
                    <Pressable
                      key={mode}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: on }}
                      accessibilityLabel={`${mode} location for ${c.circle.name}`}
                      onPress={() => {
                        if (on) return;
                        if (mode === 'paused') {
                          setReason('');
                          setPausing(c);
                        } else setPrecision(c, mode);
                      }}
                      style={{ flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? t.brandSoft : 'transparent' }}
                    >
                      <Text style={{ color: on ? t.brand : t.text, fontWeight: on ? '700' : '500', fontSize: 15 }}>
                        {mode === 'exact' ? 'Exact' : mode === 'approximate' ? 'Approximate' : 'Paused'}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          );
        })}
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
          {shownServer?.circles.some((c) => c.isServerAdmin) ? (
            <Button small title="New circle" onPress={() => router.push({ pathname: '/new-circle', params: { server: shownServer.url } })} style={{ flex: 1 }} />
          ) : null}
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

      <SectionTitle>Place alerts</SectionTitle>
      <Card style={{ gap: 6 }}>
        <Checkbox
          checked={settings?.announcePlaces ?? true}
          onChange={(v) => updateSettings({ announcePlaces: v }).then(setSettings)}
          label="Announce my arrivals and departures"
          detail={
            settings?.announcePlaces ?? true
              ? 'When you arrive at or leave a place, your circles’ group chats get a message like “Umair arrived at Home”.'
              : 'Your phone won’t post when you arrive or leave. Your location still shows on the map.'
          }
        />
        <Checkbox
          checked={settings?.showPlaceAlerts ?? true}
          onChange={(v) => updateSettings({ showPlaceAlerts: v }).then(setSettings)}
          label="Show place alerts in my chats"
          detail={
            settings?.showPlaceAlerts ?? true
              ? 'You see and get notified when others arrive at or leave places.'
              : 'Arrived/left messages are hidden on this phone and don’t notify you. Others still see them.'
          }
        />
      </Card>

      <ChirpSettings clients={clients} settings={settings} onChange={setSettings} />

      <SectionTitle>This phone</SectionTitle>
      <Card style={{ gap: 10 }}>
        <Button title="Setup check" onPress={() => router.push('/setup-check')} />
        <Text style={{ color: t.muted, fontSize: 13 }}>Make sure location, battery and notifications are set so your circle always sees where you are.</Text>
        <Button title="Diagnostics" onPress={() => router.push('/diagnostics')} />
        <Text style={{ color: t.muted, fontSize: 13 }}>A 7-day log of what HomeCircle did in the background. Send it to an admin if updates seem late.</Text>
        {client.isAdmin ? (
          <>
            <Button title={`Circle health: ${circleName}`} onPress={() => router.push('/circle-health')} />
            <Text style={{ color: t.muted, fontSize: 13 }}>Admins: see how each member’s phone is set up, and nudge them to fix problems.</Text>
          </>
        ) : null}
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
        <Text style={{ color: t.muted, fontSize: 13, marginTop: 12 }}>
          Everyone here can see each other’s location and tap Locate to ask for it. Joining means agreeing to that.
        </Text>
      </Card>

      <SectionTitle>Message history</SectionTitle>
      <Card style={{ gap: 10 }}>
        <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>Delete messages after</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {client.retention.choices.map((d) => {
            const on = client.retention.days === d;
            return (
              <Pressable
                key={d}
                disabled={!client.isAdmin}
                accessibilityRole="button"
                accessibilityState={{ selected: on, disabled: !client.isAdmin }}
                onPress={() => client.setRetention(d).catch((e) => Alert.alert('Couldn’t change it', errorText(e)))}
                style={{
                  minHeight: 44,
                  paddingHorizontal: 16,
                  justifyContent: 'center',
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: on ? t.brand : t.line,
                  backgroundColor: on ? t.brandSoft : 'transparent',
                  opacity: client.isAdmin || on ? 1 : 0.5,
                }}
              >
                <Text style={{ color: on ? t.brand : t.text, fontWeight: '600', fontSize: 15 }}>{RETENTION_LABELS[d] ?? `${d} days`}</Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={{ color: t.muted, fontSize: 13 }}>
          {client.isAdmin
            ? 'Applies to the group chat and direct messages in this circle. Older messages are deleted from the server.'
            : 'Set by the circle’s admins. Older messages, including direct messages, are deleted from the server.'}{' '}
          Nothing is kept longer than a year.
        </Text>
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
      <Modal visible={!!pausing} transparent animationType="fade" onRequestClose={() => setPausing(null)}>
        <Pressable onPress={() => setPausing(null)} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', padding: 24 }}>
          <Pressable onPress={() => {}} style={{ backgroundColor: t.surface, borderRadius: 20, padding: 18, gap: 12 }}>
            <Text style={{ color: t.text, fontSize: 18, fontWeight: '700' }}>Pause sharing with {pausing?.circle.name}?</Text>
            <Text style={{ color: t.muted, fontSize: 14, lineHeight: 20 }}>
              They’ll see “Paused” instead of where you are, and Locate won’t reach you. Add a reason if you like.
            </Text>
            <TextInput
              value={reason}
              onChangeText={setReason}
              placeholder="e.g. At the doctor (optional)"
              placeholderTextColor={t.muted}
              maxLength={80}
              style={{ minHeight: 52, borderRadius: 12, borderWidth: 1, borderColor: t.line, paddingHorizontal: 14, fontSize: 17, color: t.text, backgroundColor: t.bg }}
            />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Button title="Cancel" onPress={() => setPausing(null)} style={{ flex: 1 }} />
              <Button
                title="Pause"
                variant="primary"
                onPress={() => {
                  if (pausing) setPrecision(pausing, 'paused', reason);
                  setPausing(null);
                }}
                style={{ flex: 1 }}
              />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </Screen>
  );
}
