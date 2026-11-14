// Trackers → This phone → Pair your tracker: pick the tracker you carry from
// the ones nearby (your circle's first, by name), and HomeCircle connects to
// it once (Android asks for its PIN the first time) and remembers it on this
// phone. Then the phone bridge and messages over the mesh go straight to it,
// and Trackers shows which tracker this phone is paired with. For an admin it
// also becomes theirs in the circle ("carried by"), so the map shows them at
// it when their phone goes quiet.
import { useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Button, ErrorText, P } from '../components/ui';
import { GroupBody, SettingsGroup, SettingsPage } from '../components/SettingsKit';
import { errorText } from '../lib/circle';
import { blePermitted, MeshNode, nameMatches, nodeId, scanNodes, type FoundNode } from '../lib/meshNode';
import { pairNow, setPaired, usePaired } from '../lib/pairedTracker';
import { confirm } from '../lib/sheet';
import { homeBaseOf, tellHomeBase, trackerList } from '../lib/trackers';
import { useCircle } from '../lib/useCircle';
import { useTheme } from '../theme';

export default function PairTracker() {
  const t = useTheme();
  const client = useCircle(['records', 'members']);
  const paired = usePaired();
  const home = homeBaseOf(client);
  const trackers = trackerList(client);
  const me = client.account?.memberId ?? '';
  const [found, setFound] = useState<FoundNode[]>([]);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // The circle's tracker a Bluetooth name belongs to ("UT2_f8c9").
  const ours = (n: FoundNode) => trackers.find((x) => x.tracker.node && nameMatches(n.name, x.tracker.node));
  const sorted = [...found].sort((a, b) => Number(!!ours(b)) - Number(!!ours(a)) || a.name.localeCompare(b.name));

  const scan = async () => {
    setError(null);
    if (!(await blePermitted())) return setError('HomeCircle needs Nearby devices (Bluetooth) to find your tracker. Turn it on in the phone’s Settings.');
    setFound([]);
    setScanning(true);
    await scanNodes(8000, (n) => setFound((f) => [...f, n]));
    setScanning(false);
  };

  const pair = async (n: FoundNode) => {
    setError(null);
    setDone(null);
    let node: MeshNode | null = null;
    try {
      setBusy(`Connecting to ${n.name}… If Android asks to pair, enter the tracker’s PIN (123456 on a T1000-E unless it was changed).`);
      node = await MeshNode.open(n.device);
      setBusy('Reading it…');
      const snap = await node.download();
      const id = nodeId(snap.myNode);
      const me2 = snap.nodes.get(snap.myNode);
      const circle = trackers.find((x) => x.tracker.node === id);
      const name = circle?.name ?? me2?.longName ?? n.name;
      await pairNow({ node: id, name, deviceId: n.device.id, battery: me2?.battery != null && me2.battery <= 100 ? me2.battery : null });
      if (!circle) {
        setDone(`Paired with ${name}. It isn’t one of your circle’s trackers yet: set it up under Trackers → Add a tracker.`);
        return;
      }
      // Make it theirs in the circle too (admins), so the map shows them at it when their phone goes quiet.
      const carrier = circle.tracker.carriedBy;
      if (carrier !== me && client.isAdmin && home && circle.tracker.mode === 'carried') {
        const other = carrier ? client.members.get(carrier)?.name : null;
        const yes = await confirm(
          `Make ${name} yours?`,
          other ? `The circle has it as ${other}’s. Change it to you?` : `So the map shows you at ${name} when your phone goes quiet.`,
          'Make it mine',
        );
        if (yes) await tellHomeBase(client, home.id, `link ${id} to ${client.me?.name ?? 'me'}`);
      }
      setDone(
        carrier === me || client.isAdmin
          ? `Paired with ${name}.`
          : `Paired with ${name} on this phone. The circle has it as ${carrier ? (client.members.get(carrier)?.name ?? 'someone else') : 'no one'}’s: ask an admin to make it yours (Trackers → ${name} → Who has it).`,
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
      await node?.close();
    }
  };

  return (
    <SettingsPage title="Pair your tracker">
      <SettingsGroup
        title="Paired with this phone"
        how={[
          'Pairing connects this phone to the tracker you carry, once. Android asks for the tracker’s PIN the first time (123456 on a SenseCAP T1000-E unless it was changed).',
          'Then this phone can pass on the tracker’s position when you’re away (Pass on its position), send messages through it when there’s no internet, and tell whether you and the tracker are together.',
          'A tracker takes one Bluetooth connection at a time: close the Meshtastic app if it’s connected to it.',
        ]}
        howTitle="About pairing"
      >
        <GroupBody>
          {paired ? (
            <>
              <Text style={{ color: t.text, fontSize: 18, fontWeight: '700' }}>📡 {paired.name}</Text>
              <P muted>{paired.node}</P>
            </>
          ) : (
            <P muted>No tracker paired with this phone yet.</P>
          )}
          {paired ? (
            <Button
              small
              variant="ghost"
              title="Forget it on this phone"
              onPress={async () => {
                if (await confirm(`Forget ${paired.name}?`, 'This phone stops passing on its position and sending through it. The tracker stays in the circle.', 'Forget', { destructive: true })) await setPaired(null);
              }}
            />
          ) : null}
        </GroupBody>
      </SettingsGroup>
      <SettingsGroup title={paired ? 'Pair another' : 'Find your tracker'} footer="Turn it on and keep it next to this phone.">
        <GroupBody>
          <Button variant="primary" title={scanning ? 'Looking…' : 'Find trackers nearby'} loading={scanning} onPress={scan} />
          {busy ? <P muted>{busy}</P> : null}
          {done ? <Text style={{ color: t.brand, fontSize: 16, fontWeight: '700' }}>✓ {done}</Text> : null}
          {error ? <ErrorText>{error}</ErrorText> : null}
        </GroupBody>
        <FlatList
          scrollEnabled={false}
          data={sorted}
          keyExtractor={(n) => n.id}
          renderItem={({ item }) => {
            const c = ours(item);
            const carrier = c?.tracker.carriedBy ? client.members.get(c.tracker.carriedBy)?.name : null;
            return (
              <Pressable
                accessibilityRole="button"
                disabled={!!busy}
                onPress={() => pair(item)}
                style={({ pressed }) => ({ padding: 14, borderTopWidth: 1, borderTopColor: t.line, backgroundColor: pressed ? t.surface2 : undefined })}
              >
                <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>{c ? `📡 ${c.name}` : item.name}</Text>
                <Text style={{ color: t.muted, fontSize: 14 }}>
                  {c ? `Your circle’s${carrier ? ` · ${carrier}’s` : ''} · ${item.name}` : 'Not in your circle yet'}
                  {paired && c?.tracker.node === paired.node ? ' · paired now' : ''}
                </Text>
              </Pressable>
            );
          }}
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
