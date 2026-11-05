import { Pressable, Text, View } from 'react-native';
import type { CircleClient } from '@homecircle/core';
import { useTheme } from '../theme';

/** Everyone who can be tagged: the circle's people, never its helper. */
export const circlePeople = (client: CircleClient) => client.memberList().filter((m) => m.kind !== 'agent' && !m.removed);

/** One chip per person; a tap tags or untags them. */
export function PeopleChips({ people, selected, onToggle }: { people: { key: string; label: string }[]; selected: string[]; onToggle: (key: string) => void }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {people.map((p) => {
        const on = selected.includes(p.key);
        return (
          <Pressable
            key={p.key}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on }}
            accessibilityLabel={p.label}
            onPress={() => onToggle(p.key)}
            style={{ minHeight: 44, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 999, borderWidth: 1, borderColor: on ? t.brand : t.line, backgroundColor: on ? t.brandSoft : t.surface }}
          >
            <Text style={{ color: on ? t.brand : t.text, fontWeight: '600', fontSize: 15 }}>
              {on ? '✓ ' : ''}
              {p.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** One of a few choices, each a full-width row. */
export function Choice<T extends string>({ options, value, onPick }: { options: { id: T; label: string }[]; value: T; onPick: (id: T) => void }) {
  const t = useTheme();
  return (
    <View style={{ gap: 6 }}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <Pressable
            key={o.id}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            onPress={() => onPick(o.id)}
            style={{ minHeight: 48, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: on ? t.brand : t.line, backgroundColor: on ? t.brandSoft : t.surface }}
          >
            <Text style={{ color: on ? t.brand : t.text, fontWeight: '600', fontSize: 15 }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
