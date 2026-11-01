import type { ReactNode } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent, StyleProp, ViewStyle } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';

/**
 * A page that scrolls, and keeps the field you're typing in above the
 * keyboard (Android draws apps edge to edge, so the screen no longer shrinks
 * for the keyboard by itself).
 */
export function KeyboardScroll({
  children,
  style,
  contentContainerStyle,
  onScroll,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  onScroll?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
}) {
  return (
    <KeyboardAwareScrollView style={[{ flex: 1 }, style]} contentContainerStyle={contentContainerStyle} keyboardShouldPersistTaps="handled" bottomOffset={24} onScroll={onScroll} scrollEventThrottle={64}>
      {children}
    </KeyboardAwareScrollView>
  );
}
