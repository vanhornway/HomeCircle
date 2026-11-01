import { View } from 'react-native';
import { Icon } from './ui';
import { useTheme } from '../theme';

/** The circle's helper: a bird on the brand colour, so it never looks like a person. */
export function HelperAvatar({ size = 44 }: { size?: number }) {
  const t = useTheme();
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: t.brandSoft, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name="bird" color={t.brand} size={Math.round(size * 0.55)} />
    </View>
  );
}
