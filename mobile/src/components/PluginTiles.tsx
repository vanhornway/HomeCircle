import { useEffect, useState } from 'react';
import { Animated, PanResponder, Pressable, View } from 'react-native';
import type { CircleClient } from '@homecircle/core';
import { usePlaceName } from '../lib/weather';
import { useTheme } from '../theme';
import { AirFace } from './AirTile';
import { PrayerFace } from './PrayerTile';
import { WeatherFace } from './WeatherTile';

// Every tile is the same size: small on the map, so it hides little of it;
// double-tapped, bigger with the next hours.
const SMALL = { scale: 0.8, width: 140, height: 142 };
const BIG = { scale: 1.1, width: 290, height: 336 };
// The card lets the map show through (#RRGGBB + alpha).
const see = (hex: string) => `${hex}B8`;
const DOUBLE_TAP_MS = 320;
const SWIPE_PX = 36;

const FACES = [
  { id: 'weather', name: 'Weather', Face: WeatherFace },
  { id: 'air', name: 'Air and pollen', Face: AirFace },
  { id: 'prayer', name: 'Prayer times', Face: PrayerFace },
] as const;

// Which tile and size you left it at, while the app is open.
const kept = { index: 0, big: false };
const keep = (index: number, big: boolean) => Object.assign(kept, { index, big });

/** Sideways swipes between tiles (made once per card; it's told how many tiles and how wide). */
class Swipe {
  x = new Animated.Value(0);
  private count = 0;
  private width = 0;
  private lastTap = 0;
  constructor(private turn: (dir: 1 | -1, count: number) => void) {}
  pan = PanResponder.create({
    // Sideways only, so taps and the map's own drags are left alone.
    onMoveShouldSetPanResponderCapture: (_, g) => this.count > 1 && Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
    onPanResponderMove: (_, g) => this.x.setValue(g.dx),
    onPanResponderRelease: (_, g) => {
      if (g.dx < -SWIPE_PX || g.vx < -0.5) this.step(1);
      else if (g.dx > SWIPE_PX || g.vx > 0.5) this.step(-1);
      else this.back();
    },
    onPanResponderTerminate: () => this.back(),
  });
  size(count: number, width: number) {
    this.count = count;
    this.width = width;
  }
  /** The tile slides out one side, the next one in from the other. */
  step(dir: 1 | -1) {
    if (this.count < 2) return;
    Animated.timing(this.x, { toValue: -dir * this.width, duration: 140, useNativeDriver: false }).start(() => {
      this.turn(dir, this.count);
      this.x.setValue(dir * this.width);
      Animated.timing(this.x, { toValue: 0, duration: 170, useNativeDriver: false }).start();
    });
  }
  back() {
    Animated.spring(this.x, { toValue: 0, useNativeDriver: false }).start();
  }
  /** True on the second of two quick taps. */
  doubleTap() {
    const now = Date.now();
    const yes = now - this.lastTap < DOUBLE_TAP_MS;
    this.lastTap = yes ? 0 : now;
    return yes;
  }
}

/**
 * The plugins' tiles in the map's top-right corner, for the selected person
 * (or you): weather, air and pollen, prayer times, one at a time in the same card. Swipe
 * for the next one; double-tap for the bigger view, and again to make it small.
 */
export function PluginTiles({ client, memberId }: { client: CircleClient; memberId: string | null }) {
  const t = useTheme();
  const faces = FACES.filter((f) => client.feature(f.id));
  const [index, setIndex] = useState(kept.index);
  const [big, setBig] = useState(kept.big);
  const [swipe] = useState(() => new Swipe((dir, count) => setIndex((i) => (i + dir + count) % count)));
  const me = client.account?.memberId ?? null;
  const id = memberId ?? me;
  const loc = id ? client.locations.get(id) : undefined;
  const who = id && id !== me ? client.members.get(id)?.name : null;
  const place = usePlaceName(client, loc);
  const size = big ? BIG : SMALL;
  useEffect(() => swipe.size(faces.length, size.width), [swipe, faces.length, size.width]);
  useEffect(() => {
    keep(index, big);
  }, [index, big]);

  if (!faces.length || !loc) return null;
  const at = Math.min(index, faces.length - 1);
  const { Face, name } = faces[at];
  const z = (n: number) => Math.round(n * size.scale);
  const title = [who, place].filter(Boolean).join(' · ') || name;
  const toggle = () => setBig((v) => !v);
  const turn = (dir: 1 | -1) => setIndex((i) => (i + dir + faces.length) % faces.length);

  return (
    <View
      {...swipe.pan.panHandlers}
      style={{ width: size.width, height: size.height, borderRadius: z(22), overflow: 'hidden', backgroundColor: see(t.surface), borderWidth: 1, borderColor: see(t.line) }}
    >
      <Pressable
        accessibilityRole="adjustable"
        accessibilityState={{ expanded: big }}
        accessibilityHint={`Double-tap to ${big ? 'make it smaller' : 'show more'}.${faces.length > 1 ? ' Swipe up or down for the next tile.' : ''}`}
        accessibilityActions={[{ name: 'activate' }, { name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === 'activate') toggle();
          else turn(e.nativeEvent.actionName === 'increment' ? 1 : -1);
        }}
        onPress={() => swipe.doubleTap() && toggle()}
        style={{ flex: 1 }}
      >
        <Animated.View style={{ flex: 1, padding: z(8), paddingBottom: faces.length > 1 ? z(8) + 8 : z(8), transform: [{ translateX: swipe.x }] }}>
          <Face client={client} loc={loc} title={title} big={big} z={z} />
        </Animated.View>
        {faces.length > 1 ? (
          <View pointerEvents="none" style={{ position: 'absolute', bottom: 5, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 5 }}>
            {faces.map((f, i) => (
              <View key={f.id} style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: i === at ? t.text : t.muted, opacity: i === at ? 0.9 : 0.4 }} />
            ))}
          </View>
        ) : null}
      </Pressable>
    </View>
  );
}
