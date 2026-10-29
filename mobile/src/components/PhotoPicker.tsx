import { useState } from 'react';
import { ActivityIndicator, Alert, View } from 'react-native';
import { Button } from './ui';
import { errorText } from '../lib/circle';
import { pickSquarePhoto } from '../lib/photos';
import { useTheme } from '../theme';

/** Take a photo, choose one, or remove it. `onPhoto` gets square JPEG bytes, or null to remove. */
export function PhotoButtons({ has, onPhoto }: { has: boolean; onPhoto: (bytes: Uint8Array | null) => Promise<unknown> }) {
  const t = useTheme();
  const [busy, setBusy] = useState(false);
  const run = (fn: () => Promise<Uint8Array | null | 'remove'>) => {
    setBusy(true);
    fn()
      .then((r) => (r === 'remove' ? onPhoto(null) : r ? onPhoto(r) : undefined))
      .catch((e) => Alert.alert('Couldn’t save the photo', errorText(e)))
      .finally(() => setBusy(false));
  };
  if (busy) return <ActivityIndicator color={t.brand} style={{ marginVertical: 8 }} />;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      <Button small title="Take a photo" onPress={() => run(() => pickSquarePhoto('camera'))} />
      <Button small title="Choose from photos" onPress={() => run(() => pickSquarePhoto('library'))} />
      {has ? <Button small variant="danger" title="Remove" onPress={() => run(async () => 'remove')} /> : null}
    </View>
  );
}
