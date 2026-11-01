import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { router, type NativeStackHeaderProps } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';

/** The "‹" back button: a 48pt target, the same on every page. */
export function BackButton({ onPress }: { onPress?: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress ?? (() => (router.canGoBack() ? router.back() : router.replace('/')))}
      accessibilityRole="button"
      accessibilityLabel="Back"
      hitSlop={8}
      style={({ pressed }) => ({ width: 48, height: 48, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}
    >
      <Text allowFontScaling={false} style={{ color: t.brand, fontSize: 34, lineHeight: 36, marginTop: -4 }}>
        ‹
      </Text>
    </Pressable>
  );
}

/**
 * The one header: "‹", a title (and a line under it), and room on the right.
 * Stack pages get it through `StackHeader`; the conversation puts its own
 * content (avatar, call button) in `children` in place of the title.
 */
export function HeaderBar({
  title,
  subtitle,
  onBack,
  back = true,
  right,
  children,
}: {
  title?: string;
  subtitle?: string;
  onBack?: () => void;
  back?: boolean;
  right?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minHeight: 64,
        paddingTop: insets.top + 8,
        paddingBottom: 8,
        paddingLeft: back ? 6 : 20,
        paddingRight: 10,
        backgroundColor: t.bg,
        borderBottomWidth: 1,
        borderBottomColor: t.line,
      }}
    >
      {back ? <BackButton onPress={onBack} /> : null}
      {children ?? (
        <View style={{ flex: 1 }}>
          <Text accessibilityRole="header" style={{ color: t.text, fontSize: 19, fontWeight: '700' }} numberOfLines={2}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={{ color: t.muted, fontSize: 14 }} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
      )}
      {right}
    </View>
  );
}

/** The Stack's `header` option: pages that show a header (`headerShown: true`) get this one. */
export function StackHeader({ navigation, options, back }: NativeStackHeaderProps) {
  const title = typeof options.headerTitle === 'string' ? options.headerTitle : options.title;
  return <HeaderBar title={title} back={!!back || navigation.canGoBack()} onBack={() => navigation.goBack()} />;
}
