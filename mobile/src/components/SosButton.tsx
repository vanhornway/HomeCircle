import { useRef, useState } from 'react';
import { Animated, Easing, Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { router } from 'expo-router';
import { useMySos } from '../lib/sos';
import { useTheme } from '../theme';

const HOLD_MS = 2000;
const SIZE = 64;

/**
 * Hold for 2 seconds to start an SOS (a short tap does nothing, so it can't
 * go off in a pocket); a ring fills while you hold. While an SOS is on, it
 * opens the SOS screen instead.
 */
export function SosButton({ style }: { style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  const sos = useMySos();
  const [fill] = useState(() => new Animated.Value(0));
  const [hint, setHint] = useState(false);
  const run = useRef<Animated.CompositeAnimation | null>(null);
  const held = useRef(false);

  const press = () => {
    if (sos) return router.navigate('/sos');
    setHint(false);
    held.current = false;
    run.current = Animated.timing(fill, { toValue: 1, duration: HOLD_MS, easing: Easing.linear, useNativeDriver: false });
    run.current.start(({ finished }) => {
      if (!finished) return;
      held.current = true;
      fill.setValue(0);
      router.push({ pathname: '/sos', params: { countdown: '1' } });
    });
  };
  const release = () => {
    if (sos) return;
    run.current?.stop();
    // Let go early: say how it works.
    if (!held.current) setHint(true);
    Animated.timing(fill, { toValue: 0, duration: 150, useNativeDriver: false }).start();
  };

  return (
    <View style={[{ alignItems: 'flex-end', gap: 6 }, style]} pointerEvents="box-none">
      {hint ? (
        <Text style={{ backgroundColor: t.surface, color: t.text, fontSize: 13, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, overflow: 'hidden' }}>Hold for 2 seconds to send an SOS</Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={sos ? 'SOS is on. Open it' : 'SOS. Hold for 2 seconds'}
        onPressIn={press}
        onPressOut={release}
        style={{
          width: SIZE,
          height: SIZE,
          borderRadius: SIZE / 2,
          backgroundColor: t.danger,
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          borderWidth: sos ? 4 : 0,
          borderColor: t.surface,
          shadowColor: '#000',
          shadowOpacity: 0.2,
          shadowRadius: 8,
          elevation: 5,
        }}
      >
        {/* Fills from the bottom while held. */}
        <Animated.View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.28)',
            height: fill.interpolate({ inputRange: [0, 1], outputRange: [0, SIZE] }),
          }}
        />
        <Text style={{ color: '#fff', fontSize: 18, fontWeight: '800', letterSpacing: 1 }}>SOS</Text>
      </Pressable>
    </View>
  );
}
