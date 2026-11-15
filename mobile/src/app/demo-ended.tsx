import { View } from 'react-native';
import { router } from 'expo-router';
import { Button, H1, Logo, P, Screen } from '../components/ui';
import { allClients } from '../lib/circle';
import { enterApp } from '../lib/nav';

/** The demo family's hour is up, or the phone was away too long. */
export default function DemoEnded() {
  const inACircle = allClients().length > 0;
  return (
    <Screen>
      <View style={{ marginTop: 24, marginBottom: 20 }}>
        <Logo size={64} />
      </View>
      <H1>Demo ended. Start again?</H1>
      <P muted style={{ marginTop: 10, marginBottom: 26 }}>
        That family and everything in it are gone. A new copy starts a fresh day.
      </P>
      <Button title="Start again" variant="primary" onPress={() => router.replace('/demo')} />
      {inACircle ? <Button title="Back to my family" variant="ghost" onPress={() => enterApp()} style={{ marginTop: 6 }} /> : <Button title="Done" variant="ghost" onPress={() => router.replace('/welcome')} style={{ marginTop: 6 }} />}
    </Screen>
  );
}
