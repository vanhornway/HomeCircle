// Trackers → Add a tracker → Set up over Bluetooth: everything a tracker needs,
// from HomeCircle, without the Meshtastic app. Over Bluetooth the app gives the
// tracker its name, the circle's private channel as its main channel and the
// circle's frequency (from the home base's channel link), 7 hops home, "OK to
// MQTT" (so gateways pass it on), and the home base's key as its admin key (so
// the home base sets how often it reports, over the radio, from then on).
// Then it tells the home base to add it ("add !id Name as kind", "link …").
import { useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { TrackerMode } from '@homecircle/core';
import { Button, ErrorText, Field, P } from '../components/ui';
import { Pills } from '../components/Pills';
import { GroupBody, SettingsGroup, SettingsPage } from '../components/SettingsKit';
import { errorText } from '../lib/circle';
import { all, bytes, patch, u } from '../lib/pb';
import { blePermitted, F, fromB64, MeshNode, nodeId, parseChannelLink, ROLE, scanNodes, type FoundNode } from '../lib/meshNode';
import { homeBaseOf, tellHomeBase, TRACKER_KINDS, trackerList } from '../lib/trackers';
import { useCircle } from '../lib/useCircle';
import { useTheme } from '../theme';

export default function TrackerSetup() {
  const t = useTheme();
  const client = useCircle(['records', 'members']);
  const home = homeBaseOf(client);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<TrackerMode>('carried');
  const [carriedBy, setCarriedBy] = useState('');
  const [found, setFound] = useState<FoundNode[]>([]);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const people = client.peopleList().filter((p) => p.kind !== 'agent' && p.id !== home?.id);

  const link = home?.status.channel ? parseChannelLink(home.status.channel) : null;
  const key = home?.status.key ? fromB64(home.status.key) : null;

  if (!home || !client.isAdmin) {
    return (
      <SettingsPage title="Set up a tracker">
        <GroupBody>
          <P muted>{home ? 'Only the circle’s admins add trackers.' : 'Set up a home base first: trackers are added through it.'}</P>
        </GroupBody>
      </SettingsPage>
    );
  }
  if (!link?.channels.length || !key || key.length !== 32 || !home.status.node) {
    return (
      <SettingsPage title="Set up a tracker">
        <GroupBody>
          <P muted>The home base hasn’t reported its channel and key yet. Give it a minute, then try again.</P>
        </GroupBody>
      </SettingsPage>
    );
  }

  const scan = async () => {
    setError(null);
    if (!(await blePermitted())) return setError('HomeCircle needs Nearby devices (Bluetooth) to find the tracker. Turn it on in the phone’s Settings.');
    setFound([]);
    setScanning(true);
    await scanNodes(8000, (n) => setFound((f) => [...f, n]));
    setScanning(false);
  };

  const setUp = async (n: FoundNode) => {
    const label = name.trim();
    if (!label) return setError('Give the tracker a name, like “Sara’s tracker” or “Honda”.');
    setError(null);
    setDone(null);
    let node: MeshNode | null = null;
    try {
      setBusy(`Connecting to ${n.name}… (Android may ask to pair: a T1000-E’s PIN is 123456 unless changed)`);
      node = await MeshNode.open(n.device);
      setBusy('Reading it…');
      const snap = await node.download();
      const id = nodeId(snap.myNode);
      if (trackerList(client).some((x) => x.tracker.node === id)) throw new Error(`${n.name} is already one of your trackers.`);
      const lora = snap.config.get(F.config.lora) ?? [];
      const security = snap.config.get(F.config.security) ?? [];
      const fromLink = (f: number) => link.lora?.filter((x) => x.n === f) ?? [];
      // The home base's key as an admin key, next to any it has (at most 3).
      const keys = all(security, F.security.adminKey).filter((k) => k.b && k.b.length === 32 && !k.b.every((b, i) => b === key[i]));
      const adminKeys = [bytes(F.security.adminKey, key), ...keys].slice(0, 3);
      setBusy('Setting it up…');
      await node.configure({
        owner: { longName: label.slice(0, 39), shortName: label.replace(/[^A-Za-z0-9]/g, '').slice(0, 4) || 'HC' },
        // The circle's private channel as its main one: everything it sends goes there.
        channels: [{ index: 0, role: ROLE.primary, settings: link.channels[0] }],
        config: [
          [F.config.lora, patch(lora, [...fromLink(1), ...fromLink(2), ...fromLink(F.lora.region), ...fromLink(F.lora.channelNum), u(F.lora.hopLimit, 7), u(F.lora.okToMqtt, true)])],
          [F.config.security, patch(security, adminKeys)],
        ],
      });
      setBusy('Adding it to the circle…');
      const who = kind === 'carried' && carriedBy ? client.members.get(carriedBy)?.name : null;
      await tellHomeBase(client, home.id, `add ${id} ${label}${kind === 'carried' ? '' : ` as ${kind}`}`);
      if (who) await tellHomeBase(client, home.id, `link ${id} to ${who}`);
      setDone(`${label} is set up. It restarts with your private channel; the home base adds it and sets how often it reports within a few minutes.`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
      await node?.close();
    }
  };

  return (
    <SettingsPage title="Set up a tracker">
      <SettingsGroup
        title="The tracker"
        how={[
          'Any Meshtastic tracker works (a SenseCAP T1000-E, a Heltec Wireless Tracker…). Turn it on and keep it next to this phone.',
          'HomeCircle puts it on your circle’s private channel and frequency and gives your home base the key to set it from then on. Its old channels are replaced; nothing else on it changes.',
          'If the Meshtastic app is connected to it, disconnect it there first: a tracker takes one connection at a time.',
        ]}
        howTitle="What setting it up does"
      >
        <GroupBody gap={12}>
          <Field label="Name" value={name} onChangeText={setName} placeholder="Sara’s tracker" maxLength={39} />
          <Pills options={TRACKER_KINDS.map((k) => ({ value: k.mode, label: `${k.emoji} ${k.label}` }))} value={kind} onChange={setKind} />
          {kind === 'carried' ? (
            <Pills options={[{ value: '', label: 'No one yet' }, ...people.map((p) => ({ value: p.id, label: p.name }))]} value={carriedBy} onChange={setCarriedBy} />
          ) : null}
        </GroupBody>
      </SettingsGroup>
      <SettingsGroup title="Find it">
        <GroupBody>
          <Button variant="primary" title={scanning ? 'Looking…' : 'Find trackers nearby'} loading={scanning} onPress={scan} />
          {busy ? <P muted>{busy}</P> : null}
          {done ? <Text style={{ color: t.brand, fontSize: 16, fontWeight: '700' }}>✓ {done}</Text> : null}
          {error ? <ErrorText>{error}</ErrorText> : null}
        </GroupBody>
        <FlatList
          scrollEnabled={false}
          data={found}
          keyExtractor={(n) => n.id}
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              disabled={!!busy}
              onPress={() => setUp(item)}
              style={({ pressed }) => ({ padding: 14, borderTopWidth: 1, borderTopColor: t.line, backgroundColor: pressed ? t.surface2 : undefined })}
            >
              <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>{item.name}</Text>
              <Text style={{ color: t.muted, fontSize: 14 }}>Tap to set it up as {name.trim() || 'a tracker'}</Text>
            </Pressable>
          )}
        />
        {!scanning && !found.length ? (
          <View style={{ padding: 14 }}>
            <P muted>None found yet.</P>
          </View>
        ) : null}
      </SettingsGroup>
      {done ? (
        <GroupBody>
          <Button title="Done" variant="primary" onPress={() => router.back()} />
        </GroupBody>
      ) : null}
    </SettingsPage>
  );
}
