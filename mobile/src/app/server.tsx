import { useState } from 'react';
import { Text } from 'react-native';
import { router } from 'expo-router';
import { Button, Card, ErrorText, Field, LockNote, P, Screen } from '../components/ui';
import { allClients, errorText, getClient } from '../lib/circle';
import { retryServer, setServerState, useServerState } from '../lib/connection';
import { useTheme } from '../theme';

/** Change which address this phone uses for its HomeCircle server. */
export default function ServerScreen() {
  const t = useTheme();
  const client = getClient();
  const server = useServerState();
  const current = client.serverUrl || '';
  const [address, setAddress] = useState(current);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const test = async () => {
    setBusy('test');
    setError(null);
    setResult(null);
    try {
      const info = await client.verifyServer(address);
      setResult(`✓ Reachable: HomeCircle ${info.version}, and it hosts ${client.circle.name}.`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy('save');
    setError(null);
    setResult(null);
    try {
      const old = client.serverUrl;
      await client.changeServer(address);
      // Your other circles on the same server moved too. Each one checks the
      // new address with its own token, so only circles really there switch.
      const others = allClients().filter((c) => c !== client && c.serverUrl === old);
      await Promise.allSettled(others.map((c) => c.changeServer(address)));
      setServerState({ reachable: true, error: null });
      retryServer();
      router.back();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen>
      <Card style={{ marginBottom: 18 }}>
        <Text style={{ color: t.muted, fontSize: 13 }}>Current address</Text>
        <Text style={{ color: t.text, fontSize: 16, marginTop: 2 }} selectable>
          {current.replace(/^https?:\/\//, '') || 'none'}
        </Text>
        <Text style={{ color: server.reachable ? t.ok : t.danger, fontSize: 13, marginTop: 6, fontWeight: '600' }}>
          {server.reachable ? 'Connected' : 'Not reachable right now'}
        </Text>
      </Card>
      <P muted style={{ marginBottom: 16 }}>
        Use this if your server moved to a new address, such as a new domain or a new Render URL. The new address must be the same server, with this circle already on it. Your other circles on the same server move with it.
      </P>
      <Field
        label="Server address"
        value={address}
        onChangeText={(v) => {
          setAddress(v);
          setResult(null);
          setError(null);
        }}
        placeholder="homecircle-abc.onrender.com"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      <Button title="Test connection" loading={busy === 'test'} disabled={!address.trim() || !!busy} onPress={test} />
      <Button title="Save address" variant="primary" loading={busy === 'save'} disabled={!address.trim() || !!busy} onPress={save} style={{ marginTop: 10 }} />
      {result ? <Text style={{ color: t.text, marginTop: 12, fontSize: 15 }}>{result}</Text> : null}
      <ErrorText>{error}</ErrorText>
      <LockNote>Your keys stay on this phone. HomeCircle only switches if the new address hosts your circle, so it can’t be pointed at someone else’s server.</LockNote>
    </Screen>
  );
}
