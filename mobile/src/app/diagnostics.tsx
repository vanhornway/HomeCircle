import { useCallback, useState } from 'react';
import { Alert, FlatList, Share, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Button, Card, P } from '../components/ui';
import { clearDiagnostics, diagnosticsText, formatEntry, formatGap, readDiagnostics, summarize, type DiagEntry } from '../lib/diagnostics';
import { errorText, getClient } from '../lib/circle';
import { energyReport, formatMah, type Counts } from '../lib/energy';
import { useTheme } from '../theme';

/** "today 9:12" or "Oct 25, 18:40". */
const sinceText = (t: number) =>
  new Date(t).toDateString() === new Date().toDateString()
    ? `today ${new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
    : new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** What the estimate is made of, in one line. */
function countsText(c: Counts) {
  const wakes = Object.entries(c.wakes);
  const total = wakes.reduce((n, [, v]) => n + v, 0);
  const up = c.uploads.cell + c.uploads.wifi + c.uploads.other;
  const fetches = c.fetches.cell + c.fetches.wifi + c.fetches.other;
  return [
    `${total} wake-ups${wakes.length ? ` (${wakes.map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`,
    `${c.fixes} location fixes and ${c.highFixes} GPS fixes`,
    `${up} uploads (${c.uploads.cell} on mobile data, ${c.uploads.wifi} on Wi-Fi)`,
    `${fetches} message fetches (${c.fetches.cell} on mobile data)`,
  ].join(' · ');
}

/**
 * This phone's 7-day background log: what woke it, what it sent, and what
 * failed. Stays on the phone unless you send it.
 */
export default function Diagnostics() {
  const t = useTheme();
  const [entries, setEntries] = useState<DiagEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [energy, setEnergy] = useState<Awaited<ReturnType<typeof energyReport>> | null>(null);
  const load = useCallback(() => {
    readDiagnostics().then(setEntries);
    energyReport().then(setEnergy);
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
              {stat(s.gapOngoing ? 'Since last upload' : 'Longest without an upload', formatGap(s.longestGapMin))}
              {stat('Errors', s.errors)}
            </Card>
          ) : null}
          {energy ? (
            <Card style={{ gap: 8 }}>
              <Text style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>Battery use (estimated)</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                {stat('Today', formatMah(energy.today.mah))}
                {stat(energy.charging ? 'Charging now' : `Since unplugged (${sinceText(energy.unplugged.since)})`, formatMah(energy.unplugged.mah))}
              </View>
              <Text style={{ color: t.muted, fontSize: 13, lineHeight: 18 }}>{countsText(energy.today)}</Text>
              <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17 }}>
                Worked out from what HomeCircle did (each wake-up, location fix and upload has a typical cost), for a 5000 mAh battery. Time on the charger isn’t counted
                against the battery.
              </Text>
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
