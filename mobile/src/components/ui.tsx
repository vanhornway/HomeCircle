import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type PressableProps,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
  type ColorValue,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle, G, Path, Rect } from 'react-native-svg';
import { useTheme } from '../theme';
import { initials } from '../lib/useCircle';

export function Screen({
  children,
  scroll = true,
  style,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  return (
    <SafeAreaView style={[{ flex: 1, backgroundColor: t.bg }, style]} edges={['top', 'left', 'right']}>
      {scroll ? (
        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      ) : (
        children
      )}
    </SafeAreaView>
  );
}

export function H1({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  const t = useTheme();
  return <Text style={[{ fontSize: 28, fontWeight: '700', color: t.text, letterSpacing: -0.3 }, style]}>{children}</Text>;
}

export function P({ children, muted, style }: { children: React.ReactNode; muted?: boolean; style?: StyleProp<TextStyle> }) {
  const t = useTheme();
  return <Text style={[{ fontSize: 16, lineHeight: 23, color: muted ? t.muted : t.text }, style]}>{children}</Text>;
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return (
    <Text style={{ fontSize: 13, fontWeight: '600', color: t.muted, textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 26, marginBottom: 10 }}>
      {children}
    </Text>
  );
}

export function Button({
  title,
  onPress,
  variant = 'default',
  loading,
  disabled,
  small,
  style,
  ...rest
}: {
  title: string;
  variant?: 'primary' | 'default' | 'danger' | 'ghost';
  loading?: boolean;
  small?: boolean;
  style?: StyleProp<ViewStyle>;
} & Omit<PressableProps, 'style'>) {
  const t = useTheme();
  const bg = variant === 'primary' ? t.brand : variant === 'ghost' ? 'transparent' : t.surface;
  const fg = variant === 'primary' ? t.brandInk : variant === 'danger' ? t.danger : variant === 'ghost' ? t.brand : t.text;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        {
          backgroundColor: bg,
          borderColor: variant === 'primary' ? t.brand : variant === 'ghost' ? 'transparent' : t.line,
          borderWidth: 1,
          // Comfortable touch targets: 44pt+ even for small buttons.
          borderRadius: small ? 12 : 16,
          minHeight: small ? 44 : 56,
          paddingHorizontal: small ? 16 : 20,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        },
        style,
      ]}
      {...rest}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={{ color: fg, fontWeight: '600', fontSize: small ? 15 : 17 }}>{title}</Text>
      )}
    </Pressable>
  );
}

export function Field({ label, style, ...props }: { label: string } & TextInputProps) {
  const t = useTheme();
  return (
    <View style={{ marginBottom: 16 }}>
      <Text style={{ fontSize: 13, fontWeight: '600', color: t.muted, marginBottom: 6 }}>{label}</Text>
      <TextInput
        placeholderTextColor={t.muted}
        style={[
          {
            backgroundColor: t.surface,
            borderColor: t.line,
            borderWidth: 1,
            borderRadius: 12,
            paddingHorizontal: 14,
            minHeight: 54,
            fontSize: 17,
            color: t.text,
          },
          style,
        ]}
        {...props}
      />
    </View>
  );
}

export function ErrorText({ children }: { children?: string | null }) {
  const t = useTheme();
  if (!children) return null;
  return <Text style={{ color: t.danger, fontSize: 15, marginTop: 10 }}>{children}</Text>;
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return (
    <View style={[{ backgroundColor: t.surface, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: t.line, padding: 16 }, style]}>
      {children}
    </View>
  );
}

export function LockNote({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: 10, backgroundColor: t.brandSoft, borderRadius: 14, padding: 14, marginTop: 18 }}>
      <Icon name="lock" color={t.brand} size={18} />
      <Text style={{ flex: 1, color: t.text, fontSize: 14, lineHeight: 20 }}>{children}</Text>
    </View>
  );
}

/** A labelled checkbox row with a large touch target. */
export function Checkbox({ checked, onChange, label, detail }: { checked: boolean; onChange: (v: boolean) => void; label: string; detail?: string }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      onPress={() => onChange(!checked)}
      style={({ pressed }) => ({ flexDirection: 'row', gap: 12, alignItems: 'flex-start', paddingVertical: 8, opacity: pressed ? 0.7 : 1 })}
    >
      <View
        style={{
          width: 28,
          height: 28,
          borderRadius: 8,
          borderWidth: 2,
          borderColor: checked ? t.brand : t.muted,
          backgroundColor: checked ? t.brand : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: 1,
        }}
      >
        {checked ? <Text style={{ color: t.brandInk, fontWeight: '800', fontSize: 16 }}>✓</Text> : null}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>{label}</Text>
        {detail ? <Text style={{ color: t.muted, fontSize: 14, marginTop: 2, lineHeight: 19 }}>{detail}</Text> : null}
      </View>
    </Pressable>
  );
}

export function Avatar({ name, color, size = 44 }: { name: string; color: string; size?: number }) {
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: '#fff', fontWeight: '700', fontSize: size * 0.38 }}>{initials(name)}</Text>
    </View>
  );
}

export function Tag({ label, warn }: { label: string; warn?: boolean }) {
  const t = useTheme();
  return (
    <View style={{ backgroundColor: warn ? t.warnBg : t.surface2, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 }}>
      <Text style={{ fontSize: 11, fontWeight: '700', color: warn ? t.warnText : t.muted }}>{label}</Text>
    </View>
  );
}

export function Logo({ size = 56 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Rect width={64} height={64} rx={16} fill="#2F7D6D" />
      <Circle cx={32} cy={32} r={17} fill="none" stroke="#F6EFE4" strokeWidth={5} />
      <Path d="M32 21l9 8v11H23V29z" fill="#F6EFE4" />
      <Circle cx={32} cy={15} r={4} fill="#F2B84B" />
    </Svg>
  );
}

const ICONS: Record<string, string> = {
  map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Zm0 0v14m6-12v14',
  chat: 'M4 5h16v11H9l-5 4V5Z',
  place: 'M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21Zm0-9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.3l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2.2-1.3L14.3 3h-4l-.4 2.4a7.6 7.6 0 0 0-2.2 1.3l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.6l-2 1.6 2 3.4 2.4-1c.7.6 1.4 1 2.2 1.3l.4 2.4h4l.4-2.4c.8-.3 1.5-.7 2.2-1.3l2.4 1 2-3.4-2-1.6c.1-.4.1-.9.1-1.3Z',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6v-9Z',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  plus: 'M12 5v14M5 12h14',
  qr: 'M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h2v2h-2v-2Zm4 0h2v2h-2v-2Zm-4 4h2v2h-2v-2Zm4 0h2v2h-2v-2Z',
  send: 'M4 12 20 4l-6 16-3-7-7-1Z',
  locate: 'M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12Zm0-3.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  navigate: 'M3.5 10.5 20.5 3.5l-7 17-2.2-7.8-7.8-2.2Z',
  bell: 'M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 1.5h-15L6 16.5Zm4 3.5a2 2 0 0 0 4 0',
  checkin: 'M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21Zm-3-11.5 2 2 4-4',
  bird: 'M3.5 15.5c4.5.5 7-2 8-5.5.8-2.8 2.7-4.5 5.3-4.5l3.7 1.3-3.2 1.2v1.5c0 5-3.8 8.5-8.8 8.5H6l-2.5-2.5ZM16.5 7.6h.01M11 20.5l1.5-3',
};

/** A round icon-only button with a 44pt touch target. */
export function IconButton({
  icon,
  label,
  onPress,
  disabled,
  busy,
  done,
  primary,
  size = 44,
}: {
  icon: string;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  done?: boolean;
  primary?: boolean;
  size?: number;
}) {
  const t = useTheme();
  const fg = primary ? t.brandInk : t.brand;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      disabled={disabled || busy}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: primary ? t.brand : t.line,
        backgroundColor: primary ? t.brand : done ? t.brandSoft : t.surface,
        opacity: disabled ? 0.45 : pressed ? 0.75 : 1,
      })}
    >
      {busy ? (
        <ActivityIndicator size="small" color={fg} />
      ) : done ? (
        <Text style={{ color: t.brand, fontSize: 18, fontWeight: '800' }}>✓</Text>
      ) : (
        <Icon name={icon} color={fg} bg={primary ? t.brand : t.surface} size={Math.round(size * (icon === 'birds' ? 0.68 : 0.5))} />
      )}
    </Pressable>
  );
}

export function Icon({ name, size = 24, color = '#000', bg }: { name: keyof typeof ICONS | 'birds' | string; size?: number; color?: ColorValue; bg?: ColorValue }) {
  if (name === 'birds') return <Flock size={size} color={color} bg={bg} />;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d={ICONS[name] || ICONS.place} stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

// Chirp everyone: three of the chirp bird close together (one bird chirps one person).
const FLOCK: [number, number, number][] = [
  [5.6, -2.2, 0.6],
  [-2.2, 7.2, 0.6],
  [9, 8.2, 0.6],
];

function Flock({ size, color, bg }: { size: number; color: ColorValue; bg?: ColorValue }) {
  const t = useTheme();
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {FLOCK.map(([x, y, s], i) => (
        <G key={i} transform={`translate(${x} ${y}) scale(${s})`}>
          {/* Filled with the background so the front birds cover the one behind. */}
          <Path d={ICONS.bird} fill={bg ?? t.surface} stroke={color} strokeWidth={1.2 / s} strokeLinecap="round" strokeLinejoin="round" />
        </G>
      ))}
    </Svg>
  );
}
