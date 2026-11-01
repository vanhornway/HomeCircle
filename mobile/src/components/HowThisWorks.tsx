import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Icon } from './ui';
import { useTheme } from '../theme';

/**
 * "How this works": a small link under a line of plain copy. It opens a bottom
 * sheet with the longer explanation (encryption, what the server learns, the
 * push service, limits, schedules). Give it text, or several strings for
 * several paragraphs.
 */
export function HowThisWorks({
  title = 'How this works',
  children,
  style,
}: {
  title?: string;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const body = React.Children.toArray(children).map((c, i) =>
    typeof c === 'string' || typeof c === 'number' ? (
      <Text key={i} style={{ color: t.text, fontSize: 15, lineHeight: 22 }}>
        {c}
      </Text>
    ) : (
      c
    ),
  );
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        onPress={() => setOpen(true)}
        hitSlop={6}
        style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', minHeight: 44, paddingHorizontal: 4, opacity: pressed ? 0.6 : 1 }, style]}
      >
        <Icon name="info" color={t.brand} size={16} />
        <Text style={{ color: t.brand, fontSize: 14, fontWeight: '600' }}>{title}</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <Pressable accessibilityLabel="Close" onPress={() => setOpen(false)} style={{ flex: 1, backgroundColor: t.scrim, justifyContent: 'flex-end' }}>
          <Pressable
            onPress={() => {}}
            style={{ backgroundColor: t.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 20, paddingTop: 10, paddingBottom: 28, maxHeight: '80%' }}
          >
            <View style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: t.line, marginBottom: 14 }} />
            <Text accessibilityRole="header" style={{ color: t.text, fontSize: 19, fontWeight: '700', marginBottom: 12 }}>
              {title}
            </Text>
            <ScrollView contentContainerStyle={{ gap: 12, paddingBottom: 8 }}>{body}</ScrollView>
            <Pressable
              accessibilityRole="button"
              onPress={() => setOpen(false)}
              style={({ pressed }) => ({ marginTop: 14, minHeight: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? t.surface2 : t.brandSoft })}
            >
              <Text style={{ color: t.brand, fontWeight: '700', fontSize: 16 }}>Got it</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
