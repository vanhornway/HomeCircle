import { useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { endMySos, useMySos } from '../../lib/sos';
import { say, urdu } from '../../companion/lines';
import { C, URDU } from '../../companion/theme';

/** Her SOS is on: her family has been told, and her location goes every minute until "I'm safe now". */
export default function CompanionSos() {
  const sos = useMySos();
  useEffect(() => {
    if (sos === null) router.back();
  }, [sos]);
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.red }}>
      <View style={{ flex: 1, padding: 24, gap: 24, justifyContent: 'center' }}>
        <Text style={{ color: C.white, fontSize: 56, fontWeight: '800', textAlign: 'center', letterSpacing: 6 }}>SOS</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Hear it again" onPress={() => say({ id: 'sos_sent' })}>
          <Text style={[URDU, { color: C.white, fontSize: 30, lineHeight: 64, textAlign: 'center' }]}>{urdu({ id: 'sos_sent' })}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="I'm safe now"
          onPress={() => {
            say({ id: 'sos_safe' });
            endMySos().catch(() => {});
          }}
          style={({ pressed }) => ({ minHeight: 120, borderRadius: 32, backgroundColor: C.white, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.85 : 1 })}
        >
          <Text style={[URDU, { color: C.ink, fontSize: 30, lineHeight: 64, textAlign: 'center' }]}>{urdu({ id: 'sos_safe' })}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
