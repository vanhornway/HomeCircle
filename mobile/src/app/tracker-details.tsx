// A tracker's details: what the home base's radio last heard from it (signal,
// hops, the relay), and its last positions with how each got here and its
// battery then, as a little chart. From the person sheet: Details.
import { Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { GroupBody, SettingsGroup, SettingsPage } from '../components/SettingsKit';
import { P } from '../components/ui';
import { homeBaseOf, radioFacts, trackerOf, useNow } from '../lib/trackers';
import { timeAgo, useCircle } from '../lib/useCircle';
import { useTheme } from '../theme';

const VIA: Record<string, string> = { radio: 'radio', internet: 'internet', phone: 'phone', beacon: 'public mesh' };

export default function TrackerDetails() {
  const t = useTheme();
  const { member } = useLocalSearchParams<{ member?: string }>();
  const client = useCircle(['records', 'locations', 'members']);
  useNow();
  const tracker = member ? trackerOf(client, member) : null;
  const name = member ? client.members.get(member)?.name : null;
  const st = tracker ? homeBaseOf(client)?.status.trackers.find((x) => x.node === tracker.node) : null;
  if (!tracker || !name) {
    return (
      <SettingsPage title="Tracker">
        <GroupBody>
          <P muted>That tracker isn’t in this circle any more.</P>
        </GroupBody>
      </SettingsPage>
    );
  }
  const r = st?.radio ?? null;
  const log = [...(st?.log ?? [])].reverse();
  const batteries = [...(st?.log ?? [])].filter((e) => e.battery != null);
  return (
    <SettingsPage title={name}>
      <SettingsGroup title="Signal" footer="As the home base’s radio last heard it. SNR above 0 dB is a clear signal; down to −15 dB still gets through on LoRa.">
        <GroupBody gap={6}>
          <Row k="Node" v={tracker.node ?? '—'} />
          <Row k="Last heard" v={r?.at ? timeAgo(r.at) : 'not lately'} />
          <Row k="Hops" v={r?.hops == null ? '—' : r.hops === 0 ? 'heard directly' : `${r.hops} relay${r.hops === 1 ? '' : 's'}`} />
          <Row k="Signal (SNR)" v={r?.snr == null ? '—' : `${r.snr} dB`} />
          <Row k="Battery" v={r?.battery == null ? '—' : `${r.battery}%${r.plugged ? ' · charging' : ''}`} />
          {radioFacts(r) ? <P muted>{radioFacts(r)}</P> : null}
        </GroupBody>
      </SettingsGroup>

      {batteries.length >= 2 ? (
        <SettingsGroup title="Battery" footer={`Over its last ${batteries.length} positions, from ${timeAgo(batteries[0].at)} to now.`}>
          <GroupBody>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 80 }} accessible accessibilityLabel={`Battery from ${batteries[0].battery}% to ${batteries[batteries.length - 1].battery}%`}>
              {batteries.map((e) => (
                <View key={e.at} style={{ flex: 1, height: Math.max(4, (e.battery! / 100) * 80), borderRadius: 3, backgroundColor: e.battery! < 20 ? t.danger : t.brand }} />
              ))}
            </View>
          </GroupBody>
        </SettingsGroup>
      ) : null}

      <SettingsGroup title="Last positions" footer="The ones the home base passed on, newest first, with how each reached it.">
        {log.length ? (
          log.map((e) => (
            <View key={e.at} style={{ paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: 1, borderTopColor: t.line }}>
              <Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>
                {timeAgo(e.at)} · via {VIA[e.src] ?? 'radio'}
                {e.src === 'radio' && e.hops != null ? (e.hops === 0 ? ', directly' : `, ${e.hops} relay${e.hops === 1 ? '' : 's'}`) : ''}
              </Text>
              <Text style={{ color: t.muted, fontSize: 14 }}>
                {e.lat.toFixed(4)}, {e.lng.toFixed(4)}
                {e.snr != null ? ` · ${e.snr} dB` : ''}
                {e.relay?.name ? ` · through ${e.relay.name}` : ''}
                {e.battery != null ? ` · ${e.battery}%` : ''}
              </Text>
            </View>
          ))
        ) : (
          <GroupBody>
            <P muted>None in the last while.</P>
          </GroupBody>
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
      <Text style={{ color: t.muted, fontSize: 15 }}>{k}</Text>
      <Text style={{ color: t.text, fontSize: 15, fontWeight: '600', flexShrink: 1, textAlign: 'right' }}>{v}</Text>
    </View>
  );
}
