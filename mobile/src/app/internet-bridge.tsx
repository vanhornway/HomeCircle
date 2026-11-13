// Trackers → Internet bridge: the home base's MQTT connection. With it on,
// a tracker heard by any HomeCircle gateway (a spare Meshtastic node on Wi-Fi
// somewhere, set up under Trackers → Gateways) reaches the home base over the
// internet, so its position shows on the map wherever that is. The broker
// only ever sees encrypted packets. The settings go to the home base sealed,
// as an admin's message in your chat with it ("mqtt …").
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Button, ErrorText, Field, P } from '../components/ui';
import { GroupBody, SettingsGroup, SettingsPage } from '../components/SettingsKit';
import { errorText } from '../lib/circle';
import { brokerProblem, loadBroker, parseBrokerHost, saveBroker } from '../lib/bridgeSettings';
import { confirm, notice } from '../lib/sheet';
import { homeBaseOf, homeBaseOnline, tellHomeBase, useNow } from '../lib/trackers';
import { useCircle } from '../lib/useCircle';
import { useTheme } from '../theme';

export default function InternetBridge() {
  const t = useTheme();
  const client = useCircle(['records', 'members']);
  const now = useNow();
  const home = homeBaseOf(client);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('8883');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    loadBroker().then((b) => {
      if (!b) return;
      setHost(b.host);
      setPort(String(b.port));
      setUser(b.user);
      setPass(b.pass);
    });
  }, []);

  if (!home || !client.isAdmin) {
    return (
      <SettingsPage title="Internet bridge">
        <GroupBody>
          <P muted>{home ? 'Only the circle’s admins set up the internet bridge.' : 'Set up a home base first.'}</P>
        </GroupBody>
      </SettingsPage>
    );
  }

  const mqtt = home.status.self?.mqtt ?? null;
  const online = homeBaseOnline(home.status, now);
  const state = mqtt == null ? 'Off' : mqtt ? 'On and connected' : 'On, not connected right now';

  const turnOn = async () => {
    const parsed = parseBrokerHost(host);
    const b = { host: parsed?.host ?? '', port: parsed?.port ?? Number(port), user: user.trim(), pass };
    const problem = parsed ? brokerProblem(b) : 'That doesn’t look like a broker address (like abc123.s1.eu.hivemq.cloud).';
    setError(problem);
    if (problem) return;
    setSending(true);
    try {
      await tellHomeBase(client, home.id, `mqtt ${b.host}:${b.port} ${b.user} ${b.pass}`);
      await saveBroker(b);
      notice('Sent to the home base', 'It restarts to connect (about 30 s). This screen says “connected” once it is.');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSending(false);
    }
  };

  const turnOff = async () => {
    if (!(await confirm('Turn the internet bridge off?', 'Trackers then show only when the home base hears them by radio.', 'Turn off', { destructive: true }))) return;
    try {
      await tellHomeBase(client, home.id, 'mqtt off');
    } catch (e) {
      notice('Couldn’t send it', errorText(e));
    }
  };

  return (
    <SettingsPage title="Internet bridge">
      <SettingsGroup
        title="Status"
        how={[
          'The home base connects to an MQTT broker on the internet. Your HomeCircle gateways (spare Meshtastic nodes on Wi-Fi somewhere else) connect to the same one.',
          'When a gateway hears one of your trackers, the packet reaches the home base through the broker, and the tracker shows on the map with “via internet”.',
          'Packets stay encrypted with your circle’s private channel key: the broker can’t read where anyone is.',
          'A free hosted broker works (HiveMQ Cloud’s free plan, for example): create a cluster, then a user for HomeCircle with a password of at most 31 characters.',
        ]}
        howTitle="How the internet bridge works"
      >
        <GroupBody>
          <Text style={{ color: mqtt ? t.brand : t.text, fontSize: 18, fontWeight: '700' }}>{state}</Text>
          {!online ? <P muted>The home base is offline right now: changes reach it when it’s back.</P> : null}
        </GroupBody>
      </SettingsGroup>

      <SettingsGroup title="Broker" footer="Sent sealed to the home base, in your chat with it; only you (admins) and the home base can read it. Kept on this phone to set up gateways.">
        <GroupBody gap={0}>
          <Field label="Address" value={host} onChangeText={setHost} placeholder="abc123.s1.eu.hivemq.cloud" autoCapitalize="none" autoCorrect={false} keyboardType="url" />
          <Field label="Port (TLS)" value={port} onChangeText={setPort} keyboardType="number-pad" />
          <Field label="User" value={user} onChangeText={setUser} autoCapitalize="none" autoCorrect={false} />
          <Field label="Password" value={pass} onChangeText={setPass} autoCapitalize="none" autoCorrect={false} secureTextEntry />
          {error ? <ErrorText>{error}</ErrorText> : null}
          <View style={{ gap: 10, marginTop: 6 }}>
            <Button variant="primary" title={mqtt == null ? 'Turn on' : 'Save and reconnect'} loading={sending} onPress={turnOn} />
            {mqtt != null ? <Button variant="danger" title="Turn off" onPress={turnOff} /> : null}
          </View>
        </GroupBody>
      </SettingsGroup>
    </SettingsPage>
  );
}
