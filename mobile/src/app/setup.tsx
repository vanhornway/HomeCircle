import { useState } from 'react';
import { router } from 'expo-router';
import { CircleClient } from '@homecircle/core';
import { Button, ErrorText, Field, H1, LockNote, P, Screen } from '../components/ui';
import { addCircle, allClients, draftClient, errorText } from '../lib/circle';
import { updateSettings } from '../lib/storage';

export default function Setup() {
  const [server, setServer] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [circleName, setCircleName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const info = await CircleClient.serverInfo(server);
      if (info.setup) {
        throw new Error('This server is already set up. Ask the person who set it up to create a circle for you, or to invite you.');
      }
      const first = allClients().length === 0;
      const client = draftClient();
      await client.createCircle({ serverUrl: info.server, setupToken: code, name, circleName });
      await addCircle(client);
      if (first) {
        await updateSettings({ tileUrl: info.tileUrl, tileAttribution: info.tileAttribution });
        router.replace('/permissions');
      } else {
        router.replace('/(tabs)');
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <H1 style={{ marginTop: 12 }}>Set up your server</H1>
      <P muted style={{ marginTop: 8, marginBottom: 24 }}>
        Enter the address of the HomeCircle server you just deployed and the setup code from its logs or dashboard.
      </P>
      <Field label="Server address" value={server} onChangeText={setServer} placeholder="homecircle-abc.onrender.com" autoCapitalize="none" autoCorrect={false} keyboardType="url" />
      <Field label="Setup code" value={code} onChangeText={setCode} placeholder="From your server logs" autoCapitalize="none" autoCorrect={false} />
      <Field label="Your name" value={name} onChangeText={setName} placeholder="e.g. Sam" autoComplete="given-name" />
      <Field label="Circle name" value={circleName} onChangeText={setCircleName} placeholder="e.g. The Parkers" />
      <Button title="Create my circle" variant="primary" loading={busy} disabled={!server || !code || !name} onPress={submit} />
      <ErrorText>{error}</ErrorText>
      <LockNote>
        Your encryption keys are created on this phone and never leave it. You’ll be the circle’s owner. Everyone who joins agrees that the
        circle can see their location and ask for it at any time.
      </LockNote>
    </Screen>
  );
}
