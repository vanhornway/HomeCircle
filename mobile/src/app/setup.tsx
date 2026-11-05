import { useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { CircleClient, defaultFeatures } from '@homecircle/core';
import { FeatureChooser } from '../components/FeaturePicker';
import { Button, ErrorText, Field, H1, P, Screen } from '../components/ui';
import { HowThisWorks } from '../components/HowThisWorks';
import { addCircle, allClients, draftClient, errorText } from '../lib/circle';
import { enterApp } from '../lib/nav';
import { finishJoining } from '../lib/firstRun';
import { updateSettings } from '../lib/storage';
import { parseSetupLink } from '../lib/setupLink';
import { useTheme } from '../theme';

export default function Setup() {
  const t = useTheme();
  // From the server's first page: homecircle://setup?server=…&t=…
  const params = useLocalSearchParams<{ server?: string; t?: string }>();
  const [server, setServer] = useState(params.server ?? '');
  const [code, setCode] = useState('');
  // A one-time ticket stands in for the setup code; nothing to type.
  const [ticket, setTicket] = useState(params.t ?? '');
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [name, setName] = useState('');
  const [circleName, setCircleName] = useState('');
  const [features, setFeatures] = useState(defaultFeatures);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const info = await CircleClient.serverInfo(server);
      // Servers from 0.8 accept the setup code for more circles; older ones only for the first.
      if (info.setup && !info.recovery) {
        throw new Error('This server is already set up. Ask the person who set it up to create a circle for you, or to invite you.');
      }
      const first = allClients().length === 0;
      const client = draftClient();
      await client.createCircle({ serverUrl: info.server, setupToken: ticket || code, name, circleName, features });
      await addCircle(client);
      if (first) {
        await updateSettings({ tileUrl: info.tileUrl, tileAttribution: info.tileAttribution });
        await finishJoining();
      } else {
        enterApp();
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const scan = async () => {
    setError(null);
    if (!permission?.granted && !(await requestPermission()).granted) return setError('HomeCircle needs the camera to scan the code. You can type the details below instead.');
    setScanning(true);
  };
  const scanned = (value: string) => {
    const found = parseSetupLink(value);
    if (!found) return;
    setServer(found.server);
    setTicket(found.ticket);
    setScanning(false);
  };

  if (scanning) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={({ data }) => scanned(data)} />
        <View style={{ position: 'absolute', bottom: 48, alignSelf: 'center' }}>
          <Button title="Cancel" onPress={() => setScanning(false)} />
        </View>
      </View>
    );
  }

  const filled = !!(server && ticket);
  return (
    <Screen>
      <H1 style={{ marginTop: 12 }}>{filled ? 'Create your circle' : 'Set up your server'}</H1>
      {filled ? (
        <Text style={{ color: t.brand, fontWeight: '600', fontSize: 15, marginTop: 8, marginBottom: 18 }}>✓ Connected to {server.replace(/^https?:\/\//, '')}</Text>
      ) : (
        <>
          <P muted style={{ marginTop: 8, marginBottom: 14 }}>
            Open your server’s address on a computer and scan the code it shows. Or type its address and the setup code from its logs or dashboard.
          </P>
          <Button title="Scan the code on my computer" variant="primary" style={{ marginBottom: 18 }} onPress={scan} />
          <Field label="Server address" value={server} onChangeText={setServer} placeholder="homecircle-abc.onrender.com" autoCapitalize="none" autoCorrect={false} keyboardType="url" />
          <Field label="Setup code" value={code} onChangeText={setCode} placeholder="From your server logs" autoCapitalize="none" autoCorrect={false} />
        </>
      )}
      <Field label="Your name" value={name} onChangeText={setName} placeholder="e.g. Sam" autoComplete="given-name" />
      <Field label="Circle name" value={circleName} onChangeText={setCircleName} placeholder="e.g. The Parkers" />
      <View style={{ marginBottom: 18 }}>
        <FeatureChooser value={features} onChange={setFeatures} />
      </View>
      <Button title="Create my circle" variant="primary" loading={busy} disabled={!server || !(code || ticket) || !name} onPress={submit} />
      <ErrorText>{error}</ErrorText>
      <Button
        title="Already have a circle there? Get back in"
        variant="ghost"
        style={{ marginTop: 8 }}
        onPress={() => router.push(server.trim() ? { pathname: '/recover', params: { server } } : '/recover')}
      />
      <HowThisWorks style={{ marginTop: 14 }}>
        {[
          'Your encryption keys are created on this phone and never leave it.',
          'You’ll be the circle’s owner. Everyone who joins agrees that the circle can see their location and ask for it at any time.',
        ]}
      </HowThisWorks>
    </Screen>
  );
}
