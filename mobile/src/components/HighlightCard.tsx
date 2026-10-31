import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Icon } from './ui';
import { useChatFont } from '../lib/chatZoom';
import { useTheme } from '../theme';

/**
 * The chat's "look at this" card: a two-point border while it's open, a round
 * icon and a big title. The call-back request and the helper's reminders use
 * it, so the things that need someone to act look alike. Text follows the
 * chat's pinch zoom.
 */
export function HighlightCard({
  icon,
  title,
  open,
  danger = false,
  onPress,
  onLongPress,
  label,
  hint,
  children,
}: {
  icon: string;
  title: string;
  /** Still waiting on someone: brand border and a filled icon (else quiet). */
  open: boolean;
  /** Late: the border and icon turn to the danger colour instead. */
  danger?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  label: string;
  hint?: string;
  children?: ReactNode;
}) {
  const t = useTheme();
  const fs = useChatFont();
  const accent = open && danger ? t.danger : t.brand;
  return (
    <Pressable
      onLongPress={onLongPress}
      onPress={onPress}
      delayLongPress={300}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      style={({ pressed }) => ({ gap: 10, padding: 14, borderRadius: 18, backgroundColor: t.surface, borderWidth: 2, borderColor: open ? accent : t.line, opacity: pressed ? 0.8 : 1 })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: open ? accent : t.surface2, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={icon} color={open ? t.brandInk : t.brand} size={22} />
        </View>
        <Text style={{ flex: 1, color: t.text, fontSize: fs(18), fontWeight: '700', lineHeight: fs(22) }}>{title}</Text>
      </View>
      {children}
    </Pressable>
  );
}
