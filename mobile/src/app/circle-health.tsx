import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Avatar, Button, Card, P, Screen } from '../components/ui';
import { HowThisWorks } from '../components/HowThisWorks';
import { errorText } from '../lib/circle';
import { cadenceLine, memberState, statusLine, type MemberState } from '../lib/people';
import { timeAgo, useCircle } from '../lib/useCircle';
import { APP_VERSION } from '../lib/updates';
import { useTheme } from '../theme';
import { showSheet } from '../lib/sheet';

/** Whether version a ("0.15.0") is older than b. */
const olderThan = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  return false;
};

const LABELS: Record<MemberState, string> = {
  live: 'Sharing normally',
  saver: 'Battery saver on',
  settings: 'Setup needs attention',
  paused: 'Paused',
  locating: 'Locating…',
  'no-reply': 'Didn’t answer Locate',
  'last-gasp': 'Battery may have died',
  offline: 'No updates for 2+ hours',
  none: 'Never shared',
};

/** Admins: how each member's phone is set up, and a nudge to fix problems. */
export default function CircleHealth() {
  const t = useTheme();
  const client = useCircle();
  const [now, setNow] = useState(() => Date.now());
  const [sent, setSent] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const members = client.memberList();
  const problems = (id: string) => {
    const loc = client.locations.get(id);
    const out: string[] = [];
    if (loc?.perm === 'foreground') out.push('location is set to While Using instead of Always');
    if (loc?.precise === false) out.push('precise location is off');
    if (loc && now - loc.ts > 2 * 3600_000) out.push(`no update since ${timeAgo(loc.ts)}`);
    return out;
  };

  const nudge = async (id: string, why: string) => {
    try {
      await client.nudgeSetup(id, why);
      setSent((s) => ({ ...s, [id]: true }));
    } catch (e) {
      showSheet('Couldn’t send it', errorText(e));
    }
  };

  const row = (label: string, value: string, bad = false) => (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 }}>
      <Text style={{ color: t.muted, fontSize: 14 }}>{label}</Text>
      <Text style={{ color: bad ? t.danger : t.text, fontSize: 14, fontWeight: '600' }}>{value}</Text>
    </View>
  );

  return (
    <Screen>
      <P muted style={{ marginTop: 8, marginBottom: 14 }}>
        How each phone in {client.circle.name} is set up.
      </P>
      <HowThisWorks style={{ marginBottom: 8 }}>
        {[
          'This comes from what each phone sends with its location. Names and places stay encrypted; this only shows settings.',
          '“Not reported” means that phone runs an older HomeCircle version. It updates once they install the latest app.',
        ]}
      </HowThisWorks>
      <View style={{ gap: 10 }}>
        {members.map((m) => {
          const loc = client.locations.get(m.id);
          const state = memberState(client, m, now);
          const issues = problems(m.id);
          return (
            <Card key={m.id} style={{ gap: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Avatar name={m.name} color={m.color} size={40} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>
                    {m.name}
                    {m.isMe ? ' (you)' : ''}
                  </Text>
                  <Text style={{ color: state === 'live' ? t.brand : t.warnText, fontSize: 14, fontWeight: '600' }}>{LABELS[state]}</Text>
                </View>
              </View>
              <Text style={{ color: t.muted, fontSize: 14 }}>{statusLine(client, m, now)}</Text>
              {loc ? (
                <View>
                  {row('Last update', timeAgo(loc.ts), now - loc.ts > 2 * 3600_000)}
                  {row('HomeCircle app', loc.app ?? 'Older than 0.16', !loc.app || olderThan(loc.app, APP_VERSION))}
                  {row('Updates', cadenceLine(loc) ?? 'Not reported')}
                  {row('Location permission', loc.perm === 'always' ? 'Always' : loc.perm === 'foreground' ? 'While using' : 'Not reported', loc.perm === 'foreground')}
                  {row('Precise location', loc.precise === false ? 'Off' : loc.precise ? 'On' : 'Not reported', loc.precise === false)}
                  {row('Battery saver', loc.power === 'saver' ? 'On' : loc.power === 'normal' ? 'Off' : 'Not reported', loc.power === 'saver')}
                  {row('Battery', loc.battery != null ? `${Math.round(loc.battery * 100)}%${loc.charging ? ' (charging)' : ''}` : '—', !!loc.battery && loc.battery < 0.15 && !loc.charging)}
                  {row('Last update from', loc.trigger === 'requested' ? 'Locate' : loc.trigger === 'low_battery' ? 'Low battery' : loc.trigger)}
                </View>
              ) : null}
              {!m.isMe && client.isAdmin && (issues.length || state === 'none') ? (
                <Button
                  small
                  title={sent[m.id] ? 'Nudge sent' : 'Nudge to fix setup'}
                  disabled={sent[m.id]}
                  onPress={() => nudge(m.id, issues.join(', ') || 'your phone hasn’t shared a location yet')}
                  style={{ alignSelf: 'flex-start' }}
                />
              ) : null}
            </Card>
          );
        })}
      </View>
    </Screen>
  );
}
