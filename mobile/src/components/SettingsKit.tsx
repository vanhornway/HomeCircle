import React from 'react';
import { Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { router, Stack, type Href } from 'expo-router';
import { useTheme } from '../theme';

/** A settings page under its own header: scrolls, with the app's padding. */
export function SettingsPage({ title, children }: { title: string; children: React.ReactNode }) {
  const t = useTheme();
  return (
    <>
      <Stack.Screen options={{ headerShown: true, title }} />
      <ScrollView style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ padding: 20, paddingTop: 4, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
    </>
  );
}

/** Rows that belong together, in one rounded card. */
export function SettingsGroup({ title, children, footer }: { title?: string; children: React.ReactNode; footer?: string }) {
  const t = useTheme();
  const rows = React.Children.toArray(children).filter(Boolean);
  return (
    <View style={{ marginTop: 22 }}>
      {title ? <Text style={{ fontSize: 13, fontWeight: '600', color: t.muted, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8, marginLeft: 4 }}>{title}</Text> : null}
      <View style={{ backgroundColor: t.surface, borderRadius: 16, borderWidth: 1, borderColor: t.line, overflow: 'hidden' }}>
        {rows.map((row, i) => (
          <View key={i} style={i ? { borderTopWidth: 1, borderTopColor: t.line } : null}>
            {row}
          </View>
        ))}
      </View>
      {footer ? <Text style={{ color: t.muted, fontSize: 13, lineHeight: 18, marginTop: 8, marginHorizontal: 4 }}>{footer}</Text> : null}
    </View>
  );
}

/** A row that opens another page: icon, title, a one-line summary, and a chevron. */
export function SettingsRow({ icon, title, detail, href, onPress, badge }: { icon: string; title: string; detail?: string; href?: Href; onPress?: () => void; badge?: string | null }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={detail ? `${title}. ${detail}` : title}
      onPress={onPress ?? (() => href && router.push(href))}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 60, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: pressed ? t.surface2 : 'transparent' })}
    >
      <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: t.brandSoft, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ fontSize: 18 }}>{icon}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }} numberOfLines={1}>
          {title}
        </Text>
        {detail ? (
          <Text style={{ color: t.muted, fontSize: 13, marginTop: 1 }} numberOfLines={2}>
            {detail}
          </Text>
        ) : null}
      </View>
      {badge ? (
        <Text style={{ color: t.brandInk, backgroundColor: t.danger, fontSize: 12, fontWeight: '700', paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, overflow: 'hidden' }}>{badge}</Text>
      ) : null}
      <Text style={{ color: t.muted, fontSize: 22, marginLeft: 2 }}>›</Text>
    </Pressable>
  );
}

/** A row with a switch: title, what it means right now, and the switch. */
export function ToggleRow({
  title,
  detail,
  value,
  onChange,
  danger,
  disabled,
}: {
  title: string;
  detail?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 60, paddingHorizontal: 14, paddingVertical: 10, opacity: disabled ? 0.6 : 1 }}>
      <View style={{ flex: 1 }}>
        <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>{title}</Text>
        {detail ? <Text style={{ color: t.muted, fontSize: 13, marginTop: 2, lineHeight: 18 }}>{detail}</Text> : null}
      </View>
      <Switch accessibilityLabel={title} value={value} onValueChange={onChange} disabled={disabled} trackColor={{ true: danger ? t.danger : t.brand }} />
    </View>
  );
}

/** Padding for free-form content inside a group. */
export function GroupBody({ children, gap = 10 }: { children: React.ReactNode; gap?: number }) {
  return <View style={{ padding: 14, gap }}>{children}</View>;
}
