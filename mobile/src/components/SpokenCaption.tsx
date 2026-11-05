import { useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { onSpokenLine, spokenLine } from '../companion/lines';
import { C, URDU } from '../companion/theme';

/** What her phone is saying, written large at the top of her screen. Touches go through it: it never gets between her and SOS. */
export function SpokenCaption() {
  const line = useSyncExternalStore(onSpokenLine, spokenLine);
  const inset = useSafeAreaInsets();
  if (!line) return null;
  return (
    <View
      pointerEvents="none"
      accessibilityLiveRegion="polite"
      style={{ position: 'absolute', left: 12, right: 12, top: inset.top + 12, paddingHorizontal: 20, paddingVertical: 12, borderRadius: 20, borderWidth: 3, borderColor: C.green, backgroundColor: C.white }}
    >
      <Text style={[URDU, { color: C.ink, fontSize: 26, lineHeight: 58 }]}>{line}</Text>
    </View>
  );
}
