import { Linking, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Button, H1, LockNote, Logo, P, Screen } from '../components/ui';
import { LANDING_URL, useTheme } from '../theme';

const POINTS = [
  ['Your server, your data', 'Your family runs its own HomeCircle server. No company in the middle.'],
  ['End-to-end encrypted', 'Locations, messages and places are encrypted on your phone. Even your server can’t read them.'],
  ['Easy on the battery', 'Updates about every 15 minutes, or right away when someone taps “Locate”.'],
];

export default function Welcome() {
  const t = useTheme();
  return (
    <Screen>
      <View style={{ marginTop: 24, marginBottom: 20 }}>
        <Logo size={64} />
      </View>
      <H1>Stay close to your family, privately.</H1>
      <P muted style={{ marginTop: 10 }}>
        See where everyone is, chat, and get alerts when people arrive home — shared only with the people on your server.
      </P>
      <View style={{ marginVertical: 26, gap: 16 }}>
        {POINTS.map(([title, body]) => (
          <View key={title} style={{ flexDirection: 'row', gap: 12 }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: t.accent, marginTop: 8 }} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, fontWeight: '700', fontSize: 16 }}>{title}</Text>
              <Text style={{ color: t.muted, fontSize: 15, lineHeight: 21, marginTop: 2 }}>{body}</Text>
            </View>
          </View>
        ))}
      </View>
      <Button title="Join my family" variant="primary" onPress={() => router.push('/join')} />
      <View style={{ height: 12 }} />
      <Button title="Set up a new server" onPress={() => router.push('/setup')} />
      <Button title="Get back in with a setup code" variant="ghost" onPress={() => router.push('/recover')} style={{ marginTop: 6 }} />
      <LockNote>
        No server yet? Pick one in two minutes at {LANDING_URL.replace('https://', '')} — Render, Railway, Fly.io, DigitalOcean, Hetzner, or a Raspberry Pi at home.
      </LockNote>
      <Button title="How to get a server" variant="ghost" onPress={() => Linking.openURL(LANDING_URL)} style={{ marginTop: 6 }} />
    </Screen>
  );
}
