import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Redirect } from 'expo-router';
import { ensureLoaded } from '../lib/circle';
import { SKINS, loadSkin, type SkinId } from '../skins';
import { useTheme } from '../theme';

export default function Index() {
  const t = useTheme();
  const [state, setState] = useState<'loading' | 'in' | 'out'>('loading');
  const [skin, setSkinState] = useState<SkinId>('full');
  useEffect(() => {
    Promise.all([ensureLoaded(), loadSkin()]).then(([ok, s]) => {
      setSkinState(s);
      setState(ok ? 'in' : 'out');
    });
  }, []);
  if (state === 'in') return <Redirect href={SKINS[skin].root} />;
  // A locked skin with no circles yet (or none left): straight to joining.
  if (state === 'out') return <Redirect href={SKINS[skin].locked ? '/join' : '/welcome'} />;
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: t.bg }}>
      <ActivityIndicator color={t.brand} />
    </View>
  );
}
