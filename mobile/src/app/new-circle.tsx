import { useState } from 'react';
import { Text } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Button, ErrorText, Field, LockNote, P, Screen } from '../components/ui';
import { addCircle, draftClient, errorText, getClient, useCircles } from '../lib/circle';
import { useTheme } from '../theme';

/** Server admins: start another circle on the same server (e.g. parents and siblings). */
export default function NewCircle() {
  const t = useTheme();
  const { clients } = useCircles();
  // Settings passes the server picked there. Otherwise prefer the circle on
  // screen, then any circle whose server lets us create.
  const { server } = useLocalSearchParams<{ server?: string }>();
  const current = getClient();
  const admin = server
    ? clients.find((c) => c.serverUrl === server && c.isServerAdmin)
    : current.isServerAdmin
      ? current
      : clients.find((c) => c.isServerAdmin);
  const [circleName, setCircleName] = useState('');
  const [name, setName] = useState(admin?.me?.name || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!admin?.serverUrl) return;
    setBusy(true);
    setError(null);
    try {
      const client = draftClient();
      await client.createCircle({ serverUrl: admin.serverUrl, admin, name, circleName });
      await addCircle(client);
      router.back();
      router.push('/invite');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!admin) {
    return (
      <Screen>
        <P muted style={{ marginTop: 12 }}>
          Only the person who set up your HomeCircle server can create new circles on it. Ask them to create one and invite you, or join a circle with an invite.
        </P>
        <Button title="Join a circle instead" style={{ marginTop: 18 }} onPress={() => router.replace('/join')} />
      </Screen>
    );
  }

  return (
    <Screen>
      <P muted style={{ marginTop: 8, marginBottom: 20 }}>
        A circle is a separate group with its own map, chat, places and encryption key. People in one circle can’t see anything in another, even on the same server.
      </P>
      <Field label="Circle name" value={circleName} onChangeText={setCircleName} placeholder="e.g. Parents & siblings" autoFocus />
      <Field label="Your name in this circle" value={name} onChangeText={setName} placeholder="What they call you" autoComplete="given-name" />
      <Text style={{ color: t.muted, fontSize: 13, marginBottom: 16 }}>On {admin.serverUrl?.replace(/^https?:\/\//, '')}</Text>
      <Button title="Create circle" variant="primary" loading={busy} disabled={!circleName.trim() || !name.trim()} onPress={submit} />
      <ErrorText>{error}</ErrorText>
      <LockNote>You’ll own the new circle and can invite people to it next. Your other circles stay exactly as they are.</LockNote>
    </Screen>
  );
}
