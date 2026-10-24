import { Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { APP_VERSION, downloadUpdate, hideUpdateBanner, useAvailableUpdate } from '../lib/updates';
import { useTheme } from '../theme';

/** A newer HomeCircle is out: tap to download it. × hides it for a day. */
export function UpdateBanner({ style }: { style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  const version = useAvailableUpdate();
  if (!version) return null;
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', backgroundColor: t.brandSoft, borderColor: t.brand, borderWidth: 1, borderRadius: 14 }, style]}>
      <Pressable accessibilityRole="button" onPress={() => downloadUpdate()} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12 }}>
        <Text style={{ fontSize: 18 }}>⬆️</Text>
        <View style={{ flex: 1 }}>
          <Text style={{ color: t.text, fontWeight: '700', fontSize: 15 }}>HomeCircle {version} is out</Text>
          <Text style={{ color: t.muted, fontSize: 13 }}>You have {APP_VERSION}. Tap to download it, then tap Install.</Text>
        </View>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Hide for a day" onPress={() => hideUpdateBanner()} hitSlop={6} style={{ width: 44, height: 48, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: t.muted, fontSize: 22 }}>×</Text>
      </Pressable>
    </View>
  );
}
