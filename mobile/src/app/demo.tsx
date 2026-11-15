import { useState } from 'react';
import { Button, ErrorText, Field, H1, LockNote, P, Screen } from '../components/ui';
import { errorText } from '../lib/circle';
import { startDemo } from '../lib/demo';
import { enterApp } from '../lib/nav';

/** "Try a demo family": a name, then straight in. */
export default function Demo() {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await startDemo(name);
      enterApp();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Screen>
      <H1 style={{ marginTop: 12 }}>Meet a family for an hour</H1>
      <P muted style={{ marginTop: 8, marginBottom: 24 }}>
        Twenty made-up people go through a whole day in 60 minutes: school runs, commutes, groceries, dinner at Nani’s. Chat with them, watch them on the map, open their lists and recipes.
      </P>
      <Field label="Your first name" value={name} onChangeText={setName} placeholder="What should they call you?" autoComplete="given-name" autoFocus />
      <Button title="Start the demo" variant="primary" loading={busy} disabled={!name.trim()} onPress={start} />
      <ErrorText>{error}</ErrorText>
      <LockNote>This copy is yours alone, and it’s deleted when the hour is up or when you leave. Your real location isn’t used, and your own circles aren’t touched.</LockNote>
    </Screen>
  );
}
