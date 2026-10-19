import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Redirect } from 'expo-router';
import { ensureLoaded } from '../lib/circle';
import { useTheme } from '../theme';

export default function Index() {
  const t = useTheme();
  const [state, setState] = useState<'loading' | 'in' | 'out'>('loading');
  useEffect(() => {
    ensureLoaded().then((ok) => setState(ok ? 'in' : 'out'));
  }, []);
  if (state === 'in') return <Redirect href="/(tabs)" />;
  if (state === 'out') return <Redirect href="/welcome" />;
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: t.bg }}>
      <ActivityIndicator color={t.brand} />
    </View>
  );
}
