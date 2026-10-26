import { useEffect, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { CircleClient, defaultFeatures, type PendingRejoin, type RecoverableCircle, type ServerInfo } from '@homecircle/core';
import { FeatureChooser } from '../components/FeaturePicker';
import { Button, Card, ErrorText, Field, H1, LockNote, P, Screen } from '../components/ui';
import { addCircle, allClients, clientForCircle, draftClient, errorText, serverHost, setActiveCircle } from '../lib/circle';
import { enterApp } from '../lib/nav';
import { clearPendingRejoin, getPendingRejoin, setPendingRejoin } from '../lib/rejoin';
import { updateSettings } from '../lib/storage';
import { timeAgo } from '../lib/useCircle';
import { useTheme } from '../theme';

type Server = { info: ServerInfo; code: string };
type Phase =
  | { step: 'loading' }
  | { step: 'code' }
  | { step: 'list'; server: Server; circles: RecoverableCircle[] }
  | { step: 'rejoin'; server: Server; circles: RecoverableCircle[]; circle: RecoverableCircle; label: string }
  | { step: 'wait'; pending: PendingRejoin };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** After joining a circle from here: the first one on this phone goes through permissions. */
async function opened(client: CircleClient, info?: ServerInfo) {
  const first = allClients().length === 0;
  await addCircle(client);
  if (first) {
    if (info) await updateSettings({ tileUrl: info.tileUrl, tileAttribution: info.tileAttribution });
    enterApp('/permissions');
  } else {
    enterApp();
  }
}

/**
 * Whoever set up a server can always get back in with its setup code: ask to
 * rejoin a circle (a member approves it on their phone), start a new circle,
 * or delete one nobody uses anymore.
 */
export default function Recover() {
  const t = useTheme();
  const params = useLocalSearchParams<{ server?: string }>();
  const [phase, setPhase] = useState<Phase>({ step: 'loading' });
  const [address, setAddress] = useState(params.server ? serverHost(params.server) : '');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [circleName, setCircleName] = useState('');
  const [features, setFeatures] = useState(defaultFeatures);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waitNote, setWaitNote] = useState<string | null>(null);

  useEffect(() => {
    getPendingRejoin().then((pending) => setPhase(pending ? { step: 'wait', pending } : { step: 'code' }));
  }, []);

  // Waiting: check every few seconds whether a member approved.
  const pending = phase.step === 'wait' ? phase.pending : null;
  useEffect(() => {
    if (!pending) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        const client = draftClient();
        const result = await client.finishRejoin(pending);
        if (stopped) return;
        if (result === 'joined') {
          await clearPendingRejoin();
          await opened(client, await CircleClient.serverInfo(pending.server).catch(() => undefined));
          return;
        }
        if (result === 'denied' || result === 'expired') {
          await clearPendingRejoin();
          setWaitNote(result === 'denied' ? 'Your request was denied.' : 'Your request expired. Start again with the setup code.');
          return;
        }
        setWaitNote(null);
      } catch (e) {
        if (!stopped) setWaitNote(errorText(e));
      }
      if (!stopped) timer = setTimeout(check, 5000);
    };
    check();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [pending]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const loadCircles = (server: Server) =>
    run(async () => {
      const { circles } = await CircleClient.recoverCircles(server.info.server, server.code);
      setPhase({ step: 'list', server, circles });
    });

  if (phase.step === 'loading') return <Screen>{null}</Screen>;

  if (phase.step === 'wait') {
    const done = waitNote === 'Your request was denied.' || waitNote?.startsWith('Your request expired');
    return (
      <Screen>
        <H1 style={{ marginTop: 8 }}>Waiting for approval</H1>
        <P muted style={{ marginTop: 8 }}>
          Ask someone in the circle to open HomeCircle. They’ll see your request at the top of the map and can let you back in.
        </P>
        <Card style={{ marginTop: 18, gap: 8 }}>
          <Text style={{ color: t.muted, fontSize: 14 }}>They’ll check this safety number. Read it to them in person or on a call:</Text>
          <Text selectable style={{ color: t.text, fontSize: 20, fontFamily: 'monospace', letterSpacing: 1 }}>
            {phase.pending.safetyNumber}
          </Text>
        </Card>
        <Text style={{ color: done ? t.danger : t.muted, fontSize: 14, marginTop: 14 }}>{waitNote || 'Waiting for approval…'}</Text>
        <Button
          title={done ? 'Back' : 'Cancel request'}
          style={{ marginTop: 18 }}
          onPress={async () => {
            await clearPendingRejoin();
            setWaitNote(null);
            setPhase({ step: 'code' });
          }}
        />
      </Screen>
    );
  }

  if (phase.step === 'code') {
    return (
      <Screen>
        <P muted style={{ marginTop: 8, marginBottom: 20 }}>
          If you set up a HomeCircle server, its setup code gets you back in: rejoin your circle, start a new one, or delete one nobody uses.
        </P>
        <Field label="Server address" value={address} onChangeText={setAddress} placeholder="homecircle-abc.onrender.com" autoCapitalize="none" autoCorrect={false} keyboardType="url" />
        <Field label="Setup code" value={code} onChangeText={setCode} placeholder="From your server logs" autoCapitalize="none" autoCorrect={false} />
        <Button
          title="Continue"
          variant="primary"
          loading={busy}
          disabled={!address.trim() || !code.trim()}
          onPress={() =>
            run(async () => {
              const info = await CircleClient.serverInfo(address);
              if (!info.recovery) throw new Error('This server needs an update (HomeCircle 0.8 or newer) before it can use the setup code this way.');
              const server = { info, code: code.trim() };
              const { circles } = await CircleClient.recoverCircles(info.server, server.code);
              setPhase({ step: 'list', server, circles });
            })
          }
        />
        <ErrorText>{error}</ErrorText>
        <LockNote>Find the setup code in your server’s log, in Render’s Environment tab (SETUP_TOKEN), or as setup_code in Home Assistant.</LockNote>
      </Screen>
    );
  }

  if (phase.step === 'rejoin') {
    const { server, circle, label } = phase;
    return (
      <Screen>
        <H1 style={{ marginTop: 8 }}>Rejoin {label}</H1>
        <P muted style={{ marginTop: 8, marginBottom: 20 }}>
          Someone still in it ({plural(circle.members, 'member')}) approves you on their phone. You’ll come back as the circle’s owner. Your old phone stays listed until you remove it.
        </P>
        <Field label="Your name" value={name} onChangeText={setName} placeholder="So they know it’s you" autoComplete="given-name" autoFocus />
        <Button
          title="Ask to rejoin"
          variant="primary"
          loading={busy}
          disabled={!name.trim()}
          onPress={() =>
            run(async () => {
              const req = await CircleClient.requestRejoin({ serverUrl: server.info.server, setupToken: server.code, circleId: circle.id, name });
              await setPendingRejoin(req);
              setPhase({ step: 'wait', pending: req });
            })
          }
        />
        <ErrorText>{error}</ErrorText>
        <Button title="Back" variant="ghost" style={{ marginTop: 8 }} onPress={() => setPhase({ step: 'list', server, circles: phase.circles })} />
      </Screen>
    );
  }

  const { server, circles } = phase;
  return (
    <Screen>
      <H1 style={{ marginTop: 8 }}>Circles on {serverHost(server.info.server)}</H1>
      <P muted style={{ marginTop: 8 }}>
        Circle names are encrypted, so the server can’t show them. Tell them apart by when each was created and how many people are in it.
      </P>
      <Card style={{ marginTop: 16, gap: 4 }}>
        {circles.length ? null : <Text style={{ color: t.muted, fontSize: 15 }}>There are no circles on this server.</Text>}
        {circles.map((c, i) => {
          const mine = clientForCircle(c.id);
          const label = mine?.circle.name || `Circle ${i + 1}`;
          const bits = [
            `created ${new Date(c.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`,
            plural(c.members, 'member'),
            c.lastSeenAt ? `active ${timeAgo(c.lastSeenAt)}` : 'never active',
          ];
          if (c.waiting) bits.push(`${c.waiting} waiting`);
          return (
            <View key={c.id} style={{ paddingVertical: 10, gap: 8, borderBottomWidth: i < circles.length - 1 ? 1 : 0, borderBottomColor: t.line }}>
              <View>
                <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>{label}</Text>
                <Text style={{ color: t.muted, fontSize: 13 }}>{bits.join(' · ')}</Text>
              </View>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {mine ? (
                  <Button
                    small
                    title="Open"
                    style={{ flex: 1 }}
                    onPress={async () => {
                      await setActiveCircle(mine.accountKey);
                      enterApp();
                    }}
                  />
                ) : (
                  <Button small title="Ask to rejoin" disabled={!c.members} style={{ flex: 1 }} onPress={() => setPhase({ step: 'rejoin', server, circles, circle: c, label })} />
                )}
                <Button
                  small
                  title="Delete"
                  variant="danger"
                  style={{ flex: 1 }}
                  onPress={() =>
                    Alert.alert(`Delete ${label}?`, 'Everyone in it is removed, and its messages, places and locations are deleted. This can’t be undone.', [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Delete',
                        style: 'destructive',
                        onPress: () =>
                          run(async () => {
                            await CircleClient.recoverDeleteCircle(server.info.server, server.code, c.id);
                            const { circles: next } = await CircleClient.recoverCircles(server.info.server, server.code);
                            setPhase({ step: 'list', server, circles: next });
                          }),
                      },
                    ])
                  }
                />
              </View>
            </View>
          );
        })}
      </Card>
      <ErrorText>{error}</ErrorText>

      <Text style={{ color: t.text, fontSize: 17, fontWeight: '700', marginTop: 18, marginBottom: 10 }}>Start a new circle</Text>
      <Field label="Your name" value={name} onChangeText={setName} placeholder="e.g. Sam" autoComplete="given-name" />
      <Field label="Circle name" value={circleName} onChangeText={setCircleName} placeholder="e.g. The Parkers" />
      <View style={{ marginBottom: 18 }}>
        <FeatureChooser value={features} onChange={setFeatures} />
      </View>
      <Button
        title="Create circle"
        variant="primary"
        loading={busy}
        disabled={!name.trim()}
        onPress={() =>
          run(async () => {
            const client = draftClient();
            await client.createCircle({ serverUrl: server.info.server, setupToken: server.code, name, circleName, features });
            await opened(client, server.info);
          })
        }
      />
      <Button title="Refresh" variant="ghost" style={{ marginTop: 8 }} onPress={() => loadCircles(server)} />
      <LockNote>Rejoining needs someone still in that circle to approve you on their phone. The setup code alone can’t open a circle.</LockNote>
    </Screen>
  );
}
