import { useCallback, useState } from 'react';
import { Alert, FlatList, Share, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Button, Card, P } from '../components/ui';
import { clearDiagnostics, diagnosticsText, formatEntry, readDiagnostics, summarize, type DiagEntry } from '../lib/diagnostics';
import { errorText, getClient } from '../lib/circle';
import { useTheme } from '../theme';

/**
 * This phone's 7-day background log: what woke it, what it sent, and what
 * failed. Stays on the phone unless you send it.
 */
export default function Diagnostics() {
  const t = useTheme();
  const [entries, setEntries] = useState<DiagEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    readDiagnostics().then(setEntries);
  }, []);
  useFocusEffect(load);

  const client = getClient();
  const me = client.me;
  const admins = client.memberList().filter((m) => !m.isMe && (m.role === 'owner' || m.role === 'admin'));
  const s = entries ? summarize(entries) : null;
  const header = `HomeCircle diagnostics from ${me?.name ?? 'this phone'} (${client.circle.name})`;

  const sendToAdmin = async () => {
    if (!entries) return;
    setBusy(true);
    try {
      // A direct message holds a summary and the latest events; the full log
      // can be shared separately.
      const text = diagnosticsText(entries, header, 40).slice(0, 3900);
      for (const a of admins) await client.sendChat(text, { to: a.id });
      Alert.alert('Sent', `Your diagnostics summary was sent to ${admins.map((a) => a.name).join(' and ')} as a private message.`);
    } catch (e) {
      Alert.alert('Couldn’t send it', errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const shareAll = () => entries && Share.share({ title: 'HomeCircle diagnostics', message: diagnosticsText(entries, header) });

  const stat = (label: string, value: string | number) => (
    <View style={{ width: '50%', paddingVertical: 6 }}>
      <Text style={{ color: t.text, fontSize: 20, fontWeight: '700' }}>{value}</Text>
      <Text style={{ color: t.muted, fontSize: 13 }}>{label}</Text>
    </View>
  );

  return (
    <FlatList
      style={{ backgroundColor: t.bg }}
      contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      data={entries ? [...entries].reverse().slice(0, 300) : []}
      keyExtractor={(x, i) => `${x.t}-${i}`}
      ListHeaderComponent={
        <View style={{ gap: 12, marginBottom: 12 }}>
          <P muted>What HomeCircle did in the background over the last 7 days. It stays encrypted on this phone unless you send it.</P>
          {s ? (
            <Card style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
              {stat('Background wake-ups', s.wakeups)}
              {stat('Location uploads', `${s.uploads}${s.uploadFailures ? ` (${s.uploadFailures} failed)` : ''}`)}
              {stat('Arrivals / departures', `${s.arrivals} / ${s.departures}`)}
              {stat('Locate requests', s.locateRequests)}
              {stat('Longest gap', `${s.longestGapMin} min`)}
              {stat('Errors', s.errors)}
            </Card>
          ) : null}
          {admins.length ? (
            <Button title={`Send to ${admins.length === 1 ? admins[0].name : 'admins'}`} variant="primary" loading={busy} disabled={!entries?.length} onPress={sendToAdmin} />
          ) : null}
          <Button title="Share full log" disabled={!entries?.length} onPress={shareAll} />
          <Button
            small
            variant="ghost"
            title="Clear log"
            onPress={() =>
              Alert.alert('Clear the diagnostics log?', 'It starts again from now.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Clear', style: 'destructive', onPress: () => clearDiagnostics().then(load) },
              ])
            }
          />
          <Text style={{ color: t.muted, fontSize: 13, fontWeight: '700', marginTop: 8 }}>LATEST EVENTS</Text>
        </View>
      }
      renderItem={({ item }) => (
        <Text style={{ color: item.e.includes('fail') || item.e === 'error' ? t.danger : t.text, fontSize: 12, fontFamily: 'monospace', paddingVertical: 3 }} selectable>
          {formatEntry(item)}
        </Text>
      )}
      ListEmptyComponent={entries ? <Text style={{ color: t.muted }}>Nothing logged yet.</Text> : undefined}
    />
  );
}
