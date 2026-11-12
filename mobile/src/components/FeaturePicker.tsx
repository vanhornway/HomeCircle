import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { FEATURE_GROUPS, FEATURES, type FeatureId, type FeatureInfo, type Features } from '@homecircle/core';
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
          <Text style={{ color: t.muted, fontSize: 14 }}>
            {on} of {FEATURES.length} on · {open ? 'tap to hide' : 'choose what this circle has'}
          </Text>
        </View>
        <Text style={{ color: t.muted, fontSize: 18 }}>{open ? '▴' : '▾'}</Text>
      </Pressable>
      {open ? <FeaturePicker value={value} onChange={onChange} /> : null}
      <Text style={{ color: t.muted, fontSize: 14, marginHorizontal: 4 }}>You can change these any time in Settings → Features.</Text>
    </View>
  );
}

const label = (id: FeatureId) => FEATURES.find((f) => f.id === id)?.label ?? id;

// A picture for each plugin, so the list can be scanned at a glance.
const PLUGIN_EMOJI: Partial<Record<FeatureId, string>> = {
  weather: '⛅',
  air: '🌬️',
  prayer: '🕌',
  whatsapp: '📞',
  homeAssistant: '🏠',
  meshtastic: '📡',
};
const OPEN_KEY = 'homecircle.pluginsOpen';

/**
 * The plugins: one section that opens and closes, so a long list doesn't
 * bury the rest of the features. Closed, it says which are on; it remembers
 * whether you left it open. The order never changes as you switch them, so
 * nothing moves under your finger.
 */
function PluginsSection({
  plugins,
  value,
  onChange,
  readOnly,
  below,
}: {
  plugins: FeatureInfo[];
  value: Features;
  onChange: (next: Features) => void;
  readOnly: boolean;
  below?: (id: FeatureId) => ReactNode;
}) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    AsyncStorage.getItem(OPEN_KEY)
      .then((v: string | null) => v === '1' && setOpen(true))
      .catch(() => {});
  }, []);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    AsyncStorage.setItem(OPEN_KEY, next ? '1' : '0').catch(() => {});
  };
  const on = plugins.filter((p) => value[p.id]);
  const names = on.map((p) => p.label);
  const summary = on.length
    ? `${on.length} of ${plugins.length} on · ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3} more` : ''}`
    : `None on · ${plugins.length} to choose from`;
  return (
    <SettingsGroup title="Plugins" footer={open ? 'Plugins add to what HomeCircle does. Each is off until an admin turns it on, and can be turned off again any time.' : undefined}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Plugins, ${on.length} of ${plugins.length} on`}
        accessibilityHint={open ? 'Hides the plugins' : 'Shows the plugins'}
        accessibilityState={{ expanded: open }}
        onPress={toggle}
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: pressed ? t.surface2 : 'transparent' })}
      >
        <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: t.brandSoft, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 18 }}>🧩</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>{open ? 'Plugins' : 'Choose plugins'}</Text>
          <Text style={{ color: t.muted, fontSize: 14, marginTop: 1 }} numberOfLines={2}>
            {summary}
          </Text>
        </View>
        <Text style={{ color: t.muted, fontSize: 18 }}>{open ? '▴' : '▾'}</Text>
      </Pressable>
      {open
        ? plugins.flatMap((f) => {
            const blocked = f.needs && !value[f.needs];
            return [
              <ToggleRow
                key={f.id}
                title={`${PLUGIN_EMOJI[f.id] ?? '🧩'}  ${f.label}`}
                detail={blocked && value[f.id] ? `${f.detail} Works once ${label(f.needs!)} is on.` : f.detail}
                value={value[f.id]}
                disabled={readOnly}
                onChange={(v) => onChange({ ...value, [f.id]: v })}
              />,
              (value[f.id] && below?.(f.id)) || null,
            ];
          })
        : []}
    </SettingsGroup>
  );
}

/**
 * Every feature a circle can have, by group, with a switch each. Used when
 * making a circle and in Settings → Features; read-only for non-admins.
 */
export function FeaturePicker({
  value,
  onChange,
  readOnly = false,
  below,
}: {
  value: Features;
  onChange: (next: Features) => void;
  readOnly?: boolean;
  // Shown under a feature's switch while it's on (a plugin's settings).
  below?: (id: FeatureId) => ReactNode;
}) {
  // Only what this server knows (an older one has no plugins).
  const shown = FEATURES.filter((f) => f.id in value);
  return (
    <>
      {FEATURE_GROUPS.filter((group) => shown.some((f) => f.group === group)).map((group) =>
        group === 'Plugins' ? (
          <PluginsSection key={group} plugins={shown.filter((f) => f.group === group)} value={value} onChange={onChange} readOnly={readOnly} below={below} />
        ) : (
        <SettingsGroup key={group} title={group}>
          {shown.filter((f) => f.group === group).map((f) => {
            const blocked = f.needs && !value[f.needs];
            return [
              <ToggleRow
                key={f.id}
                title={f.label}
                detail={blocked && value[f.id] ? `${f.detail} Works once ${label(f.needs!)} is on.` : f.detail}
                value={value[f.id]}
                disabled={readOnly}
                onChange={(on) => onChange({ ...value, [f.id]: on })}
              />,
              (value[f.id] && below?.(f.id)) || null,
            ];
          })}
        </SettingsGroup>
        ),
      )}
    </>
  );
}
