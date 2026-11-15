import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { demoMinutesLeft } from '../lib/demo';
import { useCircle } from '../lib/useCircle';
import { useTheme } from '../theme';

/** In a demo family: how long is left. */
export function DemoBanner({ style }: { style?: object }) {
  const t = useTheme();
  const client = useCircle(['circle']);
  const endsAt = client.demo?.endsAt;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!endsAt) return;
    const id = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(id);
  }, [endsAt]);
  if (!endsAt) return null;
  const left = demoMinutesLeft(endsAt);
  return (
    <View accessibilityRole="timer" style={[{ backgroundColor: t.brandSoft, borderRadius: 12, paddingVertical: 8, paddingHorizontal: 14 }, style]}>
      <Text style={{ color: t.text, fontSize: 14, fontWeight: '600', textAlign: 'center' }}>{left > 1 ? `Demo ends in ${left} min` : 'Demo ends in a minute'}</Text>
    </View>
  );
}
