// Trackers → Set up a gateway: turn a spare Meshtastic node into a HomeCircle
// gateway somewhere else (a relative's house, the car). Over Bluetooth, the
// app gives it the circle's private channel and radio frequency (from the
// home base's channel link), the Wi-Fi of where it will live, and the same
// internet bridge (MQTT) as the home base. Then any tracker it hears reaches
// the home base, and the map, over the internet. The node keeps its own
// primary channel (the public mesh) and keeps relaying for everyone.
import { useEffect, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Button, ErrorText, Field, P } from '../components/ui';
import { GroupBody, SettingsGroup, SettingsPage } from '../components/SettingsKit';
import { brokerProblem, loadBroker, type BrokerSettings } from '../lib/bridgeSettings';
import { errorText } from '../lib/circle';
import { blePermitted, channelNamed, F, freeChannel, MeshNode, parseChannelLink, ROLE, scanNodes, type FoundNode } from '../lib/meshNode';
import { patch, str, u } from '../lib/pb';
import { notice } from '../lib/sheet';
import { homeBaseOf } from '../lib/trackers';
import { useCircle } from '../lib/useCircle';
import { useTheme } from '../theme';

const CHANNEL = 'HomeCircle';

export default function GatewaySetup() {
  const t = useTheme();
  const client = useCircle(['records', 'members']);
  const home = homeBaseOf(client);
  const [broker, setBroker] = useState<BrokerSettings | null | undefined>(undefined);
  const [name, setName] = useState('');
  const [ssid, setSsid] = useState('');
  const [wifiPass, setWifiPass] = useState('');
  const [found, setFound] = useState<FoundNode[]>([]);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    loadBroker().then(setBroker);
  }, []);

  const link = home?.status.channel ? parseChannelLink(home.status.channel) : null;
  const ours = link?.channels.find((c) => (new TextDecoder().decode(c.find((f) => f.n === F.channelSettings.name)?.b ?? new Uint8Array()) || '') === CHANNEL) ?? link?.channels[0] ?? null;

  if (!home || !client.isAdmin) {
    return (
      <SettingsPage title="Set up a gateway">
        <GroupBody>
          <P muted>{home ? 'Only the circle’s admins set up gateways.' : 'Set up a home base first.'}</P>
        </GroupBody>
      </SettingsPage>
    );
  }
  if (broker === undefined) return <SettingsPage title="Set up a gateway">{null}</SettingsPage>;
  if (!broker || brokerProblem(broker) || home.status.self?.mqtt == null) {
    return (
      <SettingsPage title="Set up a gateway">
        <GroupBody>
          <P muted>A gateway passes trackers on through the internet bridge. Turn the bridge on for the home base first (on this phone, so it can give the gateway the same settings).</P>
          <Button variant="primary" title="Internet bridge" onPress={() => router.replace('/internet-bridge')} />
        </GroupBody>
      </SettingsPage>
    );
  }
  if (!ours) {
    return (
      <SettingsPage title="Set up a gateway">
        <GroupBody>
          <P muted>The home base hasn’t reported its private channel yet. Give it a minute, then try again.</P>
        </GroupBody>
      </SettingsPage>
    );
  }

  const scan = async () => {
    setError(null);
    if (!(await blePermitted())) return setError('HomeCircle needs Nearby devices (Bluetooth) to find the node. Turn it on in the phone’s Settings.');
    setFound([]);
    setScanning(true);
    await scanNodes(8000, (n) => setFound((f) => [...f, n]));
    setScanning(false);
  };

  const setUp = async (n: FoundNode) => {
    const problem = !name.trim() ? 'Give the gateway a name, like “Uncle’s house”.' : !ssid.trim() ? 'Enter the Wi-Fi it will use where it lives.' : null;
    if (problem) return setError(problem);
    setError(null);
    setDone(null);
    let node: MeshNode | null = null;
    try {
      setBusy(`Connecting to ${n.name}… (Android may ask to pair: a T1000-E’s PIN is 123456 unless changed)`);
      node = await MeshNode.open(n.device);
      setBusy('Reading its settings…');
      const snap = await node.download();
      const existing = channelNamed(snap, CHANNEL);
      const index = existing?.index ?? freeChannel(snap);
      if (index < 1) throw new Error('It has no free channel slot: remove a channel in the Meshtastic app first.');
      const lora = snap.config.get(F.config.lora) ?? [];
      const network = snap.config.get(F.config.network) ?? [];
      const mqtt = snap.module.get(F.module.mqtt) ?? [];
      const fromLink = (n: number) => link!.lora?.filter((f) => f.n === n) ?? [];
      setBusy('Setting it up…');
      await node.configure({
        owner: { longName: `HC ${name.trim()}`.slice(0, 39), shortName: 'HCgw' },
        channels: [{ index, role: ROLE.secondary, settings: patch(ours, [u(F.channelSettings.uplink, true), u(F.channelSettings.downlink, true)]) }],
        // The circle's frequency and preset (from the home base's link), and OK to pass on over MQTT.
        config: [
          [F.config.lora, patch(lora, [...fromLink(1), ...fromLink(2), ...fromLink(F.lora.region), ...fromLink(F.lora.channelNum), u(F.lora.okToMqtt, true)])],
          [F.config.network, patch(network, [u(F.network.wifiEnabled, true), str(F.network.ssid, ssid.trim()), str(F.network.psk, wifiPass)])],
        ],
        module: [
          [
            F.module.mqtt,
            patch(mqtt, [
              u(F.mqtt.enabled, true),
              str(F.mqtt.address, `${broker.host}:${broker.port}`),
              str(F.mqtt.username, broker.user),
              str(F.mqtt.password, broker.pass),
              u(F.mqtt.encryption, true),
              u(F.mqtt.tls, broker.port !== 1883),
              str(F.mqtt.root, 'msh/homecircle'),
              u(F.mqtt.proxy, false),
              u(F.mqtt.mapReport, false),
            ]),
          ],
        ],
      });
      setDone(`${n.name} is now the gateway “${name.trim()}”. It restarts and joins “${ssid.trim()}”; once it’s there, trackers it hears show on the map “via internet”.`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
      await node?.close();
    }
  };

  return (
    <SettingsPage title="Set up a gateway">
      <SettingsGroup
        title="Where it will live"
        how={[
          'A gateway is a spare Meshtastic node (any with Wi-Fi, like a Heltec V3 or V4) plugged in somewhere else: a relative’s house, a cabin, the car with a hotspot.',
          'It listens for your trackers on your private channel and passes what it hears to your home base over the internet. Packets stay encrypted the whole way.',
          'It keeps its own channels and keeps relaying for the public mesh.',
        ]}
        howTitle="What a gateway does"
      >
        <GroupBody gap={0}>
          <Field label="Gateway name" value={name} onChangeText={setName} placeholder="Uncle’s house" />
          <Field label="Wi-Fi name there" value={ssid} onChangeText={setSsid} autoCapitalize="none" autoCorrect={false} />
          <Field label="Wi-Fi password there" value={wifiPass} onChangeText={setWifiPass} autoCapitalize="none" autoCorrect={false} secureTextEntry />
        </GroupBody>
      </SettingsGroup>
      <SettingsGroup title="The node" footer="Turn it on and keep it next to this phone. If the Meshtastic app is connected to it, disconnect it there first.">
        <GroupBody>
          <Button variant="primary" title={scanning ? 'Looking…' : 'Find nodes nearby'} loading={scanning} onPress={scan} />
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
              <Text style={{ color: t.muted, fontSize: 14 }}>Tap to make it a gateway</Text>
            </Pressable>
          )}
        />
        {!scanning && !found.length ? (
          <View style={{ padding: 14 }}>
            <P muted>No nodes found yet.</P>
          </View>
        ) : null}
      </SettingsGroup>
      {done ? (
        <GroupBody>
          <Button title="Done" onPress={() => (notice('Gateway set up', done), router.back())} />
        </GroupBody>
      ) : null}
    </SettingsPage>
  );
}
