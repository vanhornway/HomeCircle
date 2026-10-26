import { useEffect, useState, type ReactNode } from 'react';
import { Animated, PanResponder, Pressable, View } from 'react-native';
import { useTheme } from '../theme';

// Open or closed, while the app is open (it comes back the way you left it).
const kept = { open: true };

/** The drawer's height, dragged or snapped open and closed (made once per drawer). */
class DrawerMotion {
  height: Animated.Value;
  private closedH: number;
  private openH: number;
  private startH = 0;
  private now: number;
  constructor(
    closedH: number,
    openH: number,
    private onOpen: (open: boolean) => void,
  ) {
    this.closedH = closedH;
    this.openH = openH;
    this.now = kept.open ? openH : closedH;
    this.height = new Animated.Value(this.now);
    this.height.addListener(({ value }) => (this.now = value));
  }
  pan = PanResponder.create({
    // A drag up or down on the handle; a tap is left to the button.
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 6 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderGrant: () => {
      this.startH = this.now;
    },
    onPanResponderMove: (_, g) => this.height.setValue(Math.max(this.closedH, Math.min(this.openH, this.startH - g.dy))),
    onPanResponderRelease: (_, g) => {
      const mid = (this.closedH + this.openH) / 2;
      this.snap(g.vy < -0.4 ? true : g.vy > 0.4 ? false : this.now > mid);
    },
    onPanResponderTerminate: () => this.snap(this.now > (this.closedH + this.openH) / 2),
  });
  sizes(closedH: number, openH: number) {
    const wasOpen = kept.open;
    this.closedH = closedH;
    this.openH = openH;
    this.height.setValue(wasOpen ? openH : closedH);
  }
  snap(open: boolean) {
    kept.open = open;
    this.onOpen(open);
    Animated.spring(this.height, { toValue: open ? this.openH : this.closedH, useNativeDriver: false, bounciness: 0, speed: 18 }).start();
  }
}

/** A drawer's controls: its height (for things that sit above it) and its state. */
export function useDrawer(closedH: number, openH: number) {
  const [open, setOpen] = useState(kept.open);
  const [motion] = useState(() => new DrawerMotion(closedH, openH, setOpen));
  useEffect(() => motion.sizes(closedH, openH), [motion, closedH, openH]);
  return { motion, open, toggle: () => motion.snap(!open) };
}

/**
 * A panel pulled up from the bottom of a screen over a map: a handle with a
 * header that's always there, and the rest when it's open. Drag the handle,
 * or tap the header, to open or close it.
 */
export function Drawer({ drawer, header, children }: { drawer: ReturnType<typeof useDrawer>; header: ReactNode; children: ReactNode }) {
  const t = useTheme();
  return (
    <Animated.View
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: drawer.motion.height,
        backgroundColor: t.surface,
        borderTopLeftRadius: 22,
        borderTopRightRadius: 22,
        shadowColor: '#000',
        shadowOpacity: 0.15,
        shadowRadius: 12,
        elevation: 8,
        overflow: 'hidden',
      }}
    >
      <View {...drawer.motion.pan.panHandlers}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: drawer.open }}
          accessibilityHint={drawer.open ? 'Closes the list, to see more of the map' : 'Opens the list'}
          onPress={drawer.toggle}
          hitSlop={4}
          style={{ alignItems: 'center', paddingTop: 8, paddingBottom: 4 }}
        >
          <View style={{ width: 44, height: 5, borderRadius: 3, backgroundColor: t.line }} />
        </Pressable>
        {header}
      </View>
      <View style={{ flex: 1 }}>{children}</View>
    </Animated.View>
  );
}
