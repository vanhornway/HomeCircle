import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Redirect } from 'expo-router';
import { ensureLoaded } from '../lib/circle';
import { HOME } from '../lib/nav';
import { IS_COMPANION } from '../lib/variant';
import { useTheme } from '../theme';

export default function Index() {
  const t = useTheme();
  const [state, setState] = useState<'loading' | 'in' | 'out'>('loading');
  useEffect(() => {
    ensureLoaded().then((ok) => setState(ok ? 'in' : 'out'));
  }, []);
  if (state === 'in') return <Redirect href={HOME} />;
  if (state === 'out') return <Redirect href={IS_COMPANION ? '/companion/join' : '/welcome'} />;
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: t.bg }}>
      <ActivityIndicator color={t.brand} />
    </View>
  );
}
