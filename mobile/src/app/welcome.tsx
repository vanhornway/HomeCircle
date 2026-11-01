import { Linking, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Button, H1, Logo, P, Screen } from '../components/ui';
import { HowThisWorks } from '../components/HowThisWorks';
import { LANDING_URL, useTheme } from '../theme';

const POINTS = [
  ['End-to-end encrypted', 'Locations, messages and places are encrypted on your phone. Even your server can’t read them.'],
  ['Easy on the battery', 'Updates about every 15 minutes, or right away when someone taps “Locate”.'],
  ['Your server, your data', 'Your family runs its own HomeCircle server. No company in the middle.'],
];

/** First screen: joining family comes first; setting up a server is for whoever runs it. */
export default function Welcome() {
  const t = useTheme();
  return (
    <Screen>
      <View style={{ marginTop: 24, marginBottom: 20 }}>
        <Logo size={64} />
      </View>
      <H1>Your family, close and private.</H1>
      <P muted style={{ marginTop: 10, marginBottom: 26 }}>
        See where everyone is, chat, and get alerts when people arrive home.
      </P>
      <Button title="Join my family" variant="primary" style={{ minHeight: 68 }} onPress={() => router.push('/join')} />
      <P muted style={{ marginTop: 10, textAlign: 'center', fontSize: 14 }}>
        Someone in your family sends you an invite.
      </P>
      <HowThisWorks title="How HomeCircle keeps you private" style={{ alignSelf: 'center', marginTop: 4 }}>
        {POINTS.map(([title, body]) => (
          <View key={title}>
            <Text style={{ color: t.text, fontWeight: '700', fontSize: 15 }}>{title}</Text>
            <Text style={{ color: t.muted, fontSize: 15, lineHeight: 21, marginTop: 2 }}>{body}</Text>
          </View>
        ))}
      </HowThisWorks>

      <Text style={{ color: t.muted, fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 30, marginBottom: 10, marginLeft: 4 }}>Running the family server?</Text>
      <Button title="Set up a new server" onPress={() => router.push('/setup')} />
      <Button title="Get back in with a setup code" variant="ghost" onPress={() => router.push('/recover')} style={{ marginTop: 6 }} />
      <Button title="How to get a server" variant="ghost" onPress={() => Linking.openURL(LANDING_URL)} style={{ marginTop: 2 }} />
      <HowThisWorks title="Where can the server run?" style={{ alignSelf: 'center' }}>
        {`No server yet? Pick one in two minutes at ${LANDING_URL.replace('https://', '')}: Render, Railway, Fly.io, DigitalOcean, Hetzner, or a Raspberry Pi at home.`}
      </HowThisWorks>
    </Screen>
  );
}
