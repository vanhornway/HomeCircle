import { Pressable, Text, View } from 'react-native';
import { STOP_NAMES, type Stop } from '../lib/locationPolicy';
import { useTheme } from '../theme';

const STOPS: Stop[] = [1, 2, 3, 4, 5, 6];

/**
 * Six stops on a line, from longest battery (left) to most up to date
 * (right). Tap a stop; with a screen reader, swipe up or down. `value` null
 * (custom values) shows no stop picked.
 */
export function StopSlider({ value, onChange }: { value: Stop | null; onChange: (s: Stop) => void }) {
  const t = useTheme();
  const at = value ?? null;
  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Location updates"
      accessibilityValue={{ text: at ? STOP_NAMES[at] : 'Custom' }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => {
        const from = at ?? 4;
        if (e.nativeEvent.actionName === 'increment' && from < 6) onChange((from + 1) as Stop);
        if (e.nativeEvent.actionName === 'decrement' && from > 1) onChange((from - 1) as Stop);
      }}
      style={{ gap: 6 }}
    >
      <View style={{ height: 44, justifyContent: 'center' }}>
        {/* The line, filled up to the stop picked. */}
        <View style={{ position: 'absolute', left: 14, right: 14, height: 4, borderRadius: 2, backgroundColor: t.line }}>
          {at ? <View style={{ width: `${((at - 1) / 5) * 100}%`, height: 4, borderRadius: 2, backgroundColor: t.brand }} /> : null}
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          {STOPS.map((s) => {
            const on = s === at;
            return (
              <Pressable key={s} onPress={() => onChange(s)} hitSlop={10} importantForAccessibility="no" style={{ width: 28, height: 44, alignItems: 'center', justifyContent: 'center' }}>
                <View
                  style={{
                    width: on ? 26 : 14,
                    height: on ? 26 : 14,
                    borderRadius: 13,
                    backgroundColor: at && s <= at ? t.brand : t.surface,
                    borderWidth: 2,
                    borderColor: at && s <= at ? t.brand : t.line,
                  }}
                />
              </Pressable>
            );
          })}
        </View>
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ color: t.muted, fontSize: 12 }}>Longest battery</Text>
        <Text style={{ color: t.muted, fontSize: 12 }}>Most up to date</Text>
      </View>
    </View>
  );
}
