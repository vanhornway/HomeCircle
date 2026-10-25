import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { FEATURE_GROUPS, FEATURES, type FeatureId, type Features } from '@homecircle/core';
import { useTheme } from '../theme';
import { SettingsGroup, ToggleRow } from './SettingsKit';

/** When making a circle: how many features it will have, opening the full list to choose. */
export function FeatureChooser({ value, onChange }: { value: Features; onChange: (next: Features) => void }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const on = FEATURES.filter((f) => value[f.id]).length;
  return (
    <View style={{ gap: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((v) => !v)}
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: t.line, backgroundColor: pressed ? t.surface2 : t.surface })}
      >
        <Text style={{ fontSize: 20 }}>🧩</Text>
        <View style={{ flex: 1 }}>
          <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>Features</Text>
          <Text style={{ color: t.muted, fontSize: 13 }}>
            {on} of {FEATURES.length} on · {open ? 'tap to hide' : 'choose what this circle has'}
          </Text>
        </View>
        <Text style={{ color: t.muted, fontSize: 18 }}>{open ? '▴' : '▾'}</Text>
      </Pressable>
      {open ? <FeaturePicker value={value} onChange={onChange} /> : null}
      <Text style={{ color: t.muted, fontSize: 13, marginHorizontal: 4 }}>You can change these any time in Settings → Features.</Text>
    </View>
  );
}

const label = (id: FeatureId) => FEATURES.find((f) => f.id === id)?.label ?? id;

/**
 * Every feature a circle can have, by group, with a switch each. Used when
 * making a circle and in Settings → Features; read-only for non-admins.
 */
export function FeaturePicker({ value, onChange, readOnly = false }: { value: Features; onChange: (next: Features) => void; readOnly?: boolean }) {
  return (
    <>
      {FEATURE_GROUPS.map((group) => (
        <SettingsGroup key={group} title={group}>
          {FEATURES.filter((f) => f.group === group).map((f) => {
            const blocked = f.needs && !value[f.needs];
            return (
              <ToggleRow
                key={f.id}
                title={f.label}
                detail={blocked && value[f.id] ? `${f.detail} Works once ${label(f.needs!)} is on.` : f.detail}
                value={value[f.id]}
                disabled={readOnly}
                onChange={(on) => onChange({ ...value, [f.id]: on })}
              />
            );
          })}
        </SettingsGroup>
      ))}
    </>
  );
}
