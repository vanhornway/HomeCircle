import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  Pressable,
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
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle, G, Path, Rect } from 'react-native-svg';
import { useTheme } from '../theme';
import { KeyboardScroll } from './KeyboardScroll';
import { initials } from '../lib/useCircle';

export function Screen({
  children,
  scroll = true,
  style,
  add,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  style?: StyleProp<ViewStyle>;
  /** The page's one way to add something: a floating "+" (see AddButton). */
  add?: { label: string; hint?: string; onPress: () => void };
}) {
  const t = useTheme();
  const addScroll = useAddButtonScroll();
  return (
    <SafeAreaView style={[{ flex: 1, backgroundColor: t.bg }, style]} edges={['top', 'left', 'right']}>
      {scroll ? (
        // The field you're typing in stays above the keyboard.
        <KeyboardScroll onScroll={add ? addScroll.onScroll : undefined} contentContainerStyle={{ padding: 20, paddingBottom: add ? ADD_BUTTON_SPACE : 48 }}>
          {children}
        </KeyboardScroll>
      ) : (
        children
      )}
      {add ? <AddButton {...add} hidden={addScroll.hidden} /> : null}
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
    <Text style={{ fontSize: 14, fontWeight: '600', color: t.muted, textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 26, marginBottom: 10 }}>
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
      <Text style={{ fontSize: 14, fontWeight: '600', color: t.muted, marginBottom: 6 }}>{label}</Text>
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

/** What went wrong, in the page where it happened (for errors that block nothing). */
export function ErrorText({ children, onRetry }: { children?: string | null; onRetry?: () => void }) {
  const t = useTheme();
  if (!children) return null;
  return (
    <View style={{ marginTop: 10, gap: 8, alignItems: 'flex-start' }}>
      <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ color: t.danger, fontSize: 15, lineHeight: 21 }}>
        {children}
      </Text>
      {onRetry ? <Button small title="Try again" onPress={onRetry} /> : null}
    </View>
  );
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

/** Someone's photo (`uri`), else their initials on their colour. */
export function Avatar({ name, color, size = 44, uri }: { name: string; color: string; size?: number; uri?: string | null }) {
  if (uri) return <Image source={{ uri }} accessibilityLabel={name} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
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
      <Text style={{ fontSize: 14, fontWeight: '700', color: warn ? t.warnText : t.muted }}>{label}</Text>
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
  phone: 'M5 4h3.5l1.5 4-2 1.5a11 11 0 0 0 6.5 6.5l1.5-2 4 1.5V19a1.5 1.5 0 0 1-1.5 1.5A15.5 15.5 0 0 1 3.5 5.5 1.5 1.5 0 0 1 5 4Z',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-10v6m0-9.5h.01',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6.5 9a6.5 6.5 0 0 1 13 0M16 4.2a3.5 3.5 0 0 1 0 6.6M18 14.5a6.5 6.5 0 0 1 3.5 5.5',
  user: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7.5 9.5a7.5 7.5 0 0 1 15 0',
  grid: 'M4 4h7v7H4V4Zm9 0h7v7h-7V4ZM4 13h7v7H4v-7Zm9 0h7v7h-7v-7Z',
  home: 'M4 11 12 4l8 7v9h-5v-6H9v6H4v-9Z',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Zm7 12 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z',
  checkcircle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-4-9 3 3 5-6',
  pulse: 'M3 12h4l2.5-6 4 12 2.5-6H21',
  textsize: 'M3 19 8 6l5 13M4.8 15h6.4M15 19l2.8-7 2.8 7m-4.8-2h4',
  server: 'M4 4h16v6H4V4Zm0 10h16v6H4v-6Zm3-7h.01M7 17h.01',
  heart: 'M12 20s-7-4.6-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.4-7 10-7 10Z',
  clipboard: 'M9 4h6v3H9V4ZM7 5.5H5v15h14v-15h-2M9 12h6m-6 4h4',
  lists: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  bird: 'M3.5 15.5c4.5.5 7-2 8-5.5.8-2.8 2.7-4.5 5.3-4.5l3.7 1.3-3.2 1.2v1.5c0 5-3.8 8.5-8.8 8.5H6l-2.5-2.5ZM16.5 7.6h.01M11 20.5l1.5-3',
};

/** Whether `name` is one of the line icons (settings rows still pass an emoji now and then). */
export const hasIcon = (name: string) => name in ICONS || name === 'birds';

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

/** The inviter confirms the person is 13 or older: everyone with their own account must be. */
export function AgeConfirm({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: value }}
      onPress={() => onChange(!value)}
      style={{ flexDirection: 'row', gap: 12, alignItems: 'center', padding: 14, borderRadius: 14, borderWidth: 1, borderColor: value ? t.brand : t.line, backgroundColor: value ? t.brandSoft : t.surface, marginBottom: 16 }}
    >
      <View style={{ width: 26, height: 26, borderRadius: 7, borderWidth: 2, borderColor: value ? t.brand : t.muted, backgroundColor: value ? t.brand : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
        {value ? <Text style={{ color: t.brandInk, fontWeight: '800', fontSize: 15 }}>✓</Text> : null}
      </View>
      <Text style={{ flex: 1, color: t.text, fontSize: 15, lineHeight: 21 }}>They’re 13 or older. Younger children play on a parent’s phone.</Text>
    </Pressable>
  );
}

/**
 * Nothing here yet: an icon, one line, and (if there is something to do) one
 * button. Use it wherever a list can be empty.
 */
export function EmptyState({ icon, text, action, onAction }: { icon: string; text: string; action?: string; onAction?: () => void }) {
  const t = useTheme();
  return (
    <View style={{ alignItems: 'center', gap: 14, paddingHorizontal: 32, paddingVertical: 36 }}>
      <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: t.brandSoft, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} color={t.brand} size={30} />
      </View>
      <Text style={{ color: t.muted, fontSize: 16, lineHeight: 23, textAlign: 'center' }}>{text}</Text>
      {action && onAction ? <Button variant="primary" small title={action} onPress={onAction} /> : null}
    </View>
  );
}

/**
 * The one way to add to a list of things (a place, a reminder, a message):
 * a "+" with a word, bottom right, over the list. Quick-entry fields (an
 * item on a shopping list) stay inline in the list instead.
 */
export function AddButton({ label, hint, onPress, bottom = 24, hidden = false }: { label: string; hint?: string; onPress: () => void; bottom?: number; hidden?: boolean }) {
  const t = useTheme();
  // Slides off the bottom while the list scrolls down, so it doesn't sit on a row's own button.
  const [slide] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.timing(slide, { toValue: hidden ? 1 : 0, duration: 180, useNativeDriver: true }).start();
  }, [hidden, slide]);
  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [0, 56 + bottom + 24] });
  return (
    <Animated.View pointerEvents={hidden ? 'none' : 'box-none'} style={{ position: 'absolute', right: 16, bottom, transform: [{ translateY }] }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={hint ?? label}
        onPress={onPress}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          minHeight: 56,
          paddingLeft: 16,
          paddingRight: 20,
          borderRadius: 28,
          backgroundColor: t.brand,
          opacity: pressed ? 0.85 : 1,
          shadowColor: '#000',
          shadowOpacity: 0.2,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 3 },
          elevation: 5,
        })}
      >
        <Icon name="plus" color={t.brandInk} size={22} />
        <Text style={{ color: t.brandInk, fontSize: 16, fontWeight: '700' }}>{label}</Text>
      </Pressable>
    </Animated.View>
  );
}

/** Space to leave under a scrolling list so the add button never covers its last row. */
export const ADD_BUTTON_SPACE = 100;

/**
 * Hides the add button while a list scrolls down and brings it back on the
 * way up or at the end. Pass `onScroll` to the list and `hidden` to AddButton.
 */
export function useAddButtonScroll() {
  const [hidden, setHidden] = useState(false);
  const lastY = useRef(0);
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const y = contentOffset.y;
    const atEnd = y + layoutMeasurement.height >= contentSize.height - 24;
    if (atEnd || y < 40 || y < lastY.current - 8) setHidden(false);
    else if (y > lastY.current + 8) setHidden(true);
    lastY.current = y;
  };
  return { hidden, onScroll };
}
