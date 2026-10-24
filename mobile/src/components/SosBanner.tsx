import { Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { router } from 'expo-router';
import { useMySos } from '../lib/sos';
import { useAllCircles } from '../lib/useCircle';
import { useTheme } from '../theme';

/** Every SOS that's on, yours and others', in every circle on this phone. Tap to open. */
export function SosBanner({ style }: { style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  const clients = useAllCircles(['messages', 'members']);
  const mine = useMySos();
  const me = new Set(clients.map((c) => c.account?.memberId));
  // Someone in two of your circles shows once.
  const seen = new Set<string>();
  const theirs = clients
    .flatMap((c) => c.activeSos().map((s) => ({ ...s, circleId: c.circleId! })))
    .filter((s) => !me.has(s.memberId) && !seen.has(s.name) && seen.add(s.name));
  if (!mine && !theirs.length) return null;
  const row = (key: string, title: string, detail: string, onPress: () => void) => (
    <Pressable key={key} accessibilityRole="button" onPress={onPress} style={{ backgroundColor: t.danger, borderRadius: 14, padding: 12 }}>
      <Text style={{ color: '#fff', fontWeight: '800', fontSize: 15 }}>{title}</Text>
      <Text style={{ color: '#fff', fontSize: 13 }}>{detail}</Text>
    </Pressable>
  );
  return (
    <View style={[{ gap: 8 }, style]}>
      {mine ? row('mine', '🆘 Your SOS is on', 'Sharing your location every minute. Tap when you’re safe.', () => router.navigate('/sos')) : null}
      {theirs.map((s) =>
        row(s.id, `🆘 ${s.name} needs help`, s.arrived ? `Reached ${s.arrived.place}. Tap to see where they are.` : 'Tap to see where they are.', () =>
          router.push({ pathname: '/sos', params: { circle: s.circleId, member: s.memberId } }),
        ),
      )}
    </View>
  );
}
