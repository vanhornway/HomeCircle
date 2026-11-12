import { Pressable, Text, View } from 'react-native';
import { useTheme } from '../theme';

/** Small choice pills: one of a few values (a radio group). */
export function Pills<T extends string | number>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }} accessibilityRole="radiogroup">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={String(o.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected: on, disabled }}
            disabled={disabled}
            onPress={() => onChange(o.value)}
            style={{ minHeight: 44, paddingHorizontal: 14, borderRadius: 22, justifyContent: 'center', backgroundColor: on ? t.brand : t.surface2, opacity: disabled && !on ? 0.5 : 1 }}
          >
            <Text style={{ color: on ? t.brandInk : t.text, fontSize: 15, fontWeight: '600' }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
