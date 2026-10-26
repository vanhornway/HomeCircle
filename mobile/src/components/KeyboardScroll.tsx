import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';

/**
 * A page that scrolls, and keeps the field you're typing in above the
 * keyboard (Android draws apps edge to edge, so the screen no longer shrinks
 * for the keyboard by itself).
 */
export function KeyboardScroll({ children, style, contentContainerStyle }: { children: ReactNode; style?: StyleProp<ViewStyle>; contentContainerStyle?: StyleProp<ViewStyle> }) {
  return (
    <KeyboardAwareScrollView style={[{ flex: 1 }, style]} contentContainerStyle={contentContainerStyle} keyboardShouldPersistTaps="handled" bottomOffset={24}>
      {children}
    </KeyboardAwareScrollView>
  );
}
