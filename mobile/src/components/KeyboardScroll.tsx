import { useEffect, useRef, type ComponentRef, type ReactNode } from 'react';
import { Keyboard, KeyboardAvoidingView, ScrollView, TextInput, type StyleProp, type ViewStyle } from 'react-native';

/**
 * A page that scrolls, and keeps the field you're typing in above the
 * keyboard: the page makes room for the keyboard, then scrolls the focused
 * field into sight (Android doesn't do that part by itself).
 */
export function KeyboardScroll({ children, style, contentContainerStyle }: { children: ReactNode; style?: StyleProp<ViewStyle>; contentContainerStyle?: StyleProp<ViewStyle> }) {
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const offset = useRef(0);
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidShow', (e) => {
      const field = TextInput.State.currentlyFocusedInput() as unknown as { measureInWindow?: (cb: (x: number, y: number, w: number, h: number) => void) => void } | null;
      field?.measureInWindow?.((_x, y, _w, h) => {
        const below = y + h + 24 - e.endCoordinates.screenY;
        if (below > 0) scroll.current?.scrollTo({ y: offset.current + below, animated: true });
      });
    });
    return () => sub.remove();
  }, []);
  return (
    <KeyboardAvoidingView style={[{ flex: 1 }, style]} behavior="padding">
      <ScrollView
        ref={scroll}
        style={{ flex: 1 }}
        contentContainerStyle={contentContainerStyle}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={64}
        onScroll={(e) => {
          offset.current = e.nativeEvent.contentOffset.y;
        }}
      >
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
